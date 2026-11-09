/* HoloRec signaling: MQTT-over-WSS rendezvous (broker list walked in the
 * SAME order on both sides — the HoloMapper lesson: racing brokers lands
 * the two peers on different brokers and they never meet), then a plain
 * RTCPeerConnection, STUN + TURN relay fallback, desktop -> phone, audio
 * track only. */
export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
/* Build 2: STUN + TURN. Build 1 was STUN-only and died on Joshua's real
 * network ("FAILED — peer connection failed (NAT/UDP blocked?)"). TURN
 * relays the audio when no direct path exists; the TCP/TLS 443 entries also
 * survive networks (and Brave's stricter WebRTC policy) that block UDP.
 * Relay carries tiny Opus audio only, so the free Open Relay allowance is
 * ample. Direct paths are still preferred — TURN is only used if ICE can't
 * connect directly. */
export const RTC_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

export function topicFor(code) { return 'holorec/v1/' + code + '/sig'; }

/* Connect mqtt.js to the first broker that answers, trying in list order.
 * Resolves {client, broker} or rejects after all brokers fail. */
export function connectMqtt(code, role, onSignal, onState) {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= BROKERS.length) { reject(new Error('No signaling broker reachable — check WiFi/internet and retry.')); return; }
      const url = BROKERS[idx++];
      onState && onState('signaling: trying ' + new URL(url).host);
      let client;
      try {
        client = window.mqtt.connect(url, {
          clientId: 'holorec-' + role + '-' + code + '-' + Math.random().toString(36).slice(2, 9),
          connectTimeout: 8000, reconnectPeriod: 0, clean: true,
        });
      } catch (e) { tryNext(); return; }
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; try { client.end(true); } catch (e) {} tryNext(); } }, 9000);
      client.on('connect', () => {
        if (settled) return; settled = true; clearTimeout(timer);
        client.subscribe(topicFor(code), (err) => {
          if (err) { try { client.end(true); } catch (e) {} tryNext(); return; }
          onState && onState('signaling: connected via ' + new URL(url).host);
          resolve({ client, broker: url });
        });
      });
      client.on('message', (topic, payload) => {
        let msg; try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
        if (!msg || msg.from === role) return;
        onSignal && onSignal(msg);
      });
      client.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); try { client.end(true); } catch (e) {} tryNext(); } });
    };
    tryNext();
  });
}

export function publishSignal(mqttConn, role, msg) {
  if (!mqttConn || !mqttConn.client) return;
  try { mqttConn.client.publish(mqttConn.topic || topicFor(mqttConn.code), JSON.stringify({ ...msg, from: role })); } catch (e) {}
}

/* RTC wrapper. role 'desktop' = offerer/sender, 'phone' = answerer/receiver.
 * Callbacks: onState(text), onRemoteStream(stream), onStats({rttMs, jitterMs}) */
function candType(candStr) {
  const m = / typ ([a-z]+)/.exec(candStr || '');
  return m ? m[1] : 'other';
}

export class Peer {
  constructor(role, sendSignal, cbs) {
    this.role = role; this.sendSignal = sendSignal; this.cbs = cbs || {};
    this.pc = new RTCPeerConnection(RTC_CFG);
    this.statsTimer = null;
    this.restartAttempts = 0;
    this.maxRestarts = 3;
    this.localCands = {}; this.remoteCands = {};
    this.everLive = false;
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        const t = candType(e.candidate.candidate);
        this.localCands[t] = (this.localCands[t] || 0) + 1;
        this.sendSignal({ type: 'ice', candidate: e.candidate.toJSON() });
      }
    };
    this.pc.ontrack = (e) => { if (this.cbs.onRemoteStream) this.cbs.onRemoteStream(e.streams[0] || new MediaStream([e.track])); };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (!this.cbs.onState) return;
      if (s === 'connected') { this.everLive = true; this.restartAttempts = 0; this.cbs.onState('LIVE'); this.startStats(); }
      else if (s === 'connecting' || s === 'new') this.cbs.onState('CONNECTING');
      else if (s === 'disconnected') this.cbs.onState('RECONNECTING — link dropped, trying to recover…');
      else if (s === 'closed') this.cbs.onState('FAILED — connection closed. ' + this.diagText());
      else if (s === 'failed') this.handleIceFailure();
    };
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'failed') this.handleIceFailure();
    };
  }
  /* Which candidate kinds each side actually produced — baked into the
   * FAILED line so a screenshot alone tells the next debugging step:
   * relay=0 on both sides = TURN unreachable too; srflx=0 on the phone =
   * the browser is hiding its addresses (e.g. Brave WebRTC policy/VPN). */
  diagText() {
    const fmt = (o) => Object.keys(o).sort().map((k) => k + '×' + o[k]).join(' ') || 'none';
    return '[ICE — this side: ' + fmt(this.localCands) + ' · other side: ' + fmt(this.remoteCands) + ']';
  }
  handleIceFailure() {
    if (this._restarting) return;
    if (this.restartAttempts < this.maxRestarts) {
      this.restartAttempts++;
      if (this.cbs.onState) this.cbs.onState('RECONNECTING — connection failed, retry ' + this.restartAttempts + '/' + this.maxRestarts + ' (relay + direct)…');
      this._restarting = true;
      setTimeout(() => { this._restarting = false; }, 4000);
      if (this.role === 'desktop') this.makeOffer({ iceRestart: true });
      else this.sendSignal({ type: 'need-restart' });
    } else if (this.cbs.onState) {
      this.cbs.onState('FAILED — peer connection failed after ' + this.maxRestarts + ' retries. ' + this.diagText() + ' Try: phone + desktop on the same WiFi, and on the phone use Chrome (Brave\'s WebRTC privacy policy can block the direct path).');
    }
  }
  addAudioTrack(track, stream) { this.pc.addTrack(track, stream); }
  async makeOffer(opts) {
    try {
      const offer = await this.pc.createOffer(opts || undefined);
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ type: 'offer', sdp: this.pc.localDescription });
    } catch (e) { /* a restart racing a state change is normal */ }
  }
  async handleSignal(msg) {
    try {
      if (msg.type === 'offer' && this.role === 'phone') {
        await this.pc.setRemoteDescription(msg.sdp);
        const ans = await this.pc.createAnswer();
        await this.pc.setLocalDescription(ans);
        this.sendSignal({ type: 'answer', sdp: this.pc.localDescription });
      } else if (msg.type === 'answer' && this.role === 'desktop') {
        await this.pc.setRemoteDescription(msg.sdp);
      } else if (msg.type === 'ice' && msg.candidate) {
        const t = candType(msg.candidate.candidate);
        this.remoteCands[t] = (this.remoteCands[t] || 0) + 1;
        await this.pc.addIceCandidate(msg.candidate);
      } else if (msg.type === 'need-restart' && this.role === 'desktop') {
        this.makeOffer({ iceRestart: true });
      } else if (msg.type === 'hello' && this.role === 'desktop') {
        if (this.cbs.onPeerHello) this.cbs.onPeerHello();
      }
    } catch (e) { /* late/duplicate signals are normal during setup */ }
  }
  startStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(async () => {
      try {
        const stats = await this.pc.getStats();
        let rttMs = null, jitterBufferMs = null;
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') rttMs = Math.round(r.currentRoundTripTime * 1000);
          if (r.type === 'remote-inbound-rtp' && typeof r.roundTripTime === 'number') rttMs = Math.round(r.roundTripTime * 1000);
          if (r.type === 'inbound-rtp' && typeof r.jitterBufferDelay === 'number' && r.jitterBufferEmittedCount) {
            jitterBufferMs = Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000);
          }
        });
        if (this.cbs.onStats) this.cbs.onStats({ rttMs, jitterBufferMs });
      } catch (e) {}
    }, 1000);
  }
  close() { if (this.statsTimer) clearInterval(this.statsTimer); try { this.pc.close(); } catch (e) {} }
}
