"""Walk a raw SPEC capture (from capture_spec.py) the same way the web client does and summarise it."""
import sys, zlib, struct
b = open(sys.argv[1] if len(sys.argv) > 1 else "spec_capture.bin", "rb").read()
print("leading text:", b[:b.find(b"SPC1")])
pos, frames, crc_bad, prev, gaps = 0, [], 0, None, 0
while True:
    i = b.find(b"SPC1", pos)
    if i < 0 or i + 28 > len(b): break
    log2n = b[i + 26]
    if not 6 <= log2n <= 12: pos = i + 4; continue
    n = 1 << log2n; L = 28 + n + 4
    if i + L > len(b): break
    pos = i + L
    if zlib.crc32(b[i:i + L - 4]) != struct.unpack_from("<I", b, i + L - 4)[0]: crc_bad += 1; continue
    fr, pidx, pairs, ffts, flags, gain, drops, l2, step = struct.unpack_from("<IQIHBBHBB", b, i + 4)
    if prev is not None and fr != prev + 1: gaps += 1
    prev = fr
    codes = b[i + 28:i + 28 + n]
    db = [(codes[(n // 2 - j) % n] / (step or 2) - 84.3) if codes[(n // 2 - j) % n] else -140 for j in range(n)]
    frames.append((fr, pairs, ffts, gain, n, step, db))
print(f"frames {len(frames)}, crc errors {crc_bad}, counter gaps {gaps}")
if len(frames) > 1:
    f0 = frames[1]
    print("frame", f0[0], "pairs", f0[1], "ffts", f0[2], "gain", f0[3], "n", f0[4], "step", f0[5])
    db = sorted(f0[6]); print("dBFS p10 %.1f median %.1f max %.1f" % (db[len(db) // 10], db[len(db) // 2], db[-1]))
