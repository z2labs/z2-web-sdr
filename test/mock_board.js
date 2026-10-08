// Fake ESP32-S3 behind a fake Web Serial port: ESP-SDR app firmware (text protocol + SPC1 frames)
// when flash holds an app, ROM serial bootloader (SLIP) after the USB-JTAG reset sequence. Test only.
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const st = window.__board = { mode: "app", flash: {}, option1: 0, cmds: [], rom: [], signals: [], blank: !!window.__blankBoard, opens: 0 };
  const T = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[i] = c >>> 0; }
  const crc = (b, n) => { let c = 0xFFFFFFFF; for (let i = 0; i < n; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  let ctrl = null, timer = null, line = "", fr = 0, bins = 1024, slip = null, esc = false, flashOp = null;
  const send = (u8) => { try { ctrl && ctrl.enqueue(u8); } catch (e) {} };
  const sendText = (s) => send(enc.encode(s));
  const hasApp = () => !st.blank || !!st.flash[0x10000];
  function frame() {
    const n = bins, L = 28 + n + 4, b = new Uint8Array(L), dv = new DataView(b.buffer);
    b.set([83, 80, 67, 49]); dv.setUint32(4, fr++, true); b[26] = Math.log2(n); b[27] = 2;
    for (let j = 0; j < n; j++) b[28 + j] = 36 + (Math.random() * 6 | 0);
    dv.setUint32(L - 4, crc(b, L - 4), true); send(b);
  }
  function stopSpec() { if (timer) { clearInterval(timer); timer = null; sendText("SPECEND 0 0 1 2 3 4 5 " + fr + " 0\n"); } }
  function appLine(l) {
    st.cmds.push(l);
    if (!hasApp()) return;                                   // blank chip: nothing answers
    const p = l.trim().split(/\s+/);
    if (p[0] === "CAPS") sendText("CAPS VERSION GAIN SPEC SPECN IQS IQTUNE\n");
    else if (p[0] === "VERSION?") sendText('VERSION {"revision":"81452e410453321e517ab31b14c03bdecce59c7d","build_date":"2026-10-07","build_timestamp":"2026-10-07T20:40:32Z"}\n');
    else if (p[0] === "SPECINFO?") sendText('SPECINFO {"profiles":[[40000000,1,1024,5,9],[80000000,0,2048,14,30]]}\n');
    else if (p[0] === "SPEC") { bins = +p[6]; fr = 0; timer = setInterval(() => { for (let k = 0; k < 4; k++) frame(); }, 15); }
    else if (p[0]) sendText("OK\n");
  }
  // ---- ROM loader
  const slipOut = (bytes) => { const o = [0xC0]; for (const b of bytes) { if (b === 0xC0) o.push(0xDB, 0xDC); else if (b === 0xDB) o.push(0xDB, 0xDD); else o.push(b); } o.push(0xC0); send(new Uint8Array(o)); };
  const reply = (op, data, status = 0) => slipOut([0x01, op, (data.length + 4) & 255, (data.length + 4) >> 8, 0, 0, 0, 0, ...data, status, status ? 5 : 0, 0, 0]);
  const u32 = (a, o) => (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24)) >>> 0;
  async function romPacket(pk) {
    const op = pk[1], len = pk[2] | (pk[3] << 8), ck = u32(pk, 4), d = pk.slice(8, 8 + len);
    st.rom.push(op);
    if (op === 0x08) { for (let k = 0; k < 4; k++) reply(op, []); return; }
    if (op === 0x0D || op === 0x0B || op === 0x0F) return reply(op, []);
    if (op === 0x09) { if (u32(d, 0) === 0x6000812C) st.option1 = u32(d, 4) & u32(d, 8) | st.option1 & ~u32(d, 8); return reply(op, []); }
    if (op === 0x02) { flashOp = { size: u32(d, 0), bs: u32(d, 8), off: u32(d, 12), buf: new Uint8Array(u32(d, 0)) }; return reply(op, []); }
    if (op === 0x03) {
      const size = u32(d, 0), seq = u32(d, 4), blk = d.slice(16, 16 + size);
      let x = 0xEF; for (const b of blk) x ^= b;
      if (x !== ck) return reply(op, [], 1);
      flashOp.buf.set(blk.slice(0, Math.max(0, Math.min(size, flashOp.size - seq * flashOp.bs))), seq * flashOp.bs);
      st.flash[flashOp.off] = flashOp.buf; return reply(op, []);
    }
    if (op === 0x13) { const h = await window.__md5(Array.from(st.flash[u32(d, 0)] || [])); return reply(op, Array.from(enc.encode(h))); }
    if (op === 0x04) return reply(op, []);
    reply(op, [], 1);
  }
  function romBytes(chunk) {
    for (const b of chunk) {
      if (b === 0xC0) { if (slip && slip.length) romPacket(slip); slip = []; esc = false; continue; }
      if (!slip) continue;
      if (esc) { slip.push(b === 0xDC ? 0xC0 : 0xDB); esc = false; } else if (b === 0xDB) esc = true; else slip.push(b);
    }
  }
  let lastSig = { dtr: true, rts: true };
  const port = {
    getInfo: () => ({ usbVendorId: window.__vid || 0x303a, usbProductId: 0x1001 }),
    async open(o) {
      if (this.readable) throw new DOMException("already open", "InvalidStateError");
      st.opens++;
      this.readable = new ReadableStream({ start(c) { ctrl = c; } });
      this.writable = new WritableStream({ write(chunk) {
        if (st.mode === "rom") return romBytes(chunk);
        for (const ch of dec.decode(chunk)) {
          if (timer) { stopSpec(); line = ""; continue; }
          if (ch === "\n") { const l = line; line = ""; if (l.trim()) appLine(l); } else line += ch;
        }
      } });
    },
    async setSignals(s) {
      const dtr = s.dataTerminalReady, rts = s.requestToSend;
      st.signals.push((dtr ? 1 : 0) + "" + (rts ? 1 : 0));
      // USB-JTAG reset logic: RTS rising resets the chip; IO0 is low if DTR was high just before
      // entering DTR=0 / RTS=1 asserts reset; coming from (1,1) after IO0 was held low means download
      // boot; the force-download latch (OPTION1 bit 0) sends any reset back into the loader
      if (rts && !dtr && !(lastSig.rts && !lastSig.dtr)) {
        stopSpec();
        const download = (lastSig.dtr && lastSig.rts) || (st.option1 & 1);
        st.mode = download ? "rom" : "app"; slip = null;
        if (download) st.option1 |= 1;
      }
      lastSig = { dtr, rts };
    },
    async close() { stopSpec(); try { ctrl && ctrl.close(); } catch (e) {} this.readable = null; this.writable = null; }
  };
  Object.defineProperty(navigator, "serial", { value: { requestPort: async () => port, getPorts: async () => [port], addEventListener() {} } });
})();
