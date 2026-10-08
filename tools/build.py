"""Build index.html from src/: inline src/flasher.js and embed the firmware bundle (gzip + base64).

Usage:
  python tools/build.py [fw_dir]     build index.html (fw_dir defaults to ./fw)
  python tools/build.py --check      fail if index.html is not what src/ and fw/ produce

fw_dir is a firmware bundle as SDR++ ESP ships it (flash_args, bootloader/, partition_table/,
esp_sdr.bin, version.json), e.g. SDRPlusPlus/root/res/esp_sdr_fw.
"""
import base64, gzip, json, os, re, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
check = "--check" in sys.argv
args_ = [a for a in sys.argv[1:] if not a.startswith("--")]
fw_dir = args_[0] if args_ else os.path.join(root, "fw")

html = open(os.path.join(root, "src", "index.html"), encoding="utf-8").read()
flasher = open(os.path.join(root, "src", "flasher.js"), encoding="utf-8").read()
html = re.sub(r"(// @@flasher-begin\n).*?(// @@flasher-end)", lambda m: m.group(1) + flasher + m.group(2), html, flags=re.S)

flash_args = open(os.path.join(fw_dir, "flash_args"), encoding="utf-8").read().replace("\r\n", "\n")
files = {}
tok = flash_args.split()
for i, t in enumerate(tok[:-1]):
    if t.startswith("0x"):
        data = open(os.path.join(fw_dir, tok[i + 1]), "rb").read()
        files[tok[i + 1]] = base64.b64encode(gzip.compress(data, 9, mtime=0)).decode()
version = json.load(open(os.path.join(fw_dir, "version.json"), encoding="utf-8"))
bundle = json.dumps({"flash_args": flash_args, "version": version, "files": files}, separators=(",", ":"))
html = re.sub(r'(<script type="application/json" id="fwBundle">).*?(</script>)', lambda m: m.group(1) + bundle + m.group(2), html, flags=re.S)

out = os.path.join(root, "index.html")
def normalise(page):
    """Page text with the bundle replaced by its decoded content (gzip output differs between zlib builds)."""
    m = re.search(r'<script type="application/json" id="fwBundle">(.*?)</script>', page, flags=re.S)
    if not m:
        return page, None
    j = json.loads(m.group(1))
    files_ = {k: gzip.decompress(base64.b64decode(v)) for k, v in j.get("files", {}).items()}
    return page[:m.start(1)] + page[m.end(1):], (j.get("flash_args"), j.get("version"), files_)

if check:
    cur = open(out, encoding="utf-8").read() if os.path.exists(out) else ""
    if normalise(cur) != normalise(html):
        print("index.html is out of date: run python tools/build.py")
        sys.exit(1)
    print("index.html is up to date")
    sys.exit(0)
with open(out, "w", encoding="utf-8", newline="\n") as f:
    f.write(html)
print(f"index.html: {len(html) / 1024:.0f} KB, firmware {version.get('build_date')} {version.get('revision', '')[:7]}, "
      f"images {', '.join(files)}")
