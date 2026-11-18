// ---------------------------------------------------------------- HackRF One over WebUSB
// The vendor requests are the ones libhackrf sends (greatscottgadgets/hackrf, host/libhackrf/src/hackrf.c);
// sweep mode follows hackrf_sweep and the firmware's usb_api_sweep.c. Two ways to see the band:
//   live:  RX at 2-20 MS/s, int8 I/Q on bulk endpoint 1, FFT in the page (spans up to 20 MHz);
//   sweep: the firmware retunes in 20 MHz steps (interleaved, 7.5 MHz offset) and sends one 16 KB block
//          per tuning: 0x7F 0x7F, u64 frequency (LE), then 8187 I/Q pairs. Of each FFT the host keeps
//          F..F+5 MHz and F+10..F+15 MHz (the band away from DC and the filter edges).
const HRF = {
  VID: 0x1d50, PIDS: [0x6089, 0x604b, 0xcc15],     // HackRF One, Jawbreaker, rad1o
  REQ: { MODE: 1, SAMPLE_RATE: 6, BB_FILTER: 7, BOARD_ID: 14, VERSION: 15, SET_FREQ: 16, AMP: 17, PARTID_SERIAL: 18,
    LNA: 19, VGA: 20, ANTENNA: 23, INIT_SWEEP: 26 },
  MODE: { OFF: 0, RX: 1, SWEEP: 5 },
  BLOCK: 16384, SWEEP_FS: 20e6, SWEEP_STEP: 20, SWEEP_OFFSET: 7.5e6, SWEEP_BB: 15e6,
  BB: [1.75e6, 2.5e6, 3.5e6, 5e6, 5.5e6, 6e6, 7e6, 8e6, 9e6, 10e6, 12e6, 14e6, 15e6, 20e6, 24e6, 28e6],
  BOARDS: { 0: "Jellybean", 1: "Jawbreaker", 2: "HackRF One", 3: "rad1o", 4: "HackRF One r9", 5: "HackRF Pro" },
  INFLIGHT: 6, ROWS: 250, FMAX_MHZ: 6000,
};
// hackrf_compute_baseband_filter_bw: the widest MAX2837 filter that is no wider than bw
function hrfFilterBw(bw) {
  let i = HRF.BB.findIndex((x) => x >= bw);
  if (i < 0) i = HRF.BB.length - 1;
  if (i > 0 && HRF.BB[i] > bw) i--;
  return HRF.BB[i];
}
// Sweep range in whole MHz around the view, (stop - start) a multiple of the 20 MHz step (as hackrf_sweep)
function hrfSweepRange(c, span) {
  const a = Math.max(0, Math.floor((c - span / 2) / 1e6));
  let b = Math.min(HRF.FMAX_MHZ, Math.ceil((c + span / 2) / 1e6));
  if (b - a < HRF.SWEEP_STEP) b = a + HRF.SWEEP_STEP;
  return [a, a + HRF.SWEEP_STEP * Math.ceil((b - a) / HRF.SWEEP_STEP)];
}
const hrfLe32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

class HackRfUsb {
  constructor(dev, log) { this.dev = dev; this.log = log || (() => {}); }
  static get filters() { return HRF.PIDS.map((p) => ({ vendorId: HRF.VID, productId: p })); }
  static is(dev) { return !!dev && dev.vendorId === HRF.VID && HRF.PIDS.includes(dev.productId); }
  async open() {
    const d = this.dev;
    if (!d.opened) await d.open();
    if (!d.configuration || d.configuration.configurationValue !== 1) await d.selectConfiguration(1);
    await d.claimInterface(0);
    // bcdDevice is the firmware's USB API version (sweep needs 1.04)
    this.api = ((d.deviceVersionMajor || 0) << 8) | ((d.deviceVersionMinor || 0) << 4) | (d.deviceVersionSubminor || 0);
    try { this.boardId = (await this.in(HRF.REQ.BOARD_ID, 0, 0, 1))[0]; } catch (e) { this.boardId = 0xff; }
    try { this.version = new TextDecoder().decode(await this.in(HRF.REQ.VERSION, 0, 0, 255)).replace(/\0[\s\S]*$/, "").trim(); } catch (e) { this.version = "?"; }
    try {
      const b = await this.in(HRF.REQ.PARTID_SERIAL, 0, 0, 24), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      this.serial = [8, 12, 16, 20].map((o) => dv.getUint32(o, true).toString(16).padStart(8, "0")).join("").replace(/^0+/, "");
    } catch (e) { this.serial = ""; }
    this.board = HRF.BOARDS[this.boardId] || (d.productName || "HackRF");
    this.log("board " + this.board + " (id " + this.boardId + "), firmware " + this.version + ", USB API " + this.api.toString(16).padStart(4, "0") + (this.serial ? ", serial " + this.serial : ""));
  }
  async out(request, value, index, data) {
    const setup = { requestType: "vendor", recipient: "device", request, value: value & 0xffff, index: index & 0xffff };
    const r = data ? await this.dev.controlTransferOut(setup, data) : await this.dev.controlTransferOut(setup);
    if (r.status !== "ok") throw new Error("request " + request + ": " + r.status);
  }
  async in(request, value, index, length) {
    const r = await this.dev.controlTransferIn({ requestType: "vendor", recipient: "device", request, value: value & 0xffff, index: index & 0xffff }, length);
    if (r.status !== "ok") throw new Error("request " + request + ": " + r.status);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }
  setMode(m) { return this.out(HRF.REQ.MODE, m, 0); }
  async setSampleRate(hz, bw) {
    await this.out(HRF.REQ.SAMPLE_RATE, 0, 0, new Uint8Array([...hrfLe32(Math.round(hz)), ...hrfLe32(1)]));
    const f = bw || hrfFilterBw(0.75 * hz);
    await this.out(HRF.REQ.BB_FILTER, f & 0xffff, f >>> 16);
  }
  setFreq(hz) {
    const mhz = Math.floor(hz / 1e6), rest = Math.round(hz - mhz * 1e6);
    return this.out(HRF.REQ.SET_FREQ, 0, 0, new Uint8Array([...hrfLe32(mhz), ...hrfLe32(rest)]));
  }
  async setLna(db) { const r = await this.in(HRF.REQ.LNA, 0, Math.max(0, Math.min(40, db)) & ~7, 1); if (!r[0]) throw new Error("LNA gain refused"); }
  async setVga(db) { const r = await this.in(HRF.REQ.VGA, 0, Math.max(0, Math.min(62, db)) & ~1, 1); if (!r[0]) throw new Error("VGA gain refused"); }
  setAmp(on) { return this.out(HRF.REQ.AMP, on ? 1 : 0, 0); }
  setAntennaPower(on) { return this.out(HRF.REQ.ANTENNA, on ? 1 : 0, 0); }
  // one range [a, b] MHz, one block per tuning, 20 MHz interleaved steps
  initSweep(aMHz, bMHz) {
    const n = HRF.BLOCK;
    const data = new Uint8Array([...hrfLe32(HRF.SWEEP_STEP * 1e6), ...hrfLe32(HRF.SWEEP_OFFSET), 1, aMHz & 0xff, aMHz >> 8, bMHz & 0xff, bMHz >> 8]);
    return this.out(HRF.REQ.INIT_SWEEP, n & 0xffff, n >>> 16, data);
  }
  async read(len) {
    const r = await this.dev.transferIn(1, len);
    if (r.status === "stall") { try { await this.dev.clearHalt("in", 1); } catch (e) {} throw new Error("bulk read stalled"); }
    if (r.status !== "ok") throw new Error("bulk read " + r.status);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }
  async close() {
    const d = this.dev;
    try { await this.setMode(HRF.MODE.OFF); } catch (e) {}
    try { await this.setAntennaPower(false); } catch (e) {}
    try { await this.setAmp(false); } catch (e) {}
    try { await d.releaseInterface(0); } catch (e) {}
    try { if (d.opened) await d.close(); } catch (e) {}
  }
}

// Splits the sweep byte stream into 16 KB blocks. A transfer that was in flight when the mode changed
// can leave the stream off the block grid, so a block is only taken where a valid header sits
// (0x7F 0x7F and a frequency the firmware can send for this range); otherwise the next one is searched.
class HrfSweepParser {
  constructor(aMHz, bMHz) { this.a = aMHz * 1e6; this.b = bMHz * 1e6; this.carry = null; this.resyncs = 0; }
  header(u8, p) {
    if (p + 10 > u8.length || u8[p] !== 0x7f || u8[p + 1] !== 0x7f) return -1;
    const lo = (u8[p + 2] | (u8[p + 3] << 8) | (u8[p + 4] << 16) | (u8[p + 5] << 24)) >>> 0;
    const hi = (u8[p + 6] | (u8[p + 7] << 8) | (u8[p + 8] << 16) | (u8[p + 9] << 24)) >>> 0;
    const f = hi * 4294967296 + lo;
    return f >= this.a && f < this.b && (f - this.a) % 5e6 === 0 ? f : -1;
  }
  // returns [{f, d: Uint8Array(16384)}] in stream order
  push(chunk) {
    let b = chunk;
    if (this.carry && this.carry.length) { b = new Uint8Array(this.carry.length + chunk.length); b.set(this.carry); b.set(chunk, this.carry.length); }
    const out = [], B = HRF.BLOCK; let p = 0;
    while (b.length - p >= B) {
      const f = this.header(b, p);
      if (f < 0) {
        let q = p + 1;
        while (q + 10 <= b.length && this.header(b, q) < 0) q++;
        this.resyncs++; p = q; continue;
      }
      out.push({ f, d: b.subarray(p, p + B) });
      p += B;
    }
    this.carry = b.slice(p);
    return out;
  }
}

class HackRfSource {
  constructor(hooks) {
    this.h = hooks; this.dev = null; this.hrf = null; this.open = false; this.paused = false; this.busy = false;
    this.dirty = false; this.want = null; this.cur = {}; this.geo = null; this.skip = 0; this.lastApply = 0;
    this.stats = { frames: 0, lost: 0, crc: 0, bytes: 0, restarts: 0 };
    this.fwInfo = ""; this.fft = null; this.acc = null; this.accN = 0; this.rowPos = 0; this.sw = null;
  }
  static supported() { return typeof navigator !== "undefined" && "usb" in navigator; }
  get device() { return DEV_HACKRF; }
  dbUnit() { return "dBFS"; }
  isSweep(span) { return span > 20e6; }
  binsFor() { return [1024, 2048, 4096]; }

  async connect(existing) {
    const dev = existing || await navigator.usb.requestDevice({ filters: HackRfUsb.filters });
    this.dev = dev;
    const r = new HackRfUsb(dev, (l) => this.h.log("hackrf: " + l));
    try { await r.open(); }
    catch (e) { try { if (dev.opened) await dev.close(); } catch (x) {} if (e && typeof e === "object") e.dev = dev; throw e; }
    this.hrf = r; this.open = true;
    this.canSweep = r.api >= 0x0104;
    this.fwInfo = r.version + " (" + r.board + (r.serial ? ", serial …" + r.serial.slice(-8) : "") + ")";
    this.h.onInfo(this);
    this.loop(); this.reader();
  }
  update(s) { this.want = { ...s }; this.dirty = true; }
  async pause() {
    this.paused = true; while (this.busy) await sleep(20);
    try { if (this.open) await this.hrf.setMode(HRF.MODE.OFF); } catch (e) {}
    this.cur = {}; this.h.onStatus("idle", "Stopped");
  }
  resume() { this.paused = false; this.dirty = true; }
  async loop() {
    while (this.open) {
      // a sweep restarts on every change: while dragging, apply at most ~3 times a second
      const now = performance.now(), sweepy = this.want && this.cur.mode === "sweep" && this.isSweep(this.want.span);
      if (this.dirty && !this.paused && !this.busy && (!sweepy || now - this.lastApply >= 300)) {
        this.busy = true; this.dirty = false;
        try { await this.apply(this.want); } catch (e) { this.h.log("hackrf: " + e.message); if (!this.open) break; }
        this.lastApply = performance.now(); this.busy = false;
      }
      await sleep(25);
    }
  }
  async apply(s) {
    const r = this.hrf, c = this.cur;
    let sweep = this.isSweep(s.span);
    if (sweep && !this.canSweep) { this.h.log("hackrf: this firmware has no sweep mode (USB API " + r.api.toString(16) + "), update the HackRF firmware"); this.h.onStatus("err", "Update HackRF firmware for sweep"); return; }
    const fTune = Math.round(s.freqHz * (1 - (s.ppm || 0) * 1e-6));
    let restart = false, range = null;
    if (sweep) {
      range = hrfSweepRange(fTune, s.span);
      if (c.mode !== "sweep" || c.range + "" !== range + "") {
        if (c.mode) await r.setMode(HRF.MODE.OFF);
        await r.setSampleRate(HRF.SWEEP_FS, HRF.SWEEP_BB);
        restart = true;
      }
    } else if (c.mode !== "live" || c.span !== s.span) {
      if (c.mode) await r.setMode(HRF.MODE.OFF);
      await r.setSampleRate(s.span);
      restart = true;
    }
    if (restart || c.lna !== s.lna) { await r.setLna(s.lna); c.lna = s.lna; }
    if (restart || c.vga !== s.vga) { await r.setVga(s.vga); c.vga = s.vga; }
    if (restart || c.amp !== !!s.amp) { await r.setAmp(!!s.amp); c.amp = !!s.amp; }
    if (c.bias !== !!s.bias) { await r.setAntennaPower(!!s.bias); c.bias = !!s.bias; }
    const wasSweep = c.mode === "sweep";
    if (sweep) {
      if (restart) {
        await r.initSweep(range[0], range[1]);
        this.sw = { p: new HrfSweepParser(range[0], range[1]), started: false, n: 0, t0: performance.now(), count: 0, rate: 0 };
        await r.setMode(HRF.MODE.SWEEP);
        c.mode = "sweep"; c.range = range; this.stats.restarts++;
      }
    } else {
      if (restart || c.f !== fTune) await r.setFreq(fTune);
      c.f = fTune;
      if (restart) { await r.setMode(HRF.MODE.RX); c.mode = "live"; c.span = s.span; }
    }
    this.skip = HRF.INFLIGHT;     // the transfers in flight hold data from before this change
    this.geo = { sweep, c: s.freqHz, span: s.span, bins: s.bins, maxHold: !!s.maxHold, dcFix: !!s.dcFix, range };
    this.acc = null; this.accN = 0; this.rowPos = 0;
    if (sweep !== wasSweep && this.h.onReset) this.h.onReset();
    if (!this.paused) this.h.onStatus("live", "Live");
    this.showInfo();
  }
  showInfo() {
    const g = this.geo; if (!g) return;
    const gain = "LNA " + this.cur.lna + " · VGA " + this.cur.vga + " dB" + (this.cur.amp ? " · amp on" : "") + (this.cur.bias ? " · antenna power on" : "");
    $("tuneInfo").textContent = g.sweep
      ? "Sweep " + g.range[0] + "–" + g.range[1] + " MHz, " + g.bins + " bins" + (this.sw && this.sw.rate ? ", " + this.sw.rate.toFixed(this.sw.rate < 10 ? 1 : 0) + " sweeps/s" : "") + " · " + gain
      : "I/Q " + g.span / 1e6 + " MS/s, " + g.bins + "-point FFT · " + gain;
  }
  xferLen() {
    const g = this.geo;
    if (!g || g.sweep) return 4 * HRF.BLOCK;
    return g.span >= 8e6 ? 16 * HRF.BLOCK : g.span >= 4e6 ? 8 * HRF.BLOCK : 4 * HRF.BLOCK;
  }
  async reader() {
    const q = [];
    try {
      while (this.open) {
        while (q.length < HRF.INFLIGHT) q.push(this.hrf.read(this.xferLen()));
        const u8 = await q.shift();
        this.stats.bytes += u8.length;
        if (this.skip > 0) { this.skip--; continue; }
        if (this.paused || this.busy || !this.geo) continue;
        if (this.geo.sweep) this.onSweep(u8); else this.onLive(u8);
      }
    } catch (e) {
      if (this.open) { this.open = false; this.h.log("hackrf: " + ((e && e.message) || e)); this.h.onStatus("err", "HackRF disconnected"); }
    }
    for (const p of q) p.catch(() => {});
  }
  // live: one row every 1/250 s of samples, the mean (or max) of up to 8 FFTs from it
  onLive(u8) {
    const g = this.geo, n = g.bins;
    if (!this.fft || this.fft.n !== n) this.fft = new IqFft(n);
    if (!this.acc || this.acc.length !== n) { this.acc = new Float32Array(n); this.accN = 0; this.rowPos = 0; }
    const s8 = new Int8Array(u8.buffer, u8.byteOffset, u8.byteLength);
    const R = Math.max(n, Math.round(g.span / HRF.ROWS)), M = Math.max(1, Math.min(8, Math.floor(R / n), Math.floor(24000 / n)));
    const segs = Math.floor(s8.length / (2 * n)), acc = this.acc;
    for (let k = 0; k < segs; k++) {
      if (this.accN < M) {
        const pw = this.fft.power(s8, 2 * k * n, 128, g.dcFix);
        if (g.maxHold) { for (let j = 0; j < n; j++) if (pw[j] > acc[j]) acc[j] = pw[j]; }
        else for (let j = 0; j < n; j++) acc[j] += pw[j];
        this.accN++;
      }
      this.rowPos += n;
      if (this.rowPos >= R) { this.emitLive(); this.rowPos = 0; }
    }
  }
  emitLive() {
    const g = this.geo, n = g.bins, acc = this.acc;
    if (!this.accN) return;
    const db = new Float32Array(n), k = g.maxHold ? 1 : 1 / this.accN;
    for (let j = 0; j < n; j++) { const v = acc[j] * k; db[j] = v > 1e-30 ? 10 * Math.log10(v) : -300; }
    if (g.dcFix) db[n / 2] = 10 * Math.log10(0.5 * (acc[n / 2 - 1] + acc[n / 2 + 1]) * k + 1e-30);   // the LO leak left in the DC bin
    acc.fill(0); this.accN = 0;
    this.stats.frames++;
    this.h.onSpectrum(db, n, g.span, g.c);
  }
  // sweep: every block adds its two kept quarter-bands to the row; the row is sent when the sweep wraps
  onSweep(u8) {
    const g = this.geo, sw = this.sw, nOut = g.bins;
    if (!sw.row || sw.row.length !== nOut) { sw.row = new Float32Array(nOut).fill(-140); sw.acc = new Float32Array(nOut); sw.cnt = new Uint16Array(nOut); }
    if (!sw.nf) {
      let nf = 16; while (nf < 4096 && HRF.SWEEP_FS / nf > g.span / nOut) nf *= 2;
      sw.nf = nf; sw.fft = new IqFft(nf);
    }
    const nf = sw.nf, bw = HRF.SWEEP_FS / nf, f0 = g.c - g.span / 2, scale = nOut / g.span;
    for (const blk of sw.p.push(u8)) {
      if (blk.f === sw.p.a) { if (sw.started) this.emitSweep(); sw.started = true; }
      if (!sw.started) continue;
      const s8 = new Int8Array(blk.d.buffer, blk.d.byteOffset + HRF.BLOCK - 2 * nf, 2 * nf);
      const pw = sw.fft.power(s8, 0, 128, false), lo = blk.f + HRF.SWEEP_OFFSET;
      for (const [i0, i1] of [[nf / 8 + 1, 3 * nf / 8], [5 * nf / 8 + 1, 7 * nf / 8]]) {
        for (let i = i0; i <= i1; i++) {
          const j = Math.floor((lo + (i - nf / 2) * bw - f0) * scale);
          if (j < 0 || j >= nOut) continue;
          if (g.maxHold) { if (pw[i] > sw.acc[j]) sw.acc[j] = pw[i]; sw.cnt[j] = 1; }
          else { sw.acc[j] += pw[i]; sw.cnt[j]++; }
        }
      }
    }
  }
  emitSweep() {
    const g = this.geo, sw = this.sw, n = g.bins;
    for (let j = 0; j < n; j++) if (sw.cnt[j]) { const v = sw.acc[j] / sw.cnt[j]; sw.row[j] = v > 1e-30 ? 10 * Math.log10(v) : -300; }
    sw.acc.fill(0); sw.cnt.fill(0);
    const now = performance.now(); sw.count++;
    if (now - sw.t0 >= 1000) { sw.rate = sw.count * 1000 / (now - sw.t0); sw.count = 0; sw.t0 = now; this.showInfo(); }
    this.stats.frames++;
    this.h.onSpectrum(sw.row.slice(), n, g.span, g.c);
  }
  async close() {
    if (!this.hrf) return;
    this.open = false;
    await this.hrf.close();
    this.hrf = null;
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { HRF, hrfFilterBw, hrfSweepRange, HrfSweepParser };
