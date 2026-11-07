/* MiniMeters-style strip, drawn from AnalyserNodes on the Ableton audio
 * ONLY: spectrum bars + waveform scope + L/R peak/RMS. Dark look.
 * Drawn onto a 2D context region (x, y, w, h) of the composite canvas,
 * so whatever is drawn here is baked into the exported video. */
export class MeterStrip {
  constructor() {
    this.spec = null; this.wave = null; this.chanL = null; this.chanR = null;
    this.levels = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, specEnergy: 0 };
    this._specData = null; this._waveData = null; this._chData = null;
    this._peakHoldL = 0; this._peakHoldR = 0;
  }
  /* Wire analysers for a (possibly mono) source node. Splitter gives true
   * L/R when the source is stereo; mono sources read the same on both. */
  attach(ctx, sourceNode) {
    this.detach();
    this.spec = ctx.createAnalyser(); this.spec.fftSize = 2048; this.spec.smoothingTimeConstant = 0.75;
    this.wave = ctx.createAnalyser(); this.wave.fftSize = 2048;
    sourceNode.connect(this.spec); sourceNode.connect(this.wave);
    try {
      const split = ctx.createChannelSplitter(2);
      this.chanL = ctx.createAnalyser(); this.chanL.fftSize = 512;
      this.chanR = ctx.createAnalyser(); this.chanR.fftSize = 512;
      sourceNode.connect(split); split.connect(this.chanL, 0); split.connect(this.chanR, 1);
    } catch (e) { this.chanL = this.spec; this.chanR = this.spec; }
    this._specData = new Uint8Array(this.spec.frequencyBinCount);
    this._waveData = new Uint8Array(this.wave.fftSize);
    this._chData = new Uint8Array(512);
  }
  detach() { for (const n of [this.spec, this.wave, this.chanL, this.chanR]) { try { n && n.disconnect(); } catch (e) {} } this.spec = null; }
  _chanStats(an) {
    if (!an) return { peak: 0, rms: 0 };
    an.getByteTimeDomainData(this._chData);
    let peak = 0, sum = 0;
    for (let i = 0; i < this._chData.length; i++) { const v = (this._chData[i] - 128) / 128; const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
    return { peak, rms: Math.sqrt(sum / this._chData.length) };
  }
  /* Update this.levels from the analysers (cheap; call per video frame). */
  sample() {
    if (!this.spec) { this.levels = { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, specEnergy: 0 }; return this.levels; }
    const l = this._chanStats(this.chanL), r = this._chanStats(this.chanR);
    this._peakHoldL = Math.max(l.peak, this._peakHoldL * 0.94);
    this._peakHoldR = Math.max(r.peak, this._peakHoldR * 0.94);
    this.spec.getByteFrequencyData(this._specData);
    let e = 0; const n = Math.min(96, this._specData.length);
    for (let i = 0; i < n; i++) e += this._specData[i];
    this.levels = { peakL: this._peakHoldL, peakR: this._peakHoldR, rmsL: l.rms, rmsR: r.rms, specEnergy: e / (n * 255) };
    return this.levels;
  }
  /* Simple horizontal level 0..1 for the desktop page meter. */
  level01() { return Math.max(this.levels.rmsL, this.levels.rmsR) * 1.6 > 1 ? 1 : Math.max(this.levels.rmsL, this.levels.rmsR) * 1.6; }
  draw(g, x, y, w, h) {
    g.save();
    g.fillStyle = 'rgba(8,10,14,0.92)'; g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(120,200,255,0.25)'; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (!this.spec) {
      g.fillStyle = '#5b6b7d'; g.font = `${Math.max(11, h * 0.14)}px system-ui`;
      g.fillText('MINIMETERS — waiting for Ableton audio…', x + 10, y + h / 2);
      g.restore(); return;
    }
    const meterW = Math.round(w * 0.16), scopeW = Math.round(w * 0.30);
    const specW = w - meterW - scopeW - 24;
    /* spectrum bars (log-ish bins) */
    this.spec.getByteFrequencyData(this._specData);
    const bars = 48, bw = specW / bars;
    for (let i = 0; i < bars; i++) {
      const bin = Math.floor(Math.pow(i / bars, 1.7) * this._specData.length * 0.72) + 1;
      const v = this._specData[Math.min(bin, this._specData.length - 1)] / 255;
      const bh = v * (h - 18);
      g.fillStyle = v > 0.86 ? '#ff5252' : v > 0.62 ? '#ffd54a' : '#37d67a';
      g.fillRect(x + 8 + i * bw + 1, y + h - 8 - bh, bw - 2, bh);
    }
    g.fillStyle = '#8fa3b8'; g.font = `${Math.max(9, h * 0.10)}px system-ui`;
    g.fillText('ABLETON · SPECTRUM', x + 8, y + 13);
    /* waveform scope */
    const sx = x + 8 + specW + 8;
    this.wave.getByteTimeDomainData(this._waveData);
    g.strokeStyle = '#4dd0e1'; g.lineWidth = 1.6; g.beginPath();
    for (let i = 0; i < scopeW; i++) {
      const v = this._waveData[Math.floor((i / scopeW) * this._waveData.length)] / 255;
      const yy = y + 8 + (1 - v) * (h - 16);
      if (i === 0) g.moveTo(sx + i, yy); else g.lineTo(sx + i, yy);
    }
    g.stroke();
    g.fillStyle = '#8fa3b8'; g.fillText('WAVE', sx, y + 13);
    /* L/R bars */
    const mx = sx + scopeW + 8, mw = meterW - 8;
    const rows = [['L', this.levels.peakL, this.levels.rmsL], ['R', this.levels.peakR, this.levels.rmsR]];
    rows.forEach(([label, peak, rms], ri) => {
      const yy = y + 14 + ri * ((h - 22) / 2), rh = (h - 30) / 2;
      g.fillStyle = '#8fa3b8'; g.fillText(label, mx, yy + rh * 0.8);
      const bx = mx + 14, bwid = mw - 14;
      g.fillStyle = '#1b222c'; g.fillRect(bx, yy, bwid, rh);
      g.fillStyle = rms > 0.86 ? '#ff5252' : '#37d67a'; g.fillRect(bx, yy, bwid * Math.min(1, rms * 1.4), rh);
      g.fillStyle = '#ffd54a'; g.fillRect(bx + bwid * Math.min(1, peak) - 2, yy, 2, rh);
    });
    g.restore();
  }
}
