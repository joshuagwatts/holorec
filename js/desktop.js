import { connectMqtt, Peer } from './net.js?v=4';
import { MeterStrip } from './meters.js?v=4';

const $ = (id) => document.getElementById(id);
const state = {
  mode: 'desktop', code: null, audioStream: null, audioCtx: null,
  mqtt: null, peer: null, connState: 'idle', meterLevel: 0, broker: null,
};
window.__HOLOREC__ = window.__HOLOREC__ || {};
window.__HOLOREC__.state = state;
window.__HOLOREC__.desktop = { startCaptureDisplay, startCaptureDevice, refreshDevices };

function setConn(text, live) {
  state.connState = text;
  const el = $('d-conn'); el.textContent = text;
  el.className = 'conn ' + (live ? 'live' : text.startsWith('FAILED') ? 'fail' : '');
}
function setAudioStatus(t) { $('d-audio-status').textContent = t; }

async function refreshDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const sel = $('d-device');
    sel.innerHTML = '';
    devs.filter((d) => d.kind === 'audioinput').forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || ('Audio input ' + (i + 1));
      sel.appendChild(o);
    });
    if (!sel.options.length) { const o = document.createElement('option'); o.textContent = 'No audio inputs found'; sel.appendChild(o); }
  } catch (e) { setAudioStatus('Device list failed: ' + e.message); }
}

let meter = null, meterTimer = null;
function wireMeter(stream) {
  if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  const src = state.audioCtx.createMediaStreamSource(stream);
  meter = new MeterStrip(); meter.attach(state.audioCtx, src);
  if (meterTimer) clearInterval(meterTimer);
  meterTimer = setInterval(() => {
    meter.sample(); state.meterLevel = meter.level01();
    $('d-meter-fill').style.width = Math.round(state.meterLevel * 100) + '%';
    $('d-meter-fill').style.background = state.meterLevel > 0.85 ? '#ff5252' : '#37d67a';
  }, 80);
}

async function startCaptureDisplay() {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    s.getVideoTracks().forEach((t) => { t.stop(); s.removeTrack(t); }); /* audio only */
    if (!s.getAudioTracks().length) { setAudioStatus('That share had NO audio track — re-share and tick "Share audio" / pick system audio.'); return; }
    adoptStream(s, 'System/tab audio capture');
  } catch (e) { setAudioStatus('Display capture cancelled/failed: ' + e.message); }
}
async function startCaptureDevice() {
  try {
    const id = $('d-device').value;
    const s = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : { echoCancellation: false } });
    adoptStream(s, 'Audio input device');
    refreshDevices(); /* labels unlock after permission */
  } catch (e) { setAudioStatus('Input capture failed: ' + e.message); }
}
function adoptStream(s, label) {
  if (state.audioStream) state.audioStream.getTracks().forEach((t) => t.stop());
  state.audioStream = s;
  setAudioStatus(label + ' live — ' + s.getAudioTracks().length + ' audio track(s). Play Ableton and watch the meter.');
  wireMeter(s);
  offerToPhone();
  updateGo();
}
function updateGo() { $('d-go').disabled = !(state.audioStream && state.code); }

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = ''; for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function phoneUrl(code) {
  const u = new URL(location.href.split('?')[0].split('#')[0]);
  u.search = '?room=' + code + '&mode=phone';
  return u.toString();
}
function renderQr(url) {
  const box = $('d-qr'); box.innerHTML = '';
  try {
    const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 7, margin: 12, scalable: true });
  } catch (e) { box.textContent = url; }
}

export async function initDesktop(preselectedCode) {
  document.querySelectorAll('main').forEach((m) => { m.style.display = 'none'; });
  $('desktop').style.display = '';
  state.code = preselectedCode || makeCode();
  $('d-code').textContent = state.code;
  renderQr(phoneUrl(state.code));
  $('d-phone-url').textContent = phoneUrl(state.code);
  refreshDevices();
  updateGo();
  $('d-cap-display').onclick = startCaptureDisplay;
  $('d-cap-device').onclick = startCaptureDevice;
  $('d-refresh-devices').onclick = refreshDevices;
  $('d-go').onclick = startSignaling;
  setConn('Not connected — pick an audio source, then Start link.');
}

async function offerToPhone() {
  if (!state.peer || !state.audioStream) return;
  /* Build-2 fix: build 1 set a one-shot _offered flag, so if the first
   * offer was published before the phone had subscribed (MQTT keeps
   * nothing for late joiners), every later hello was ignored and the pair
   * never met. The TRACK is added once; the OFFER can be re-sent whenever
   * the phone (re)announces itself and we are not LIVE yet. */
  if (!state._trackAdded) {
    state._trackAdded = true;
    const t = state.audioStream.getAudioTracks()[0];
    state.peer.addAudioTrack(t, state.audioStream);
  }
  if (state._live) return;
  await state.peer.makeOffer();
}

async function startSignaling() {
  if (state.mqtt) return;
  setConn('CONNECTING — signaling…');
  const send = (msg) => { if (state.mqtt) state.mqtt.client.publish('holorec/v1/' + state.code + '/sig', JSON.stringify({ ...msg, from: 'desktop' })); };
  try {
    state.mqtt = await connectMqtt(state.code, 'desktop', (msg) => { if (state.peer) state.peer.handleSignal(msg); }, (t) => setConn('CONNECTING — ' + t));
    state.mqtt.code = state.code;
    state.broker = state.mqtt.broker;
  } catch (e) { setConn('FAILED — ' + e.message); return; }
  state.peer = new Peer('desktop', send, {
    onState: (t) => {
      state._live = t === 'LIVE';
      if (t === 'LIVE') setConn('LIVE — streaming Ableton audio to the phone', true);
      else if (t === 'CONNECTING') setConn('CONNECTING — peer linking… (phone joined, ICE in progress)');
      else setConn(t);
    },
    onStats: ({ rttMs }) => { if (rttMs != null) setConn('LIVE — streaming Ableton audio to the phone · latency ~' + rttMs + ' ms', true); },
    onPeerHello: () => {},
  });
  /* Phone announces itself with 'hello'; (re)offer when it does, and now if audio is ready. */
  const origHandle = state.peer.handleSignal.bind(state.peer);
  state.peer.handleSignal = async (msg) => {
    if (msg.type === 'hello') { await offerToPhone(); return; }
    return origHandle(msg);
  };
  send({ type: 'desktop-here' });
  /* Announce on a heartbeat until LIVE — a phone that joins after this
   * first message would otherwise never know the desktop is here. */
  const hereTimer = setInterval(() => {
    if (state._live) { clearInterval(hereTimer); return; }
    send({ type: 'desktop-here' });
  }, 4000);
  setConn('CONNECTING — waiting for the phone to scan/join room ' + state.code + '…');
  await offerToPhone();
}
