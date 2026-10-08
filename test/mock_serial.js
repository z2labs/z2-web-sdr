// Fake ESP-SDR firmware behind a fake Web Serial port (test only)
(() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const SPECINFO = 'SPECINFO {"continuous":true,"transports":["USB"],"profiles":[[16000000,6,256,2,1],[16000000,6,512,2,2],[16000000,6,1024,2,4],[16000000,6,2048,3,7],[40000000,1,256,5,3],[40000000,1,512,5,5],[40000000,1,1024,5,9],[40000000,1,2048,7,17],[80000000,0,256,10,6],[80000000,0,512,12,10],[80000000,0,1024,14,16],[80000000,0,2048,14,30]]}';
  const T = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[i] = c >>> 0; }
  const crc = (b, n) => { let c = 0xFFFFFFFF; for (let i = 0; i < n; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  window.__fw = { cmds: [], freq: 0, fofs: 0, span: 40e6 };
  let ctrl, timer = null, line = "", fr = 0, bins = 1024;
  const send = (u8) => ctrl && ctrl.enqueue(u8);
  const sendText = (s) => send(enc.encode(s));
  function frame() {
    const n = bins, L = 28 + n + 4, b = new Uint8Array(L), dv = new DataView(b.buffer);
    b.set([83, 80, 67, 49]); dv.setUint32(4, fr, true); dv.setUint32(16, 147686, true); dv.setUint16(20, 30, true);
    b[22] = 2; b[23] = 60; b[26] = Math.log2(n); b[27] = 2;
    const sigBin = Math.round(n * (2440e6 - (window.__fw.freq * 1e6 + window.__fw.fofs * 1e3) + window.__fw.span / 2) / window.__fw.span); // RF at 2440 MHz
    for (let j = 0; j < n; j++) b[28 + j] = 36 + (Math.random() * 6 | 0);
    // natural FFT order, mirrored: display bin d maps to code index (n/2 - d) mod n
    if (sigBin >= 0 && sigBin < n) b[28 + ((n / 2 - sigBin + n) % n)] = 90;
    dv.setUint32(L - 4, crc(b, L - 4), true);
    fr++; send(b);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; sendText("SPECEND 0 0 4873 59973926 1499351 16 36386 " + fr + " 0 46105 12370 1 0 0\n"); } }
  function onLine(l) {
    window.__fw.cmds.push(l);
    const p = l.trim().split(/\s+/);
    if (p[0] === "CAPS") sendText("CAPS VERSION GAIN SPEC SPECN IQS IQTUNE\n");
    else if (p[0] === "VERSION?") sendText('VERSION {"revision":"81452e410453321e517ab31b14c03bdecce59c7d","build_date":"2026-10-07"}\n');
    else if (p[0] === "SPECINFO?") sendText(SPECINFO + "\n");
    else if (p[0] === "FREQ") { window.__fw.freq = +p[1]; sendText("OK\n"); }
    else if (p[0] === "FOFS") { window.__fw.fofs = +p[1]; sendText("OK\n"); }
    else if (p[0] === "SPEC") { bins = +p[6]; window.__fw.span = p[5] === "0" ? 80e6 : p[5] === "1" ? 40e6 : 16e6; fr = 0; sendText("SPEC " + bins + " 40000000 12288 " + window.__fw.freq + "\n"); timer = setInterval(() => { for (let k = 0; k < 4; k++) frame(); }, 15); }
    else if (p[0]) sendText("OK\n");
  }
  const port = {
    getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
    async open() {
      this.readable = new ReadableStream({ start(c) { ctrl = c; } });
      this.writable = new WritableStream({ write(chunk) {
        const s = dec.decode(chunk);
        for (const ch of s) {
          if (timer) { stop(); line = ""; continue; }      // any byte ends a run
          if (ch === "\n") { const l = line; line = ""; if (l.trim()) onLine(l); } else line += ch;
        }
      } });
    },
    async setSignals() {}, async close() { stop(); }
  };
  Object.defineProperty(navigator, "serial", { value: { requestPort: async () => port, getPorts: async () => [], addEventListener() {} } });
})();
