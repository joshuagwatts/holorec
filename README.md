# HoloRec

Record your phone's camera with what's playing in Ableton on your desktop — baked into one file, ready to share.

**Live:** https://joshuagwatts.github.io/holorec/

## How it works
1. Open the page on the **desktop** → pick how to capture Ableton's audio:
   system/tab audio (Chrome/Edge share dialog), or an audio input device
   (loopback / interface / virtual cable — Voicemeeter, BlackHole, VB-Cable).
   Watch the level meter — if it moves, the audio is arriving.
2. The desktop shows a big QR + 6-char room code. Scan it with the **phone**
   (same WiFi recommended). The phone joins automatically.
3. The desktop's audio streams to the phone over a direct WebRTC peer
   connection (MQTT-over-WSS is used only to introduce the two devices —
   no audio touches a server).
4. On the phone: full camera controls (front/rear, lens picker, zoom,
   torch, 720p/1080p/4K, mirror, grid), a MiniMeters-style strip
   (spectrum + waveform + L/R meters, from the Ableton audio only) that can
   sit above/below the footage — baked into the exported video as extra
   height — overlay it, or be off, plus a sync-offset slider
   (−500…+500 ms, pre-set from the stream's jitter-buffer estimate).
5. Hit **Record**. One file comes out: camera video + Ableton audio,
   in sync. Preview, Download, or Share straight from the phone.

## Notes
- Monitor is off by default (feedback) — the recording always captures the audio.
- Build 2: STUN + TURN relay fallback (build 1 was STUN-only and failed on
  a real network). Direct peer paths are preferred; the relay carries the
  audio only when no direct path exists. ICE failures auto-retry with an
  ICE restart, and the failure line reports which ICE candidate types each
  side produced, so a screenshot is enough to debug the next step.
- Build 2 camera: switching lens/facing/resolution stops the old camera
  before opening the new one, caps capture at 30fps (the canvas records at
  30 anyway), and falls back down a constraint ladder instead of leaving a
  black screen.
- Static site, no build step. Cache-busting: every asset carries `?v=BUILD`.

Build 3.
