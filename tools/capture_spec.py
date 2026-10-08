"""Capture a raw SPEC (SPC1) stream from an ESP32-S3 running ESP-SDR firmware.

Usage: python capture_spec.py COM7 [rate_mhz] [bins] [seconds]
Writes spec_capture.bin (raw bytes after the SPEC command) and spec_capture.txt (text replies).
"""
import sys, time, re, serial

port = sys.argv[1] if len(sys.argv) > 1 else "COM7"
rate = int(sys.argv[2]) if len(sys.argv) > 2 else 40
bins = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
secs = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5
log = []

s = serial.Serial(port, 2000000, timeout=0.05)
s.dtr = True; s.rts = True
time.sleep(0.3)

def quiet():
    s.write(b"\n")
    t0 = time.time(); last = time.time()
    while time.time() - t0 < 3:
        if s.read(65536): last = time.time()
        elif time.time() - last > 0.25: break
    s.reset_input_buffer()

def cmd(c, expect, tmo=1.5):
    s.write((c + "\n").encode())
    end = time.time() + tmo; line = b""
    while time.time() < end:
        for ch in s.read(256):
            if ch == 10:
                l = line.decode("latin1").strip()
                if l.startswith(expect) or l.startswith("ERR"):
                    log.append(f"{c} -> {l}"); return l
                line = b""
            else:
                line += bytes([ch])
    log.append(f"{c} -> (timeout)"); return None

quiet()
cmd("CAPS", "CAPS")
cmd("VERSION?", "VERSION")
info = cmd("SPECINFO?", "SPECINFO") or ""
code, stride, upf = {16: (6, 2, 4), 40: (1, 5, 9), 80: (0, 14, 16)}[rate]
for m in re.finditer(r"\[([^\]]*)\]", info):
    v = [int(x) for x in re.split(r"[ ,]+", m.group(1).strip()) if re.fullmatch(r"-?\d+", x)]
    if len(v) >= 5 and v[0] == rate * 1000000 and v[2] == bins:
        code, stride, upf = v[1], v[3], v[4]
unit_us = 12288 * 1000000 // (rate * 1000000)
upf = max(upf, min(1000, 20000 // max(1, unit_us)))
cmd("FREQ 2437", "OK"); cmd("FOFS 0", "OK"); cmd("GAIN MANUAL 60", "OK")
cmd("BANDWIDTH " + ("0" if rate > 16 else "20"), "OK"); cmd("DC 0", "")
spec = f"SPEC 0 {stride} {upf} 0 {code} {bins}"
log.append("sent: " + spec)
s.write((spec + "\n").encode())
raw = bytearray(); t0 = time.time()
while time.time() - t0 < secs:
    raw += s.read(65536)
s.write(b"\n")
tail = bytearray(); t0 = time.time()
while time.time() - t0 < 2:
    tail += s.read(65536)
    m = re.search(rb"SPECEND[^\n]*\n", tail)
    if m: log.append("end: " + m.group(0).decode("latin1").strip()); break
cmd("BANDWIDTH 20", "OK"); cmd("DC 1", "")
s.close()
open("spec_capture.bin", "wb").write(raw)
log.append(f"captured {len(raw)} bytes in {secs} s")
open("spec_capture.txt", "w").write("\n".join(log) + "\n")
print("\n".join(log))
