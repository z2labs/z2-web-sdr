// Fake HackRF One behind a fake WebUSB (navigator.usb). Follows the firmware closely enough for the page:
// vendor requests (mode, sample rate, filter, frequency, LNA/VGA/amp/antenna, board id, version, serial,
// init sweep), RX = int8 I/Q with a tone 1 MHz above the tuned frequency and a DC offset (LO leak),
// RX_SWEEP = 16 KB blocks with the 0x7F 0x7F + u64 frequency header, interleaved steps as usb_api_sweep.c,
// with a carrier at 433.92 MHz. Bulk reads stay pending while the mode is OFF. Test only.
// window.__hrfOptions = { claimError: "NetworkError" | "SecurityError", api: 0x0109 } before this script runs.
(() => {
  const o = Object.assign({ api: 0x0109, claimError: null }, window.__hrfOptions || {});
  const st = window.__hrf = { reqs: [], mode: 0, rate: 0, bw: 0, freq: 0, lna: 0, vga: 0, amp: 0, ant: 0, sweep: null, reads: 0, opened: false };
  const CARRIERS = [{ f: 433.92e6, a: 40 }, { f: 1090e6, a: 30 }];
  const NOISE = new Int8Array(1 << 16); { let r = 12345; for (let i = 0; i < NOISE.length; i++) { r = (r * 1103515245 + 12345) >>> 0; NOISE[i] = ((r >>> 16) % 7) - 3; } }
  let phase = 0, noisePos = 0, pending = [];
  const sweepState = { f: 0, odd: true };
  const name = (r) => ({ 1: "MODE", 6: "SAMPLE_RATE", 7: "BB_FILTER", 14: "BOARD_ID", 15: "VERSION", 16: "SET_FREQ", 17: "AMP", 18: "SERIAL", 19: "LNA", 20: "VGA", 23: "ANTENNA", 26: "INIT_SWEEP" }[r] || "REQ" + r);
  const okIn = (bytes) => ({ status: "ok", data: new DataView(new Uint8Array(bytes).buffer) });
  function fillRx(len) {
    const b = new Int8Array(len), w = 2 * Math.PI * 1e6 / (st.rate || 10e6);
    for (let i = 0; i < len; i += 2) {
      phase += w;
      b[i] = Math.round(30 * Math.cos(phase) + 6 + NOISE[noisePos++ & 0xffff]);
      b[i + 1] = Math.round(30 * Math.sin(phase) - 4 + NOISE[noisePos++ & 0xffff]);
    }
    return new Uint8Array(b.buffer);
  }
  function sweepBlock() {
    const sw = st.sweep, B = 16384, b = new Uint8Array(B), s8 = new Int8Array(b.buffer);
    const f = sweepState.f, lo = f + sw.offset;
    b[0] = 0x7f; b[1] = 0x7f;
    let v = f; for (let k = 2; k < 10; k++) { b[k] = v % 256; v = Math.floor(v / 256); }
    const tones = CARRIERS.filter((c) => Math.abs(c.f - lo) < 9.5e6);
    for (let i = 10, n = 0; i + 1 < B; i += 2, n++) {
      let I = NOISE[noisePos++ & 0xffff], Q = NOISE[noisePos++ & 0xffff];
      for (const t of tones) { const ph = 2 * Math.PI * (t.f - lo) / 20e6 * n; I += t.a * Math.cos(ph); Q += t.a * Math.sin(ph); }
      s8[i] = Math.round(I); s8[i + 1] = Math.round(Q);
    }
    // next frequency (INTERLEAVED, one range)
    const stop = sw.b * 1e6, step = sw.step;
    if (!sweepState.odd && f + step >= stop) sweepState.f = sw.a * 1e6;
    else sweepState.f += sweepState.odd ? step / 4 : 3 * step / 4;
    sweepState.odd = !sweepState.odd;
    return b;
  }
  function serve() {
    if (st.mode !== 1 && st.mode !== 5) return;
    const now = performance.now();
    while (pending.length && pending[0].at <= now) {
      const p = pending.shift(); st.reads++;
      if (st.mode === 1) p.res({ status: "ok", data: new DataView(fillRx(p.len).buffer) });
      else { const out = new Uint8Array(p.len); for (let k = 0; k < p.len; k += 16384) out.set(sweepBlock(), k); p.res({ status: "ok", data: new DataView(out.buffer) }); }
      if (pending.length) pending[0].at = Math.max(pending[0].at, performance.now() + 15);
    }
  }
  setInterval(serve, 5);
  const dev = {
    vendorId: 0x1d50, productId: 0x6089, productName: "HackRF One", manufacturerName: "Great Scott Gadgets", serialNumber: "0000000000000000a06063c8234e925f",
    deviceVersionMajor: o.api >> 8, deviceVersionMinor: (o.api >> 4) & 0xf, deviceVersionSubminor: o.api & 0xf,
    opened: false, configuration: null,
    async open() { this.opened = true; st.opened = true; },
    async close() { this.opened = false; st.opened = false; for (const p of pending.splice(0)) p.rej(new DOMException("The device was closed.", "NetworkError")); },
    async selectConfiguration(v) { this.configuration = { configurationValue: v }; },
    async claimInterface() { if (o.claimError) throw new DOMException(o.claimError === "SecurityError" ? "Access denied." : "Unable to claim interface.", o.claimError); },
    async releaseInterface() { for (const p of pending.splice(0)) p.rej(new DOMException("The transfer was cancelled.", "AbortError")); },
    async clearHalt() {},
    async controlTransferIn(s, len) {
      st.reqs.push({ dir: "in", req: name(s.request), value: s.value, index: s.index });
      if (s.request === 14) return okIn([2]);
      if (s.request === 15) return okIn([...new TextEncoder().encode("2024.02.1"), 0]);
      if (s.request === 18) { const b = new Uint8Array(24); const dv = new DataView(b.buffer); dv.setUint32(16, 0xa06063c8, true); dv.setUint32(20, 0x234e925f, true); return okIn(b); }
      if (s.request === 19) { st.lna = s.index; return okIn([1]); }
      if (s.request === 20) { st.vga = s.index; return okIn([1]); }
      return { status: "stall" };
    },
    async controlTransferOut(s, data) {
      const u8 = data ? new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength) : new Uint8Array(0), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const r = { dir: "out", req: name(s.request), value: s.value, index: s.index };
      if (s.request === 1) { st.mode = s.value; if (s.value === 5) { sweepState.f = st.sweep.a * 1e6; sweepState.odd = true; } }
      if (s.request === 6) { st.rate = dv.getUint32(0, true) / dv.getUint32(4, true); r.rate = st.rate; }
      if (s.request === 7) { st.bw = s.value | (s.index << 16); r.bw = st.bw; }
      if (s.request === 16) { st.freq = dv.getUint32(0, true) * 1e6 + dv.getUint32(4, true); r.freq = st.freq; }
      if (s.request === 17) st.amp = s.value;
      if (s.request === 23) st.ant = s.value;
      if (s.request === 26) { st.sweep = { bytes: s.value | (s.index << 16), step: dv.getUint32(0, true), offset: dv.getUint32(4, true), style: u8[8], a: dv.getUint16(9, true), b: dv.getUint16(11, true) }; r.sweep = st.sweep; }
      st.reqs.push(r);
      return { status: "ok", bytesWritten: u8.length };
    },
    transferIn(ep, len) {
      return new Promise((res, rej) => { pending.push({ len, res, rej, at: performance.now() + 10 }); });
    },
  };
  const listeners = {};
  const usb = {
    async requestDevice() { return dev; },
    async getDevices() { return window.__hrfAllowed ? [dev] : []; },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {},
  };
  Object.defineProperty(navigator, "usb", { value: usb, configurable: true });
  window.__hrfUnplug = () => { for (const f of listeners.disconnect || []) f({ device: dev }); };
})();
