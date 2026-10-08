import asyncio, os, sys, pathlib, hashlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
from playwright.async_api import async_playwright
FW = os.path.join(ROOT, "fw") + "/"
files = {0x0: FW + "bootloader/bootloader.bin", 0x8000: FW + "partition_table/partition-table.bin", 0x10000: FW + "esp_sdr.bin"}
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width": 1440, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.expose_function("__md5", lambda arr: hashlib.md5(bytes(arr)).hexdigest())
        await pg.add_init_script("window.__blankBoard = false;")
        await pg.add_init_script(path="test/mock_board.js")
        await pg.goto(PAGE)
        await pg.wait_for_timeout(400)
        print("before:", await pg.inner_text("#flashBtn"), "|", await pg.inner_text("#fwBundleInfo"))
        await pg.click("#connectBtn")
        for _ in range(60):
            await pg.wait_for_timeout(250)
            if not await pg.is_disabled("#connectBtn"): break
        print("live before flash:", await pg.inner_text("#chipText"), "|", await pg.inner_text("#fwInfo"))
        await pg.screenshot(path="test/source_panel.png", clip={"x": 1110, "y": 60, "width": 330, "height": 420})
        print("button:", await pg.inner_text("#flashBtn"), await pg.get_attribute("#flashBtn", "class"))
        await pg.click("#flashBtn"); print("armed:", await pg.inner_text("#flashBtn"))
        await pg.click("#flashBtn")
        t0 = asyncio.get_event_loop().time()
        for _ in range(240):
            await pg.wait_for_timeout(250)
            if not await pg.is_visible("#flashProg"): break
        print(f"flash took {asyncio.get_event_loop().time() - t0:.1f} s:", await pg.inner_text("#flashResult"))
        await pg.wait_for_timeout(4000)
        st = await pg.evaluate("({mode: __board.mode, option1: __board.option1, flash: Object.fromEntries(Object.entries(__board.flash).map(([k, v]) => [k, Array.from(v)]))})")
        ok = True
        for off, path in files.items():
            want = open(path, "rb").read(); got = bytes(st["flash"].get(str(off), []))
            same = got == want; ok &= same
            print(f"  0x{off:x} {path.split('/')[-1]}: {len(got)} bytes, {'match' if same else 'MISMATCH'}")
        print("board mode after reset:", st["mode"], "option1:", st["option1"])
        print("chip:", await pg.inner_text("#chipText"), "| fw:", await pg.inner_text("#fwInfo"), "| button:", await pg.inner_text("#flashBtn"))
        print("frames:", await pg.inner_text("#stFrames"))
        await pg.screenshot(path="test/reflash_done.png")
        print("errors:", errs)
        good = ok and st["mode"] == "app" and not errs
        print("FLASH TEST", "PASS" if good else "FAIL")
        if not good: sys.exit(1)
        await b.close()
asyncio.run(main())
