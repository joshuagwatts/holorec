/* HoloRec network E2E — the double-check for the link path.
 * Two REAL pages (desktop + phone) in the VM browser, real RTCPeerConnections
 * with the shipped ICE config, talking through a REAL MQTT broker (aedes,
 * run locally — the sandbox's egress proxy blocks the public brokers and
 * all UDP, which the first run of this suite proved the hard way: both
 * pages' broker stayed null and no peer was ever created).
 * The ONLY test substitution is the broker endpoint: the app server swaps
 * BROKERS[0] for the local broker in the served copy of net.js. Every other
 * byte — rendezvous walk, topics, hello/offer/answer handling, the build-5
 * ICE candidate queue, ontrack — is the shipped code.
 * Proves: same-broker rendezvous, hello -> offer -> answer, NO trickle
 * candidate dropped (queue counters), remote track announced, ICE leaves
 * 'new' into checking.
 * CANNOT prove here: media completing — sandbox blocks UDP + direct TURN,
 * so ICE cannot finish in the VM (standing AGENTS.md fact). That last hop
 * is only provable on real devices. */
import { createRequire } from 'module';
import { createServer } from 'http';
import { readFileSync, existsSync, writeFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(new URL('../../limbo-test/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const Aedes = require('aedes');
const websocketStream = require('websocket-stream');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8949;
const BROKER_PORT = 8953;
const BASE = `http://127.0.0.1:${PORT}/`;
const LOCAL_BROKER = `ws://127.0.0.1:${BROKER_PORT}/mqtt`;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.md': 'text/plain' };

/* local MQTT broker over websockets */
const broker = (Aedes.createBroker ? Aedes.createBroker() : Aedes());
broker.on('subscribe', (s, c) => console.log('[broker] SUB', c ? c.id : '?', '->', s.map((x) => x.topic).join(',')));
broker.on('publish', (p, c) => { if (!p.topic.startsWith('$SYS')) console.log('[broker] PUB', c ? c.id : '?', p.topic, p.payload.toString().slice(0, 70)); });
broker.on('clientError', (c, e) => console.log('[broker] clientError', c ? c.id : '?', e.message));
const brokerHttp = createServer();
websocketStream.createServer({ server: brokerHttp }, broker.handle);
await new Promise((r) => brokerHttp.listen(BROKER_PORT, '127.0.0.1', r));

const server = createServer((req, res) => {
  const clean = req.url.split('?')[0];
  const p = join(ROOT, clean === '/' ? 'index.html' : clean);
  if (!existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end('nf'); return; }
  let body = readFileSync(p);
  if (clean === '/js/net.js') {
    const src = body.toString('utf8');
    if (!src.includes('wss://broker.emqx.io:8084/mqtt')) { res.writeHead(500); res.end('broker patch anchor missing'); return; }
    body = Buffer.from(src.replace('wss://broker.emqx.io:8084/mqtt', LOCAL_BROKER), 'utf8');
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + extra : '')); if (!cond) fails++; };
const POLICY_PATH = '/var/lib/hatch-browser/rootfs-base/usr/share/hatch/chromium/webgl-allowed-domains.txt';
const policy = readFileSync(POLICY_PATH);
const browser = await chromium.launch({
  executablePath: '/opt/meta-chromium/chrome',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-certificate-errors', '--mute-audio', '--allow-file-access-from-files',
    '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--hatch-webgl-allowed-domains-file=${POLICY_PATH}`, `--hatch-webgl-allowed-domains-sha256=${createHash('sha256').update(policy).digest('hex')}`],
});
const errors = [];
async function newPage(url) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(String(e)); console.log('[pageerror]', String(e).slice(0, 200)); });
  writeFileSync('/tmp/holorec-bootstrap.html', `<script>location.replace(${JSON.stringify(url)})</script>`);
  await page.goto('file:///tmp/holorec-bootstrap.html');
  await page.waitForURL((u) => u.href.startsWith(url.split('?')[0]), { timeout: 20000 });
  return { ctx, page };
}
const waitFor = async (page, fn, timeout, label) => {
  try { await page.waitForFunction(fn, null, { timeout }); return true; }
  catch (e) { console.log('timeout waiting:', label); return false; }
};

/* ---------- DESKTOP: capture + start link ---------- */
const d = await newPage(BASE + '?mode=desktop');
await d.page.waitForSelector('#desktop', { state: 'visible' });
await d.page.evaluate(() => window.__HOLOREC__.desktop.startCaptureDevice());
check('desktop captured fake mic', await waitFor(d.page, () => !!window.__HOLOREC__.state.audioStream, 15000, 'desktop audio'));
const code = (await d.page.textContent('#d-code')).trim();
await d.page.click('#d-go');
check('desktop reached the signaling broker', await waitFor(d.page, () => !!window.__HOLOREC__.state.broker, 30000, 'desktop broker'));
const dBroker = await d.page.evaluate(() => window.__HOLOREC__.state.broker);
console.log('desktop broker:', dBroker, '· room:', code);

/* ---------- PHONE: join the same room ---------- */
const p = await newPage(BASE + '?mode=phone&room=' + code);
await p.page.waitForSelector('#phone', { state: 'visible' });
check('phone reached the signaling broker', await waitFor(p.page, () => !!window.__HOLOREC__.state.broker, 30000, 'phone broker'));
const pBroker = await p.page.evaluate(() => window.__HOLOREC__.state.broker);
console.log('phone broker:', pBroker);
check('both sides rendezvoused on the SAME broker', !!dBroker && dBroker === pBroker, String(dBroker) + ' vs ' + String(pBroker));

/* ---------- Negotiation ---------- */
check('phone got a peer + remote description (offer arrived and was applied)',
  await waitFor(p.page, () => { const pr = window.__HOLOREC__.state.peerRef; return pr && pr.pc.remoteDescription && pr.pc.localDescription; }, 45000, 'phone remote desc'));
check('desktop got the answer back',
  await waitFor(d.page, () => { const pr = window.__HOLOREC__.state.peer; return pr && pr.pc.remoteDescription; }, 30000, 'desktop remote desc'));
check('phone remote audio track announced (audioReady via the real peer, not the test seam)',
  await waitFor(p.page, () => window.__HOLOREC__.state.audioReady === true, 20000, 'phone audioReady'));

/* give ICE a few seconds to exchange candidates, then read the counters */
await p.page.waitForTimeout(6000);
const hasPeers = await p.page.evaluate(() => !!window.__HOLOREC__.state.peerRef) && await d.page.evaluate(() => !!window.__HOLOREC__.state.peer);
check('both peers exist for ICE accounting', hasPeers);
if (hasPeers) {
  const pIce = await p.page.evaluate(() => { const pr = window.__HOLOREC__.state.peerRef; return { q: pr.iceQueued, a: pr.iceAdded, d: pr.iceDropped, local: pr.localCands, remote: pr.remoteCands, ice: pr.pc.iceConnectionState, conn: pr.pc.connectionState }; });
  const dIce = await d.page.evaluate(() => { const pr = window.__HOLOREC__.state.peer; return { q: pr.iceQueued, a: pr.iceAdded, d: pr.iceDropped, local: pr.localCands, remote: pr.remoteCands, ice: pr.pc.iceConnectionState, conn: pr.pc.connectionState }; });
  console.log('phone ICE:', JSON.stringify(pIce));
  console.log('desktop ICE:', JSON.stringify(dIce));
  const candTotal = (o) => Object.values(o).reduce((s, n) => s + n, 0);
  check('phone received desktop candidates', candTotal(pIce.remote) > 0, JSON.stringify(pIce.remote));
  check('desktop received phone candidates', candTotal(dIce.remote) > 0, JSON.stringify(dIce.remote));
  check('ZERO candidates dropped on phone (queue works)', pIce.d === 0, 'queued=' + pIce.q + ' added=' + pIce.a + ' dropped=' + pIce.d);
  check('ZERO candidates dropped on desktop (queue works)', dIce.d === 0, 'queued=' + dIce.q + ' added=' + dIce.a + ' dropped=' + dIce.d);
  check('every queued candidate was flushed (added >= queued)', pIce.a >= pIce.q && dIce.a >= dIce.q, 'phone a/q=' + pIce.a + '/' + pIce.q + ' desktop a/q=' + dIce.a + '/' + dIce.q);
  check('ICE progressed past new on both sides', ['checking', 'connected', 'completed', 'disconnected'].includes(pIce.ice) && ['checking', 'connected', 'completed', 'disconnected'].includes(dIce.ice), 'phone=' + pIce.ice + ' desktop=' + dIce.ice);
}
check('zero page errors across both pages', errors.length === 0, errors.slice(0, 3).join(' | '));

await d.ctx.close(); await p.ctx.close();
await browser.close();
server.close();
brokerHttp.close();
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
process.exit(fails ? 1 : 0);
