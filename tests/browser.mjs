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
  await ctx.close();
}

check('zero page errors across all pages', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
server.close();
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
process.exit(fails ? 1 : 0);
