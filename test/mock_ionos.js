// Fake Ionos SDR (ionos-sdr-mini) behind a fake Web Serial port: the USB host protocol of
// ionos-sdr/ionos-sdr docs/ionos-usb-protocol.md - IQB2 blocks with a test tone, SPC1 scan lines,
// MSG1 hello/response/status, FH/R/W/W0/CAP?/VER? commands. Test only.
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const st = window.__ionos = { cmds: [], freqHz: 433775000, decim: 8, scan: null, opens: 0, blocks: 0 };
  const FS_IN = 400000, TONE_OFF = 10000;      // tone 10 kHz above the tuned frequency
  const BLK = 1040, HDR = 16;
  let ctrl = null, timer = null, line = "", seq = 0, mseq = 0, phase = 0, hostSpoke = false, statTimer = null;
  const send = (u8) => ctrl && ctrl.enqueue(u8);
  function header(b, magic, s, nsamp, decim, fs) {
    const dv = new DataView(b.buffer);
    dv.setUint32(0, magic, true); dv.setUint32(4, s, true); dv.setUint16(8, nsamp, true); dv.setUint16(10, decim, true); dv.setUint32(12, fs, true);
  }
  function msg(type, text) {
    const b = new Uint8Array(BLK); const t = enc.encode(text);
    header(b, 0x3147534D, mseq++, t.length, type, 0); b.set(t.subarray(0, BLK - HDR), HDR); send(b);
  }
  function hello() {
    msg(1, "ionos=1\nproduct=ionos-sdr-mini\nhw=rev-b3-2l\nboard=BRD4265B\nchip=EFR32FG23\nfw_esp=test-1\nfw_fg23=0.1\n" +
           "freq_min_hz=430000000\nfreq_max_hz=440025000\nfs_in_hz=400000\ndecim_list=2,4,8,16,24,32,48,64\ngain_shift_max=0\nrssi=1\nspectrum=1\ntx=0\nmode=STANDALONE\n");
  }
  function iqBlock() {
    const b = new Uint8Array(BLK), dv = new DataView(b.buffer);
    const sps = FS_IN / st.decim, rssi = -95 & 0xFFF;
    header(b, 0x32425149, seq++, 256, st.decim, (FS_IN & 0xFFFFF) | (rssi << 20));
    for (let i = 0; i < 256; i++) {
      phase += 2 * Math.PI * TONE_OFF / sps;
      const I = 6000 * Math.cos(phase) + (Math.random() - 0.5) * 60, Q = 6000 * Math.sin(phase) + (Math.random() - 0.5) * 60;
      dv.setInt16(HDR + 4 * i, I | 0, true); dv.setInt16(HDR + 4 * i + 2, Q | 0, true);
    }
    st.blocks++; send(b);
  }
  function scanLine() {
    const sc = st.scan, b = new Uint8Array(BLK), dv = new DataView(b.buffer);
    header(b, 0x31435053, seq++, sc.nbin, 1, sc.centerHz);
    dv.setUint32(HDR, sc.spanHz, true); dv.setInt16(HDR + 4, -130, true); dv.setUint16(HDR + 6, 100, true);
    const peak = Math.round(sc.nbin * ((433.9e6 - sc.centerHz) / sc.spanHz + 0.5));
    for (let j = 0; j < sc.nbin; j++) b[HDR + 8 + j] = 70 + (Math.random() * 6 | 0);
    if (peak >= 0 && peak < sc.nbin) b[HDR + 8 + peak] = 200;
    send(b);
  }
  function startStream() {
    stopStream();
    const perBlock = 256000 / (FS_IN / st.decim);     // ms per block
    timer = setInterval(() => { for (let k = 0; k < 4; k++) (st.scan ? scanLine : iqBlock)(); }, 4 * perBlock);
  }
  function stopStream() { if (timer) { clearInterval(timer); timer = null; } }
  function onLine(l) {
    st.cmds.push(l); hostSpoke = true;
    const t = l.trim();
    if (t === "CAP?") hello();
    else if (t === "VER?") msg(0, "OK\nfw_esp=test-1\nfw_fg23=0.1\nboard=BRD4265B\n");
    else if (t.startsWith("FH")) { st.freqHz = +t.slice(2); msg(0, "OK\nf=" + st.freqHz + " (F" + Math.round(st.freqHz / 1e3) + " + o0)\n"); }
    else if (t.startsWith("R")) { let R = Math.round(FS_IN / +t.slice(1)); R = R < 3 ? 2 : R < 6 ? 4 : Math.max(8, Math.round(R / 8) * 8); st.decim = R; seq = 0; msg(0, "OK\nfs=" + (FS_IN / R) + " decim=" + R + "\n"); startStream(); }
    else if (t === "W0") { st.scan = null; seq = 0; msg(0, "OK\nforwarded: W0\n"); startStream(); }
    else if (t.startsWith("W")) { const p = t.slice(1).split(","); st.scan = { centerHz: +p[0] * 1e3, spanHz: +p[1] * 1e3, nbin: +p[2] }; seq = 0; msg(0, "OK\nforwarded: " + t + "\n"); startStream(); }
    else if (t.startsWith("MODE")) msg(0, "OK\nmode=" + t.slice(4).trim() + "\n");
    else msg(0, "ERR unknown command: " + t + "\n");
  }
  const port = {
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    async open() {
      st.opens++;
      // like a real port: cancelling the reader discards the stream and port.readable is a fresh one
      const self = this, mk = () => new ReadableStream({ start(c) { ctrl = c; }, cancel() { self.readable = mk(); } });
      this.readable = mk();
      this.writable = new WritableStream({ write(chunk) {
        for (const ch of dec.decode(chunk)) { if (ch === "\n" || ch === "\r") { const l = line; line = ""; if (l.trim()) onLine(l); } else line += ch; }
      } });
      setTimeout(hello, 50);                    // hello on connect
      startStream();                            // the FG23 streams by default
      statTimer = setInterval(() => { if (hostSpoke) msg(2, "blk_s=195.0 sps=" + (FS_IN / st.decim) + " lost=0 rssi=-95 freq_khz=" + Math.round(st.freqHz / 1e3) + " heap_min=80 usb_drop=0 mode=STANDALONE\n"); }, 2000);
    },
    async setSignals() {}, async close() { stopStream(); clearInterval(statTimer); try { ctrl && ctrl.close(); } catch (e) {} ctrl = null; }
  };
  Object.defineProperty(navigator, "serial", { value: { requestPort: async () => port, getPorts: async () => [], addEventListener() {} } });
})();
