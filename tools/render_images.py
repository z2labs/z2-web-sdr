"""Render the README banner, the social preview and the app screenshot with headless Chrome.

Usage: python tools/render_images.py [path/to/chrome]
Writes docs/banner.png (1280x320), docs/social.png (1280x640, for the repository's social preview)
and docs/screenshot.png (1440x860, the page on demo data).
"""
import os, pathlib, shutil, subprocess, sys

root = pathlib.Path(__file__).resolve().parent.parent
candidates = [sys.argv[1]] if len(sys.argv) > 1 else [
    os.environ.get("CHROME", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("chromium-browser") or "",
]
chrome = next((c for c in candidates if c and os.path.exists(c)), None)
if not chrome:
    sys.exit("Chrome or Edge not found: pass its path as the first argument")

def shot(url, out, w, h, budget_ms):
    out = root / out
    subprocess.run([chrome, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
                    f"--window-size={w},{h}", f"--virtual-time-budget={budget_ms}", f"--screenshot={out}", url],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"{out.relative_to(root)}: {out.stat().st_size // 1024} KB")

banner = (root / "docs" / "banner.html").as_uri()
shot(banner + "?w=1280&h=320", "docs/banner.png", 1280, 320, 3000)
shot(banner + "?w=1280&h=640", "docs/social.png", 1280, 640, 3000)
shot((root / "index.html").as_uri(), "docs/screenshot.png", 1440, 860, 6000)
