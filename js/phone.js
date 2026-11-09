import { connectMqtt, Peer } from './net.js?v=4';
import { MeterStrip } from './meters.js?v=4';

const $ = (id) => document.getElementById(id);
const state = {
  mode: 'phone', code: null, connState: 'idle', mqtt: null, broker: null,
  camStream: null, camTrack: null, facing: 'environment', deviceId: null,
  actualRes: '', zoom: 1, zoomNative: false, torchOn: false, mirror: false,
  res: { w: 1920, h: 1080 }, stripLayout: 'bottom', remoteStream: null,
  syncOffsetMs: 0, autoOffsetMs: null, rttMs: null, monitorOn: false,
  recording: false, recSeconds: 0, mimeType: '', lastBlob: null, lastUrl: '',
  meterEnergy: 0, canvasW: 0, canvasH: 0, audioReady: false,
};
window.__HOLOREC__ = window.__HOLOREC__ || {};
window.__HOLOREC__.state = state;

/* ---- on-device diagnostics (build 3) -----------------------------------
 * His phone is the only ground truth for the camera failure, and build 2's
 * fix didn't land — so build 3 changes NO camera behavior; it records what
 * actually happens on his hardware: every getUserMedia attempt + its exact
 * error, the adopted track's settings, mute/end events, and whether the
 * preview element's frames actually advance. One screenshot of this log
 * names the cause instead of another round of guessing. */
const diagLines = [];
function diagLog(msg) {
  const t = new Date();
  const line = t.toTimeString().slice(0, 8) + ' ' + msg;
  diagLines.push(line);
  state.diagText = diagLines.join('\n');
  const el = document.getElementById('p-diag');
  if (el) el.textContent = state.diagText;
}
function shortJson(o) {
  return JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 14 ? v.slice(0, 8) + '…' : v)).slice(0, 220);
}
window.__HOLOREC__.diagLog = diagLog;

let actx = null, remoteSrc = null, delayNode = null, monitorGain = null, recDest = null;
let meters = null, canvas = null, gtx = null, raf = 0;
const video = document.createElement('video');
video.playsInline = true; video.muted = true; video.autoplay = true;
/* frame-delay ring for negative sync offsets (delay the VIDEO) */
let frameQueue = [];
const framePool = [];
function getPooledCanvas(w, h) {
  const c = framePool.pop() || document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

function ensureAudioGraph() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  delayNode = actx.createDelay(1.0);
  delayNode.delayTime.value = Math.max(0, state.syncOffsetMs) / 1000;
  monitorGain = actx.createGain(); monitorGain.gain.value = 0; /* default OFF — feedback */
  recDest = actx.createMediaStreamDestination();
  delayNode.connect(recDest);
  delayNode.connect(monitorGain); monitorGain.connect(actx.destination);
  meters = new MeterStrip();
}
function adoptRemoteStream(stream, source) {
  ensureAudioGraph();
  if (actx.state === 'suspended') actx.resume();
  state.remoteStream = stream;
  if (remoteSrc) { try { remoteSrc.disconnect(); } catch (e) {} }
  remoteSrc = actx.createMediaStreamSource(stream);
  remoteSrc.connect(delayNode);
  meters.attach(actx, remoteSrc);
  state.audioReady = true;
  if (source === 'wired') {
    /* Build 4 (Joshua's ask): Ableton's audio arrives by CABLE — the phone
     * takes its own wired mic/USB input as the Ableton feed. No network,
     * no pairing, no WebRTC: the stream is local, so it is live the moment
     * it is captured, and the note can say so plainly. */
    state.audioSource = 'wired';
    $('p-audio-note').textContent = 'Wired input live — audio arriving by cable will be baked into the recording.';
    return;
  }
  state.audioSource = 'link';
  setConn(state.connState === 'LIVE' ? 'LIVE' : state.connState, state.connState === 'LIVE');
  /* Build-2 honesty fix: ontrack fires when the track is ANNOUNCED, before
   * any audio actually flows — build 1 said "connected" here while the peer
   * was failing, which is exactly the contradiction in Joshua's screenshot.
   * Only the LIVE state earns the word "connected". */
  $('p-audio-note').textContent = state.connState === 'LIVE'
    ? 'Ableton audio connected — it will be baked into the recording.'
    : 'Ableton audio track received — connecting the stream…';
  pollStatsForAutoOffset();
}

/* ---------------- wired audio input (build 4) ---------------- */
async function refreshAudioDevices() {
  const sel = $('p-audio-dev');
  if (!sel) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const ins = devs.filter((d) => d.kind === 'audioinput');
    const cur = sel.value;
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'Default input (phone mic / plugged-in USB)';
    sel.appendChild(def);
    ins.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || ('Audio input ' + (i + 1));
      sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  } catch (e) {}
}
async function startWiredAudio() {
  const sel = $('p-audio-dev');
  const id = sel ? sel.value : '';
  const audio = id
    ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio });
    if (state.wiredStream) state.wiredStream.getTracks().forEach((t) => t.stop());
    state.wiredStream = s;
    diagLog('wired audio started: "' + (s.getAudioTracks()[0] ? s.getAudioTracks()[0].label : '?') + '"');
    adoptRemoteStream(s, 'wired');
    refreshAudioDevices();
  } catch (e) {
    diagLog('wired audio FAIL ' + e.name + ': ' + e.message);
    $('p-audio-note').textContent = 'Wired input failed: ' + e.message + ' — check the cable/dongle is plugged in, then tap again.';
  }
}
window.__HOLOREC__.startWiredAudio = startWiredAudio;
/* Auto sync estimate: audio's jitter-buffer delay means the audio lags the
 * local camera by roughly that much; pre-set the offset slider negative
 * (delay video) by that amount, user can still override. */
let statsPoll = null;
function pollStatsForAutoOffset() {
  if (statsPoll || !state.peerRef) return;
  statsPoll = setInterval(async () => {
    const pc = state.peerRef && state.peerRef.pc;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && typeof r.jitterBufferDelay === 'number' && r.jitterBufferEmittedCount) {
          const ms = Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000);
          if (ms > 0 && state.autoOffsetMs === null) {
            state.autoOffsetMs = ms;
            setSyncOffset(-ms, true);
            $('p-sync-note').textContent = 'Auto sync estimate: audio lags ~' + ms + ' ms (jitter buffer) — offset pre-set to ' + state.syncOffsetMs + ' ms. Fine-tune by ear.';
          }
        }
      });
    } catch (e) {}
  }, 1500);
}
function setSyncOffset(ms, fromAuto) {
  state.syncOffsetMs = Math.max(-500, Math.min(500, Math.round(ms)));
  if (delayNode) delayNode.delayTime.value = Math.max(0, state.syncOffsetMs) / 1000;
  const s = $('p-sync'); if (s) s.value = state.syncOffsetMs;
  $('p-sync-val').textContent = state.syncOffsetMs + ' ms';
  if (!fromAuto) $('p-sync-note').textContent = state.syncOffsetMs >= 0 ? 'Audio delayed by ' + state.syncOffsetMs + ' ms in the recording.' : 'Video delayed by ' + (-state.syncOffsetMs) + ' ms in the recording (audio stays live).';
}
function setConn(text, live) {
  state.connState = text;
  const el = $('p-conn'); el.textContent = text;
  el.className = 'conn ' + (live ? 'live' : String(text).startsWith('FAILED') ? 'fail' : '');
}

/* ---------------- camera ----------------
 * Build-2 fix for the real-phone failure in Joshua's screenshot: the first
 * camera started (1080x1920 @60fps), then a restart (lens / flip / res tap)
 * died with "Could not start video source". Three causes, all fixed here:
 *  1. The old track was still OPEN while the new camera was requested —
 *     Android refuses a second camera while the first is held. Stop first.
 *  2. Parallel startCamera() calls raced (auto-start + Start button + lens
 *     taps). Calls are now serialized; a tap during a start just re-runs
 *     once with the latest settings.
 *  3. No frameRate cap — the phone picked 60fps, which several lenses
 *     (esp. front / secondary) can't actually start. The canvas records at
 *     30fps anyway, so cap at 30. And a failed pick now falls down a ladder
 *     (requested -> 720p -> any camera) instead of leaving a black screen. */
let camStartInFlight = false, camStartQueued = false;
async function startCamera() {
  if (camStartInFlight) { camStartQueued = true; return; }
  camStartInFlight = true;
  try {
    await startCameraOnce();
  } finally {
    camStartInFlight = false;
    if (camStartQueued) { camStartQueued = false; startCamera(); }
  }
}
async function startCameraOnce() {
  const target = state.deviceId
    ? { deviceId: { exact: state.deviceId } }
    : { facingMode: state.facing };
  const ladder = [
    { ...target, width: { ideal: state.res.w }, height: { ideal: state.res.h }, frameRate: { ideal: 30, max: 30 } },
    { ...target, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
    state.deviceId ? { deviceId: { ideal: state.deviceId }, frameRate: { ideal: 30 } } : { facingMode: { ideal: state.facing }, frameRate: { ideal: 30 } },
    true,
  ];
  let lastErr = null;
  diagLog('camera start: facing=' + state.facing + ' deviceId=' + (state.deviceId ? state.deviceId.slice(0, 8) + '…' : 'none') + ' want=' + state.res.w + 'x' + state.res.h);
  for (let ai = 0; ai < ladder.length; ai++) {
    const vc = ladder[ai];
    /* Stop the current camera BEFORE opening the next one — holding the
     * old track open is what made lens/flip switches fail on Android. */
    if (state.camStream) {
      state.camStream.getTracks().forEach((t) => t.stop());
      state.camStream = null; state.camTrack = null; video.srcObject = null;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: vc });
      const t0 = s.getVideoTracks()[0];
      const st0 = t0 && t0.getSettings ? t0.getSettings() : {};
      diagLog('attempt ' + (ai + 1) + ' OK: ' + (st0.width || '?') + 'x' + (st0.height || '?') + '@' + Math.round(st0.frameRate || 0) + ' label="' + (t0 ? t0.label : '') + '"');
      adoptCamera(s);
      $('p-cam-note').textContent = '';
      const btn = $('p-start-cam'); if (btn) btn.style.display = 'none';
      return;
    } catch (e) {
      lastErr = e;
      diagLog('attempt ' + (ai + 1) + ' FAIL [' + shortJson(vc) + '] ' + e.name + ': ' + e.message + (e.constraint ? ' constraint=' + e.constraint : ''));
    }
  }
  diagLog('camera start: ALL attempts failed');
  $('p-cam-note').textContent = 'Camera failed: ' + (lastErr ? lastErr.message : 'unknown error') + ' — close any other app using the camera, then tap Start camera.';
  const btn = $('p-start-cam'); if (btn) btn.style.display = '';
}
function adoptCamera(s) {
  if (state.camStream) state.camStream.getTracks().forEach((t) => t.stop());
  state.camStream = s; video.srcObject = s;
  state.camTrack = s.getVideoTracks()[0];
  const st = state.camTrack.getSettings ? state.camTrack.getSettings() : {};
  state.actualRes = (st.width || '?') + '×' + (st.height || '?');
  $('p-actual-res').textContent = 'Actual camera: ' + state.actualRes + (st.frameRate ? ' @' + Math.round(st.frameRate) + 'fps' : '');
  /* Playback check: a live track with a frozen preview element is a
   * different bug from a track that never starts — log which one it is. */
  const trk = state.camTrack;
  trk.onmute = () => diagLog('track event: MUTED');
  trk.onunmute = () => diagLog('track event: unmuted');
  trk.onended = () => diagLog('track event: ENDED');
  const tAtAdopt = video.currentTime;
  setTimeout(() => {
    diagLog('playback check: readyState=' + video.readyState + ' paused=' + video.paused + ' videoSize=' + video.videoWidth + 'x' + video.videoHeight + ' trackReady=' + trk.readyState + ' trackMuted=' + trk.muted + ' framesAdvancing=' + (video.currentTime > tAtAdopt));
  }, 1800);
  refreshLensButtons();
  applyNativeZoomCaps();
}
function applyNativeZoomCaps() {
  const caps = state.camTrack && state.camTrack.getCapabilities ? state.camTrack.getCapabilities() : {};
  state._zoomCaps = caps.zoom || null;
  const has = !!(caps.zoom && caps.zoom.max > caps.zoom.min);
  $('p-zoom-note').textContent = has ? 'Native zoom available (' + caps.zoom.min + '–' + caps.zoom.max + '×)' : 'No native zoom on this lens — digital crop-zoom is used.';
  $('p-torch').style.display = caps.torch ? '' : 'none';
}
async function setZoom(z) {
  state.zoom = Math.max(1, Math.min(5, z));
  $('p-zoom').value = state.zoom; $('p-zoom-val').textContent = state.zoom.toFixed(1) + '×';
  state.zoomNative = false;
  if (state._zoomCaps && state.camTrack) {
    try { await state.camTrack.applyConstraints({ advanced: [{ zoom: Math.min(state._zoomCaps.max, Math.max(state._zoomCaps.min, state.zoom)) }] }); state.zoomNative = true; } catch (e) {}
  }
}
async function toggleTorch() {
  if (!state.camTrack) return;
  state.torchOn = !state.torchOn;
  try { await state.camTrack.applyConstraints({ advanced: [{ torch: state.torchOn }] }); $('p-torch').textContent = state.torchOn ? '🔦 Torch ON' : '🔦 Torch'; }
  catch (e) { state.torchOn = !state.torchOn; $('p-cam-note').textContent = 'Torch not supported on this lens/device.'; }
}
async function refreshLensButtons() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const vids = devs.filter((d) => d.kind === 'videoinput');
    diagLog('videoinputs (' + vids.length + '): ' + vids.map((d, i) => i + ':"' + (d.label || '?') + '"').join(' | '));
    const box = $('p-lenses'); box.innerHTML = '';
    vids.forEach((d, i) => {
      const label = (d.label || '').toLowerCase();
      let name = d.label || ('Lens ' + (i + 1));
      if (/ultra|0\.5/.test(label)) name = 'Ultrawide · ' + name;
      else if (/tele|zoom|[2-9]x/.test(label)) name = 'Tele · ' + name;
      else if (/wide|back|rear/.test(label)) name = 'Wide · ' + name;
      else if (/front|user/.test(label)) name = 'Front · ' + name;
      const b = document.createElement('button');
      b.textContent = name; b.className = 'chip' + (state.camTrack && state.camTrack.getSettings && state.camTrack.getSettings().deviceId === d.deviceId ? ' on' : '');
      b.onclick = () => { state.deviceId = d.deviceId; state.facing = /front|user/.test(label) ? 'user' : 'environment'; startCamera(); };
      box.appendChild(b);
    });
    if (!vids.length) box.innerHTML = '<span class="hint">Lens list appears after camera permission.</span>';
  } catch (e) {}
}

/* Clean-room camera probe: bare getUserMedia calls with NO app
 * constraints, one facing at a time, app camera stopped first. Separates
 * "this browser/device won't hand over a camera at all" from "the app's
 * picks are the problem" in a single tap. */
async function runProbe() {
  diagLog('— PROBE start (app camera stopped) —');
  if (state.camStream) {
    state.camStream.getTracks().forEach((t) => t.stop());
    state.camStream = null; state.camTrack = null; video.srcObject = null;
  }
  const tries = [
    ['any camera {video:true}', { video: true }],
    ['rear {facingMode:environment}', { video: { facingMode: 'environment' } }],
    ['front {facingMode:user}', { video: { facingMode: 'user' } }],
    ['any camera 720p max30', { video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { max: 30 } } }],
  ];
  for (const [name, c] of tries) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(c);
      const t = s.getVideoTracks()[0];
      const st = t.getSettings ? t.getSettings() : {};
      diagLog('probe ' + name + ': OK ' + (st.width || '?') + 'x' + (st.height || '?') + '@' + Math.round(st.frameRate || 0) + ' label="' + t.label + '"');
      s.getTracks().forEach((x) => x.stop());
    } catch (e) {
      diagLog('probe ' + name + ': FAIL ' + e.name + ': ' + e.message);
    }
  }
  diagLog('— PROBE end, restarting app camera —');
  startCamera();
}
window.__HOLOREC__.runProbe = runProbe;

/* ---------------- composite canvas + recording ---------------- */
function layoutDims() {
  const vw = state.res.w, vh = state.res.h;
  const stripH = state.stripLayout === 'off' || state.stripLayout === 'overlay' ? 0 : Math.round(vh * 0.16);
  return { vw, vh, stripH, W: vw, H: vh + stripH };
}
function drawFrame() {
  if (!canvas) return;
  const { vw, vh, stripH, W, H } = layoutDims();
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; state.canvasW = W; state.canvasH = H; }
  const stripAtTop = state.stripLayout === 'top';
  const vidY = stripAtTop ? stripH : 0;
  gtx.fillStyle = '#000'; gtx.fillRect(0, 0, W, H);
  /* pick source frame: live or delayed from the ring */
  let src = video;
  const vidDelayMs = state.syncOffsetMs < 0 ? -state.syncOffsetMs : 0;
  if (video.readyState >= 2) {
    if (vidDelayMs > 0) {
      const snap = getPooledCanvas(video.videoWidth || vw, video.videoHeight || vh);
      snap.getContext('2d').drawImage(video, 0, 0);
      frameQueue.push({ t: performance.now(), c: snap });
      const cutoff = performance.now() - vidDelayMs;
      while (frameQueue.length > 1 && frameQueue[1].t <= cutoff) { framePool.push(frameQueue[0].c); frameQueue.shift(); }
      if (frameQueue[0].t <= cutoff) src = frameQueue[0].c;
    } else {
      while (frameQueue.length) framePool.push(frameQueue.pop().c);
    }
  }
  if (src && (src === video ? video.readyState >= 2 : true)) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    if (sw && sh) {
      const zoom = state.zoomNative ? 1 : state.zoom;
      const cw = sw / zoom, chh = sh / zoom, cx = (sw - cw) / 2, cy = (sh - chh) / 2;
      gtx.save();
      if (state.mirror) { gtx.translate(vw, vidY); gtx.scale(-1, 1); gtx.drawImage(src, cx, cy, cw, chh, 0, 0, vw, vh); }
      else gtx.drawImage(src, cx, cy, cw, chh, 0, vidY, vw, vh);
      gtx.restore();
    }
  }
  if ($('p-grid').classList.contains('on')) {
    gtx.strokeStyle = 'rgba(255,255,255,0.35)'; gtx.lineWidth = 2;
    for (let i = 1; i < 3; i++) {
      gtx.beginPath(); gtx.moveTo((vw / 3) * i, vidY); gtx.lineTo((vw / 3) * i, vidY + vh); gtx.stroke();
      gtx.beginPath(); gtx.moveTo(0, vidY + (vh / 3) * i); gtx.lineTo(vw, vidY + (vh / 3) * i); gtx.stroke();
    }
  }
  if (meters) state.meterEnergy = meters.sample().specEnergy;
  if (state.stripLayout === 'top' && meters) meters.draw(gtx, 0, 0, W, stripH);
  if (state.stripLayout === 'bottom' && meters) meters.draw(gtx, 0, vh, W, stripH);
  if (state.stripLayout === 'overlay' && meters) { gtx.save(); gtx.globalAlpha = 0.85; meters.draw(gtx, 0, vh - Math.round(vh * 0.16), W, Math.round(vh * 0.16)); gtx.restore(); }
  if (state.recording) { gtx.fillStyle = '#ff5252'; gtx.beginPath(); gtx.arc(W - 34, 34, 13, 0, 7); gtx.fill(); }
}
function loop() { drawFrame(); raf = requestAnimationFrame(loop); }

let recorder = null, chunks = [], recTimer = null;
function pickMime() {
  const chain = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', ''];
  for (const m of chain) { if (!m || (window.MediaRecorder && MediaRecorder.isTypeSupported(m))) return m; }
  return '';
}
function startRecording() {
  ensureAudioGraph();
  if (actx.state === 'suspended') actx.resume();
  const { W, H } = layoutDims();
  if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
  const vStream = canvas.captureStream(30);
  const tracks = [...vStream.getVideoTracks()];
  if (recDest) tracks.push(...recDest.stream.getAudioTracks());
  const mixed = new MediaStream(tracks);
  state._mixedTracks = tracks.map((t) => t.kind);
  const mime = pickMime();
  state.mimeType = mime;
  chunks = [];
  recorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start(250);
  state.recording = true; state.recSeconds = 0;
  $('p-rec').textContent = '⏹ Stop'; $('p-rec').classList.add('recording');
  $('p-after').style.display = 'none';
  recTimer = setInterval(() => { state.recSeconds++; $('p-timer').textContent = fmtTime(state.recSeconds); }, 1000);
  $('p-timer').textContent = '0:00';
}
function fmtTime(s) { return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function stopRecording() { if (recorder && recorder.state !== 'inactive') recorder.stop(); }
function finishRecording() {
  clearInterval(recTimer);
  state.recording = false;
  $('p-rec').textContent = '⏺ Record'; $('p-rec').classList.remove('recording');
  const type = state.mimeType || 'video/webm';
  const blob = new Blob(chunks, { type });
  state.lastBlob = blob;
  if (state.lastUrl) URL.revokeObjectURL(state.lastUrl);
  state.lastUrl = URL.createObjectURL(blob);
  const pv = $('p-preview'); pv.src = state.lastUrl;
  $('p-after').style.display = '';
  $('p-file-note').textContent = 'Recording: ' + (blob.size / 1048576).toFixed(2) + ' MB · ' + type + ' · tracks baked in: ' + (state._mixedTracks || []).join(' + ') + ' · canvas ' + canvas.width + '×' + canvas.height;
  window.__HOLOREC__.lastRecording = { blob, mimeType: type, size: blob.size, tracks: state._mixedTracks, canvasW: canvas.width, canvasH: canvas.height };
}
async function shareRecording() {
  if (!state.lastBlob) return;
  const ext = state.mimeType.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([state.lastBlob], 'holorec-' + Date.now() + '.' + ext, { type: state.lastBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'HoloRec take' }); } catch (e) {}
  } else {
    $('p-file-note').textContent += ' · Share-with-file not supported here — use Download.';
  }
}
function downloadRecording() {
  if (!state.lastUrl) return;
  const a = document.createElement('a');
  a.href = state.lastUrl; a.download = 'holorec-' + Date.now() + '.' + (state.mimeType.includes('mp4') ? 'mp4' : 'webm');
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- connection ---------------- */
async function joinRoom(code) {
  state.code = code;
  document.querySelectorAll('main').forEach((m) => { m.style.display = 'none'; });
  $('phone').style.display = '';
  setConn('CONNECTING — signaling…');
  const send = (msg) => { if (state.mqtt) state.mqtt.client.publish('holorec/v1/' + state.code + '/sig', JSON.stringify({ ...msg, from: 'phone' })); };
  try {
    state.mqtt = await connectMqtt(code, 'phone', (msg) => {
      if (msg.type === 'desktop-here') send({ type: 'hello' });
      if (state.peerRef) state.peerRef.handleSignal(msg);
    }, (t) => setConn('CONNECTING — ' + t));
    state.mqtt.code = code; state.broker = state.mqtt.broker;
  } catch (e) { setConn('FAILED — ' + e.message); return; }
  const peer = new Peer('phone', send, {
    onState: (t) => {
      if (t === 'LIVE') {
        stopHelloLoop();
        setConn('LIVE — Ableton audio streaming in', true);
        if (state.audioReady) $('p-audio-note').textContent = 'Ableton audio connected — it will be baked into the recording.';
      }
      else if (t === 'CONNECTING') setConn('CONNECTING — desktop found, ICE in progress…');
      else setConn(t);
    },
    onRemoteStream: (s) => adoptRemoteStream(s),
    onStats: ({ rttMs }) => { state.rttMs = rttMs; if (rttMs != null && state.connState.startsWith('LIVE')) setConn('LIVE — Ableton audio streaming in · latency ~' + rttMs + ' ms', true); },
  });
  state.peerRef = peer;
  /* Hello heartbeat: build 1 sent ONE hello — if the desktop missed it (or
   * its one offer was published before the phone subscribed), the pair never
   * met. Re-announce until LIVE so a lost offer always recovers. */
  send({ type: 'hello' });
  let helloCount = 0;
  const helloTimer = setInterval(() => {
    if (state.connState.startsWith('LIVE') || ++helloCount > 30) { stopHelloLoop(); return; }
    send({ type: 'hello' });
  }, 4000);
  function stopHelloLoop() { clearInterval(helloTimer); }
  setConn('CONNECTING — waiting for desktop offer (room ' + code + ')…');
}

export function initPhone(preCode) {
  document.querySelectorAll('main').forEach((m) => { m.style.display = 'none'; });
  $('phone').style.display = '';
  canvas = $('p-canvas'); gtx = canvas.getContext('2d');
  ensureAudioGraph();
  /* preview meters exist even before remote audio so layout is testable;
     they attach to the remote source when it arrives. */
  if (!meters) meters = new MeterStrip();
  $('p-code-label').textContent = preCode || '';
  diagLog('HoloRec build 4 diagnostics · UA: ' + navigator.userAgent.slice(0, 110));
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'camera' }).then((p) => diagLog('camera permission state: ' + p.state)).catch((e) => diagLog('permission query failed: ' + e.message));
  }
  $('p-wired-start').onclick = () => startWiredAudio();
  refreshAudioDevices();
  $('p-probe').onclick = () => runProbe();
  $('p-diag-copy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(state.diagText || ''); e.target.textContent = '📋 Copied'; } catch (err) { e.target.textContent = '📋 Copy failed — screenshot it'; }
  };
  $('p-start-cam').onclick = async () => { await startCamera(); };
  $('p-flip').onclick = () => { state.facing = state.facing === 'user' ? 'environment' : 'user'; state.deviceId = null; state.mirror = state.facing === 'user' ? state.mirror : state.mirror; startCamera(); };
  $('p-torch').onclick = toggleTorch;
  $('p-mirror').onclick = (e) => { state.mirror = !state.mirror; e.target.classList.toggle('on', state.mirror); };
  $('p-grid').onclick = (e) => { e.target.classList.toggle('on'); };
  $('p-res').onchange = (e) => { const [w, h] = e.target.value.split('x').map(Number); state.res = { w, h }; startCamera(); };
  $('p-zoom').oninput = (e) => setZoom(parseFloat(e.target.value));
  $('p-sync').oninput = (e) => setSyncOffset(parseInt(e.target.value, 10), false);
  $('p-monitor').onclick = (e) => {
    state.monitorOn = !state.monitorOn;
    ensureAudioGraph();
    monitorGain.gain.value = state.monitorOn ? 0.9 : 0;
    e.target.classList.toggle('on', state.monitorOn);
    e.target.textContent = state.monitorOn ? '🔊 Monitor ON' : '🔇 Monitor off';
  };
  $('p-strip').onchange = (e) => { state.stripLayout = e.target.value; const d = layoutDims(); state.canvasW = d.W; state.canvasH = d.H; };
  $('p-rec').onclick = () => { state.recording ? stopRecording() : startRecording(); };
  $('p-download').onclick = downloadRecording;
  $('p-share').onclick = shareRecording;
  setZoom(1); setSyncOffset(0, true);
  loop();
  if (preCode) joinRoom(preCode);
  else setConn('No room code — go back and scan the desktop QR, or enter the code on the start screen.');
  startCamera();
}

/* ------- internal test seam (not user UI): inject a local test audio
 * stream through the exact same graph a WebRTC remote stream takes. */
window.__HOLOREC__.injectTestAudio = function () {
  ensureAudioGraph();
  if (actx.state === 'suspended') actx.resume();
  const osc = actx.createOscillator(); osc.frequency.value = 110;
  const osc2 = actx.createOscillator(); osc2.frequency.value = 220;
  const gn = actx.createGain(); gn.gain.value = 0.25;
  const lfo = actx.createOscillator(); lfo.frequency.value = 2;
  const lfoG = actx.createGain(); lfoG.gain.value = 0.18;
  lfo.connect(lfoG); lfoG.connect(gn.gain);
  const dst = actx.createMediaStreamDestination();
  osc.connect(gn); osc2.connect(gn); gn.connect(dst);
  osc.start(); osc2.start(); lfo.start();
  adoptRemoteStream(dst.stream);
  return true;
};
window.__HOLOREC__.phone = { startRecording, stopRecording, setSyncOffset, setZoom, startCamera, joinRoom };
window.__HOLOREC__.adoptRemoteStream = adoptRemoteStream;
