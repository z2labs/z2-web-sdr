import asyncio, os, sys, pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, w, h in [("desktop", 1440, 860), ("phone", 400, 860)]:
            pg = await b.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
            errs = []
            pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(PAGE)
            await pg.wait_for_timeout(3500)
            await pg.screenshot(path=f"test/{name}.png")
            if name == "phone":
                await pg.click("#rackBtn"); await pg.wait_for_timeout(500)
                await pg.screenshot(path="test/phone_rack.png")
            sw = await pg.evaluate("document.documentElement.scrollWidth")
            print(name, "errors:", errs, "scrollWidth", sw)
        await b.close()
asyncio.run(main())
