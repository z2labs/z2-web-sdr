// Unit tests for src/hackrf.js: baseband filter choice, sweep range, sweep block parser (incl. resync).
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { HRF, hrfFilterBw, hrfSweepRange, HrfSweepParser } = require("../src/hackrf.js");
let fails = 0;
const eq = (a, b, what) => { const ok = JSON.stringify(a) === JSON.stringify(b); console.log((ok ? "ok   " : "FAIL ") + what + (ok ? "" : ": " + JSON.stringify(a) + " != " + JSON.stringify(b))); if (!ok) fails++; };
// libhackrf: widest filter <= 0.75 x rate
eq([2e6, 4e6, 10e6, 20e6].map((r) => hrfFilterBw(0.75 * r)), [1.75e6, 2.5e6, 7e6, 15e6], "baseband filter for 2/4/10/20 MS/s");
eq(hrfFilterBw(1e6), 1.75e6, "filter below the table");
eq(hrfSweepRange(600e6, 500e6), [350, 850], "sweep range 350-850");
eq(hrfSweepRange(3000e6, 6000e6), [0, 6000], "sweep range 0-6000");
eq(hrfSweepRange(100e6, 100e6), [50, 150], "sweep range 50-150");
eq(hrfSweepRange(2437e6, 105e6), [2384, 2504], "sweep range rounded up to 20 MHz steps");
// blocks: header + filler, firmware order a, a+5, a+20, a+25, ... (MHz)
const block = (fHz, fill) => { const b = new Uint8Array(HRF.BLOCK).fill(fill); b[0] = 0x7f; b[1] = 0x7f; let v = fHz; for (let k = 2; k < 10; k++) { b[k] = v % 256; v = Math.floor(v / 256); } return b; };
const cat = (...xs) => { const n = xs.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
const fs = [350, 355, 370, 375].map((m) => m * 1e6);
let p = new HrfSweepParser(350, 850);
let got = p.push(cat(...fs.map((f) => block(f, 3)))).map((b) => b.f);
eq(got, fs, "four aligned blocks");
// split across transfers
p = new HrfSweepParser(350, 850);
const all = cat(...fs.map((f) => block(f, 3)));
got = [...p.push(all.subarray(0, 20000)), ...p.push(all.subarray(20000, 40000)), ...p.push(all.subarray(40000))].map((b) => b.f);
eq(got, fs, "blocks split across transfers");
// off the grid: 5000 bytes of live data in front, a 7F 7F with a wrong frequency in the junk
p = new HrfSweepParser(350, 850);
const junk = new Uint8Array(5000).fill(1); junk[100] = 0x7f; junk[101] = 0x7f;
got = p.push(cat(junk, all)).map((b) => b.f);
eq(got, fs, "resync after junk");
eq(p.resyncs > 0, true, "resync counted");
// outside the range or not on the 5 MHz grid: not a header
p = new HrfSweepParser(350, 850);
eq(p.push(cat(block(900e6, 0), block(351e6, 0))).length, 0, "headers outside the range / grid are ignored");
if (fails) { console.log(fails + " failed"); process.exit(1); } else console.log("all passed");
