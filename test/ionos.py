# Ionos SDR source against the emulated board (test/mock_ionos.js): detection, I/Q spectrum with the
# 10 kHz test tone, scan mode, no firmware offer, disconnect back to the demo.
import asyncio, os, sys, pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 860})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script(path="test/mock_ionos.js")
        await pg.goto(PAGE)
        await pg.wait_for_timeout(500)
        await pg.click("#connectBtn")
        await pg.wait_for_timeout(3500)
        chip = await pg.inner_text("#chipText"); fw = await pg.inner_text("#fwInfo"); tune = await pg.inner_text("#tuneInfo")
        print("chip:", chip, "| fw:", fw)
        print("tune:", tune)
        print("fw box hidden:", await pg.evaluate("document.getElementById('fwBox').hidden"),
              "| gain row hidden:", await pg.evaluate("document.getElementById('gainRow').hidden"))
        print("span unit:", await pg.inner_text("#spanUnit"), "| freq:", await pg.input_value("#freqIn"))
        await pg.click("#peakFind"); await pg.wait_for_timeout(200)
        marker = await pg.inner_text("#markerRead"); print("marker:", marker)
        ok = chip == "LIVE" and "Ionos" in fw and tune.startswith("I/Q 50.0 ksps") and "433.785" in marker
        # 200 ksps I/Q (R = 2, firmware with decim_list starting at 2)
        await pg.click("#spanSeg button[data-v='200000']")
        await pg.wait_for_timeout(2500)
        tune200 = await pg.inner_text("#tuneInfo"); print("tune:", tune200)
        await pg.click("#peakFind"); await pg.wait_for_timeout(200)
        marker200 = await pg.inner_text("#markerRead"); print("marker:", marker200)
        ok = ok and tune200.startswith("I/Q 200.0 ksps") and "433.785" in marker200
        # 1 MHz scan
        await pg.click("#spanSeg button[data-v='1000000']")
        await pg.wait_for_timeout(2500)
        tune2 = await pg.inner_text("#tuneInfo"); print("tune:", tune2)
        await pg.click("#peakFind"); await pg.wait_for_timeout(200)
        marker2 = await pg.inner_text("#markerRead"); print("marker:", marker2)
        cmds = await pg.evaluate("window.__ionos.cmds"); print("board saw:", cmds)
        ok = ok and tune2.startswith("Scan 1 MHz") and "433.9" in marker2 and any(c.startswith("W433775,1000,") for c in cmds)
        stats = [await pg.inner_text(s) for s in ["#stFps", "#stFrames", "#stLost", "#stCrc", "#stRestarts"]]
        print("stats:", stats)
        # seq restarts at 0 on R/W/W0: counted as restarts, never as lost blocks
        ok = ok and stats[2] == "0" and int(stats[4]) >= 1
        brand = await pg.inner_text("#brandDev"); print("brand:", brand); ok = ok and brand.lower() == "ionos sdr"
        await pg.screenshot(path="test/ionos.png")
        await pg.click("#connectBtn"); await pg.wait_for_timeout(1500)
        cmds = await pg.evaluate("window.__ionos.cmds")
        print("after disconnect, last cmds:", cmds[-2:], "| chip:", await pg.inner_text("#chipText"), "| span unit:", await pg.inner_text("#spanUnit"))
        ok = ok and cmds[-1] == "W0" and (await pg.inner_text("#spanUnit")) == "MHz"
        print("errors:", errs, "|", "PASS" if ok and not errs else "FAIL")
        await b.close()
        if errs or not ok: sys.exit(1)
asyncio.run(main())
