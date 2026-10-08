import os, zlib, struct, random, json
random.seed(1)
out = bytearray(b"SPEC 1024 40000000 12288 2437\n")
exp = []
for fr in range(6):
    n = 1024 if fr != 3 else 256
    codes = bytes(random.randint(0, 120) for _ in range(n))
    h = b"SPC1" + struct.pack("<IQIHBBHBB", fr, fr * 147686, 147686, 30, 2, 60, 0, n.bit_length() - 1, 2)
    body = h + codes
    frame = body + struct.pack("<I", zlib.crc32(body))
    if fr == 2: frame = bytearray(frame); frame[40] ^= 1; frame = bytes(frame)   # corrupt -> CRC error
    out += frame
    if fr != 2:
        db = [(codes[(n // 2 - j) % n] / 2 - 84.3) if codes[(n // 2 - j) % n] else -140 for j in range(n)]
        exp.append({"frame": fr, "n": n, "db": db})
out += b"SPECEND 0 0 1 2 3\n"
open(os.path.join(os.path.dirname(__file__), "stream.bin"), "wb").write(out)
json.dump(exp, open(os.path.join(os.path.dirname(__file__), "expected.json"), "w"))
