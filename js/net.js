/* HoloRec signaling: MQTT-over-WSS rendezvous (broker list walked in the
 * SAME order on both sides — the HoloMapper lesson: racing brokers lands
 * the two peers on different brokers and they never meet), then a plain
 * RTCPeerConnection, STUN only, desktop -> phone, audio track only. */
export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

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
export class Peer {
  constructor(role, sendSignal, cbs) {
    this.role = role; this.sendSignal = sendSignal; this.cbs = cbs || {};
    this.pc = new RTCPeerConnection(RTC_CFG);
    this.statsTimer = null;
    this.pc.onicecandidate = (e) => { if (e.candidate) this.sendSignal({ type: 'ice', candidate: e.candidate.toJSON() }); };
    this.pc.ontrack = (e) => { if (this.cbs.onRemoteStream) this.cbs.onRemoteStream(e.streams[0] || new MediaStream([e.track])); };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (this.cbs.onState) {
        if (s === 'connected') { this.cbs.onState('LIVE'); this.startStats(); }
        else if (s === 'connecting' || s === 'new') this.cbs.onState('CONNECTING');
        else if (s === 'failed') this.cbs.onState('FAILED — peer connection failed (NAT/UDP blocked?). Same-WiFi helps; some networks need a TURN server, which v1 does not use.');
        else if (s === 'disconnected') this.cbs.onState('FAILED — peer disconnected');
        else if (s === 'closed') this.cbs.onState('FAILED — connection closed');
      }
    };
  }
  addAudioTrack(track, stream) { this.pc.addTrack(track, stream); }
  async makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ type: 'offer', sdp: this.pc.localDescription });
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
        await this.pc.addIceCandidate(msg.candidate);
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
