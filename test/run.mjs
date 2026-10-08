import fs from "fs";
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const a = html.indexOf("// ---------------------------------------------------------------- CRC32");
const b = html.indexOf("// ---------------------------------------------------------------- Web Serial source");
const code = html.slice(a, b) + "\nreturn { parseSpc1, parseProfiles, ByteBuf };";
const { parseSpc1, parseProfiles, ByteBuf } = new Function(code)();
const raw = new Uint8Array(fs.readFileSync(new URL("./stream.bin", import.meta.url)));
const exp = JSON.parse(fs.readFileSync(new URL("./expected.json", import.meta.url)));
// feed in odd-sized chunks like a serial port would
const bb = new ByteBuf(); const got = []; let crc = 0;
for (let i = 0; i < raw.length; i += 777) {
  bb.push(raw.subarray(i, i + 777));
  const r = parseSpc1(bb.b, bb.n, false); bb.drop(r.consumed); crc += r.crcErrors; got.push(...r.frames);
}
let ok = got.length === exp.length && crc === 1;
for (let k = 0; k < Math.min(got.length, exp.length); k++) {
  const g = got[k], e = exp[k];
  if (g.frame !== e.frame || g.n !== e.n) ok = false;
  for (let j = 0; j < e.n; j++) if (Math.abs(g.db[j] - e.db[j]) > 1e-4) { ok = false; console.log("mismatch", k, j, g.db[j], e.db[j]); break; }
}
console.log("frames", got.map(f => f.frame + "/" + f.n).join(" "), "crcErrors", crc, ok ? "PASS" : "FAIL");
if (!ok) process.exit(1);
const prof = parseProfiles('SPECINFO {"continuous":true,"transports":["USB"],"profiles":[[16000000,6,256,2,1],[40000000,1,1024,5,9],[80000000,0,2048,14,30]]}');
console.log("profiles", JSON.stringify(prof));
