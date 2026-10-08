import asyncio, os, sys, pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={"width": 1440, "height": 860})
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(PAGE)
        away = lambda: pg.evaluate("document.getElementById('app').classList.contains('rack-away')")
        await pg.mouse.move(600, 400)
        await pg.wait_for_timeout(2500); a1 = await away()
        await pg.wait_for_timeout(7000); a2 = await away()
        await pg.screenshot(path="test/rack_away.png")
        await pg.click("#rackTab"); await pg.wait_for_timeout(400); a3 = await away()
        # keep using it: hover keeps it out
        await pg.mouse.move(1300, 300); await pg.wait_for_timeout(9500); a4 = await away()
        await pg.click("#pinBtn"); await pg.mouse.move(600, 400); await pg.wait_for_timeout(9500); a5 = await away()
        await pg.click("#pinBtn"); await pg.mouse.move(600, 400); await pg.wait_for_timeout(9500); a6 = await away()
        await pg.mouse.move(1439, 400); await pg.wait_for_timeout(400); a7 = await away()
        await pg.keyboard.press("s"); await pg.wait_for_timeout(400); a8 = await away()
        ok = (not a1, a2, not a3, not a4, not a5, a6, not a7, a8) == (True,) * 8
        print("visible at start:", not a1, "| hidden after 8 s idle:", a2, "| tab shows:", not a3, "| hover keeps:", not a4,
              "| pinned stays:", not a5, "| unpinned hides:", a6, "| right edge shows:", not a7, "| S hides:", a8, "| errors:", errs)
        print("RACK TEST", "PASS" if ok and not errs else "FAIL")
        await b.close()
        if not ok or errs: sys.exit(1)
asyncio.run(main())
