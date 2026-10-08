import asyncio, os, sys, pathlib, hashlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={"width": 1440, "height": 900})
        await pg.expose_function("__md5", lambda arr: hashlib.md5(bytes(arr)).hexdigest())
        await pg.add_init_script("window.__vid = 0x1a86;"); await pg.add_init_script(path="test/mock_board.js")
        await pg.goto(PAGE); await pg.wait_for_timeout(1500)
        print("no auto start on a bridge:", await pg.inner_text("#chipText"))
        await pg.click("#allPortsBtn"); await pg.wait_for_timeout(2500)
        print("card visible:", await pg.is_visible("#portCard"), "|", await pg.inner_text("#portCardTitle"))
        await pg.screenshot(path="test/wrongport.png")
        await b.close()
asyncio.run(main())
