# HackRF One source against the emulated device (test/mock_hackrf.js): connect over WebUSB, live I/Q with
# the 1 MHz test tone, sweep mode with the 433.92 MHz carrier, back to live, gain change, disconnect;
# then the Linux help card when the interface cannot be claimed.
import asyncio, os, re, sys, pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
from playwright.async_api import async_playwright

def marker_mhz(t):
    m = re.search(r"Marker ([\d.]+) MHz", t)
    return float(m.group(1)) if m else None

async def main():
    ok = True
    def check(cond, what):
        nonlocal ok
        print(("ok   " if cond else "FAIL ") + what)
        ok = ok and bool(cond)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 860})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script(path="test/mock_hackrf.js")
        await pg.goto(PAGE)
        await pg.wait_for_timeout(500)
        await pg.click("#hackrfBtn")
        await pg.wait_for_timeout(3000)
        chip = await pg.inner_text("#chipText"); fw = await pg.inner_text("#fwInfo"); tune = await pg.inner_text("#tuneInfo")
        print("chip:", chip, "| fw:", fw, "| tune:", tune)
        check(chip == "LIVE" and "2024.02.1" in fw and "HackRF One" in fw, "connected, firmware shown")
        check((await pg.inner_text("#brandDev")).lower() == "hackrf one", "brand shows the HackRF")
        check(await pg.evaluate("document.getElementById('fwBox').hidden"), "no ESP firmware installer")
        check(not await pg.evaluate("document.getElementById('hrfLna').closest('.row').hidden"), "LNA/VGA controls shown")
        reqs = await pg.evaluate("window.__hrf.reqs")
        rate = [r for r in reqs if r["req"] == "SAMPLE_RATE"]; frq = [r for r in reqs if r["req"] == "SET_FREQ"]
        check(rate and rate[-1]["rate"] == 20e6, "sample rate 20 MS/s")
        check(any(r["req"] == "BB_FILTER" and r["bw"] == 15e6 for r in reqs), "baseband filter 15 MHz")
        check(frq and frq[-1]["freq"] == 100e6, "tuned to 100 MHz")
        check(any(r["req"] == "LNA" and r["index"] == 24 for r in reqs) and any(r["req"] == "VGA" and r["index"] == 20 for r in reqs), "LNA 24, VGA 20")
        check(await pg.evaluate("window.__hrf.mode") == 1, "RX mode")
        await pg.click("#peakFind"); await pg.wait_for_timeout(200)
        m = marker_mhz(await pg.inner_text("#markerRead")); print("live marker:", m)
        check(m is not None and abs(m - 101.0) < 0.02, "live: tone at 101 MHz")
        # sweep 350-850 MHz
        await pg.fill("#freqIn", "600"); await pg.dispatch_event("#freqIn", "change")
        await pg.click("#spanSeg button[data-v='500000000']")
        await pg.wait_for_timeout(4000)
        tune = await pg.inner_text("#tuneInfo"); print("tune:", tune)
        sw = await pg.evaluate("window.__hrf.sweep"); print("sweep init:", sw)
        check(sw and sw["a"] == 350 and sw["b"] == 850 and sw["step"] == 20e6 and sw["offset"] == 7.5e6 and sw["style"] == 1 and sw["bytes"] == 16384, "INIT_SWEEP 350-850 MHz, 20 MHz interleaved")
        check(await pg.evaluate("window.__hrf.mode") == 5 and tune.startswith("Sweep 350–850 MHz"), "sweep mode running")
        await pg.click("#peakFind"); await pg.wait_for_timeout(200)
        m = marker_mhz(await pg.inner_text("#markerRead")); print("sweep marker:", m)
        check(m is not None and abs(m - 433.92) < 0.5, "sweep: carrier at 433.92 MHz")
        frames = int(await pg.inner_text("#stFrames")); print("frames (sweeps + rows):", frames)
        check(frames > 0, "sweep rows arrive")
        # back to live 10 MS/s, then a gain change
        await pg.click("#spanSeg button[data-v='10000000']")
        await pg.wait_for_timeout(1500)
        reqs = await pg.evaluate("window.__hrf.reqs")
        check(await pg.evaluate("window.__hrf.mode") == 1 and [r for r in reqs if r["req"] == "SAMPLE_RATE"][-1]["rate"] == 10e6
              and [r for r in reqs if r["req"] == "BB_FILTER"][-1]["bw"] == 7e6, "live again at 10 MS/s, 7 MHz filter")
        await pg.click("#peakFind"); await pg.wait_for_timeout(200)
        m = marker_mhz(await pg.inner_text("#markerRead")); print("live marker:", m)
        check(m is not None and abs(m - 601.0) < 0.02, "live: tone at 601 MHz")
        await pg.eval_on_selector("#hrfLna", "e => { e.value = 40; e.dispatchEvent(new Event('input')); }")
        await pg.click("#hrfAmp")
        await pg.wait_for_timeout(600)
        check(await pg.evaluate("window.__hrf.lna") == 40 and await pg.evaluate("window.__hrf.amp") == 1, "LNA 40 dB and amp applied live")
        await pg.screenshot(path="test/hackrf.png")
        await pg.click("#hackrfBtn"); await pg.wait_for_timeout(1500)
        chip = await pg.inner_text("#chipText")
        check(await pg.evaluate("window.__hrf.mode") == 0 and await pg.evaluate("window.__hrf.amp") == 0 and chip == "DEMO"
              and (await pg.inner_text("#spanUnit")) == "MHz", "disconnect: RX off, amp off, back to the demo")
        print("errors:", errs); check(not errs, "no page errors")
        # Linux: the kernel driver holds the interface
        pg2 = await b.new_page(viewport={"width": 1200, "height": 800})
        await pg2.add_init_script("window.__hrfOptions = { claimError: 'NetworkError' };")
        await pg2.add_init_script(path="test/mock_hackrf.js")
        await pg2.goto(PAGE); await pg2.wait_for_timeout(400)
        await pg2.click("#hackrfBtn"); await pg2.wait_for_timeout(800)
        card = not await pg2.evaluate("document.getElementById('hrfCard').hidden"); cmd = await pg2.inner_text("#hrfCmd")
        print("card:", card, "| note:", await pg2.inner_text("#srcNote"))
        check(card and "blacklist hackrf" in cmd and "60-z2-hackrf.rules" in cmd and (await pg2.inner_text("#chipText")) == "DEMO", "Linux help card with the commands")
        await pg2.screenshot(path="test/hackrf_linux.png")
        await b.close()
    print("PASS" if ok else "FAIL")
    if not ok: sys.exit(1)
asyncio.run(main())
