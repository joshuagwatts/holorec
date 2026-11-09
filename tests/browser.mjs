/* HoloRec prove-out: headless Chromium, fake camera/mic.
 * Proves: pages load with 0 errors, desktop QR + code render, desktop fake-mic
 * capture drives the level meter, phone camera starts (actual res shown),
 * test-seam Ableton audio animates the MiniMeters data, strip layout changes
 * composite canvas height, and a real canvas MediaRecorder take produces a
 * blob carrying BOTH a video and an audio track.
 * NOT proven here (VM blocks UDP): real WebRTC ICE between two devices. */
import { createRequire } from 'module';
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../../limbo-test/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8947;
const BASE = `http://127.0.0.1:${PORT}/`;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.md': 'text/plain' };
const server = createServer((req, res) => {
  const clean = req.url.split('?')[0];
  const p = join(ROOT, clean === '/' ? 'index.html' : clean);
  if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
writeFileSync('/tmp/holorec-bootstrap.html', `<script>location.replace(${JSON.stringify(BASE)})</script>`);

let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const POLICY_PATH = '/var/lib/hatch-browser/rootfs-base/usr/share/hatch/chromium/webgl-allowed-domains.txt';
const policy = readFileSync(POLICY_PATH);
const POLICY_ARGS = [
  `--hatch-webgl-allowed-domains-file=${POLICY_PATH}`,
  `--hatch-webgl-allowed-domains-sha256=${createHash('sha256').update(policy).digest('hex')}`,
];
const browser = await chromium.launch({
  executablePath: '/opt/meta-chromium/chrome',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors', '--mute-audio', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...POLICY_ARGS],
});
const errors = [];
async function newPage(url) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 200)); });
  /* Chromium 152 blocks direct nav to 127.0.0.1 — bootstrap via a file://
   * page whose location.replace IS the navigation (AGENTS.md lesson). */
  writeFileSync('/tmp/holorec-bootstrap.html', `<script>location.replace(${JSON.stringify(url)})</script>`);
  await page.goto('file:///tmp/holorec-bootstrap.html');
  await page.waitForURL((u) => u.href.startsWith(url.split('?')[0]), { timeout: 20000 });
  return { ctx, page };
}

/* ---------- LANDING ---------- */
{
  const { ctx, page } = await newPage(BASE);
  await page.waitForSelector('#landing', { state: 'visible' });
  check('landing shows mode picker', true);
  await ctx.close();
}

/* ---------- DESKTOP ---------- */
{
  const { ctx, page } = await newPage(BASE + '?mode=desktop');
  await page.waitForSelector('#desktop', { state: 'visible' });
  const code = await page.textContent('#d-code');
  check('desktop room code is 6 chars', /^[A-Z0-9]{6}$/.test(code.trim()), code.trim());
  const qrSvg = await page.$('#d-qr svg');
  check('desktop QR renders (svg)', !!qrSvg);
  const url = await page.textContent('#d-phone-url');
  check('phone URL carries room+mode', url.includes('room=' + code.trim()) && url.includes('mode=phone'), url.trim());
  await page.evaluate(() => window.__HOLOREC__.desktop.startCaptureDevice());
  await page.waitForFunction(() => window.__HOLOREC__.state.audioStream, null, { timeout: 15000 });
  check('desktop fake-mic capture adopted', true);
  await page.waitForFunction(() => window.__HOLOREC__.state.meterLevel > 0.02, null, { timeout: 15000 }).catch(() => {});
  const lvl = await page.evaluate(() => window.__HOLOREC__.state.meterLevel);
  check('desktop level meter moves from fake mic', lvl > 0.02, 'level=' + lvl.toFixed(3));
  await ctx.close();
}

/* ---------- PHONE ---------- */
{
  const { ctx, page } = await newPage(BASE + '?mode=phone&room=TEST12');
  await page.waitForSelector('#phone', { state: 'visible' });
  await page.waitForFunction(() => {
    const el = document.getElementById('p-actual-res');
    return el && el.textContent.includes('×');
  }, null, { timeout: 20000 });
  const res = await page.textContent('#p-actual-res');
  check('phone camera starts, actual res displayed', true, res.trim());
  /* test-seam Ableton audio through the real record graph */
  await page.evaluate(() => window.__HOLOREC__.injectTestAudio());
  await page.waitForFunction(() => window.__HOLOREC__.state.audioReady, null, { timeout: 10000 });
  check('test audio adopted as remote Ableton stream', true);
  /* Build-4 wired mode: the phone's own input (fake mic here) becomes the
   * recording's audio source with no network involved. */
  await page.click('#p-wired-start');
  await page.waitForFunction(() => window.__HOLOREC__.state.audioSource === 'wired', null, { timeout: 10000 });
  const wiredNote = await page.textContent('#p-audio-note');
  check('wired input mode engages and says so', wiredNote.includes('Wired input live'), wiredNote.trim());
  /* restore the test-audio source for the recording checks below */
  await page.evaluate(() => window.__HOLOREC__.injectTestAudio());
  let energy = 0;
  for (let i = 0; i < 20 && energy <= 0.01; i++) { await page.waitForTimeout(200); energy = await page.evaluate(() => window.__HOLOREC__.state.meterEnergy); }
  check('MiniMeters spectrum animates from test audio', energy > 0.01, 'specEnergy=' + energy.toFixed(3));
  /* strip layout changes canvas height */
  const hBottom = await page.evaluate(() => window.__HOLOREC__.state.canvasH);
  await page.selectOption('#p-strip', 'off');
  await page.waitForTimeout(400);
  const hOff = await page.evaluate(() => window.__HOLOREC__.state.canvasH);
  await page.selectOption('#p-strip', 'top');
  await page.waitForTimeout(400);
  const hTop = await page.evaluate(() => window.__HOLOREC__.state.canvasH);
  check('strip OFF removes extra canvas height', hOff < hBottom, `bottom=${hBottom} off=${hOff}`);
  check('strip TOP adds extra canvas height', hTop === hBottom, `top=${hTop}`);
  /* mirror toggle through the real chip */
  await page.click('#p-mirror');
  check('mirror toggle sets state', await page.evaluate(() => window.__HOLOREC__.state.mirror === true));
  /* Build-2 regression: camera RESTART (the path that died on Joshua's
   * phone with "Could not start video source") — flip facing, which stops
   * the old track and re-opens. Must land back on a live camera with no
   * failure note. */
  await page.click('#p-flip');
  await page.waitForFunction(() => {
    const el = document.getElementById('p-actual-res');
    const note = document.getElementById('p-cam-note');
    return window.__HOLOREC__.state.camStream && el && el.textContent.includes('×') && note && !note.textContent.includes('Camera failed');
  }, null, { timeout: 15000 });
  check('camera restart via flip succeeds (stop-first + fallback ladder)', true);
  /* rapid double restart — serialized starts must not race/fail */
  await page.click('#p-flip'); await page.click('#p-flip');
  await page.waitForTimeout(1500);
  const noteAfter = await page.textContent('#p-cam-note');
  check('rapid double flip leaves no camera failure', !noteAfter.includes('Camera failed'), noteAfter.trim());
  /* Build-3 diagnostics: the on-device log must record attempts and the
   * playback/frame check, and the probe button must exist. */
  await page.waitForFunction(() => window.__HOLOREC__.state.diagText && window.__HOLOREC__.state.diagText.includes('playback check'), null, { timeout: 15000 });
  const diag = await page.evaluate(() => window.__HOLOREC__.state.diagText);
  check('diag log records a successful camera attempt', /attempt \d+ OK/.test(diag));
  check('diag playback check sees frames advancing', diag.includes('framesAdvancing=true'), diag.split('\n').filter((l) => l.includes('playback check')).join(' ; ').slice(0, 160));
  check('diag probe button present', !!(await page.$('#p-probe')));
  /* record a real take */
  await page.click('#p-rec');
  await page.waitForFunction(() => window.__HOLOREC__.state.recording, null, { timeout: 8000 });
  await page.waitForTimeout(2000);
  await page.click('#p-rec');
  await page.waitForFunction(() => window.__HOLOREC__.lastRecording && window.__HOLOREC__.lastRecording.size > 0, null, { timeout: 15000 });
  const rec = await page.evaluate(() => { const r = window.__HOLOREC__.lastRecording; return { size: r.size, mimeType: r.mimeType, tracks: r.tracks, canvasW: r.canvasW, canvasH: r.canvasH }; });
  check('recording blob produced', rec.size > 2000, rec.size + ' bytes · ' + rec.mimeType);
  check('recording has video + audio tracks', rec.tracks.includes('video') && rec.tracks.includes('audio'), rec.tracks.join('+'));
  check('recording canvas matches strip layout', rec.canvasH === hTop && rec.canvasW > 0, rec.canvasW + '×' + rec.canvasH);
  const previewSrc = await page.getAttribute('#p-preview', 'src');
  check('preview player gets the take', !!previewSrc && previewSrc.startsWith('blob:'));
  /* Build-2: TURN relay must be in the ICE config (build 1 was STUN-only
   * and failed on Joshua's real network). */
  const iceUrls = await page.evaluate(async () => {
    const m = await import('./js/net.js?v=5');
    return m.RTC_CFG.iceServers.flatMap((s) => Array.isArray(s.urls) ? s.urls : [s.urls]);
  });
  check('ICE config includes a TURN relay', iceUrls.some((u) => u.startsWith('turn:') || u.startsWith('turns:')), iceUrls.join(','));
  /* Build-5: the staticauth TURN credentials must be minted fresh in the
   * documented coturn REST shape — username "<expiry>:holorec" with the
   * expiry ~1h out, credential = base64 HMAC-SHA1 (28 chars). The fixed
   * openrelayproject/openrelayproject pair from build 2 is stale. */
  const sa = await page.evaluate(async () => {
    const m = await import('./js/net.js?v=5');
    const servers = await m.buildIceServers();
    const e = servers.find((s) => (Array.isArray(s.urls) ? s.urls.join(' ') : s.urls).includes('staticauth'));
    return e ? { username: e.username, credential: e.credential } : null;
  });
  const saOk = !!sa && /^\d+:holorec$/.test(sa.username) && Math.abs(parseInt(sa.username, 10) - Math.floor(Date.now() / 1000) - 3600) < 120 && /^[A-Za-z0-9+/]{27}=$/.test(sa.credential);
  check('staticauth TURN creds minted fresh (HMAC REST shape)', saOk, sa ? sa.username : 'missing');
  await ctx.close();
}

check('zero page errors across all pages', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
process.exit(fails ? 1 : 0);
