import fs from "fs"; import crypto from "crypto";
const src = fs.readFileSync(new URL("../src/flasher.js", import.meta.url), "utf8");
const { md5Hex, slipEncode } = new Function(src.split("class EspFlasher")[0] + "return {md5Hex, slipEncode};")();
let ok = true;
for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 65537, 671872]) {
  const b = crypto.randomBytes(n);
  if (md5Hex(new Uint8Array(b)) !== crypto.createHash("md5").update(b).digest("hex")) { ok = false; console.log("md5 mismatch at", n); }
}
const fw = fs.readFileSync(new URL("../fw/esp_sdr.bin", import.meta.url));
ok = ok && md5Hex(new Uint8Array(fw)) === crypto.createHash("md5").update(fw).digest("hex");
const s = slipEncode([1, 0xC0, 2, 0xDB, 3]);
ok = ok && Array.from(s).join() === [0xC0, 1, 0xDB, 0xDC, 2, 0xDB, 0xDD, 3, 0xC0].join();
console.log(ok ? "md5/slip PASS" : "FAIL"); if (!ok) process.exit(1);
