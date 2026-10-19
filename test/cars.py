import asyncio, json, http.server, threading, functools
from playwright.async_api import async_playwright
W='/home/claude/polvo-app/www'
async def main():
    h=functools.partial(http.server.SimpleHTTPRequestHandler,directory=W); h.log_message=lambda *a:None
    srv=http.server.ThreadingHTTPServer(('127.0.0.1',8778),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width':900,'height':500})
        mock = open('/home/claude/polvo-app/test/mock-supabase.js').read()
        seed = open(W+'/seed.json').read()
        cfg = "window.POLVO_CFG={url:'x',key:'y',admin:'',debug:true};"
        async def route(r):
            u=r.request.url
            if u.endswith('vendor/supabase.js'): await r.fulfill(body=mock, content_type='text/javascript')
            elif u.endswith('polvo-config.js'): await r.fulfill(body=cfg, content_type='text/javascript')
            else: await r.continue_()
        await ctx.route('**/*', route)
        await ctx.add_init_script("if(!localStorage.getItem('mockdb'))localStorage.setItem('mockdb',JSON.stringify(%s));localStorage.setItem('polvo.cam2','2');" % seed)
        pg = await ctx.new_page(); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
        await pg.goto('http://127.0.0.1:8778/index.html'); await asyncio.sleep(5)
        await pg.screenshot(path='/tmp/rnd/t_menu.png')
        ids = await pg.evaluate("[...document.querySelectorAll('#cars .car')].map(b=>b.dataset.m)")
        print('cars', ids)
        await pg.click('#bSolo'); await asyncio.sleep(3)
        await pg.click('#bStart'); await asyncio.sleep(6)
        await pg.evaluate("window.__polvoInput = () => ({steer: 0.0, thr: 0.0, brk: 0, hb: 0})")
        for i,m in enumerate(ids):
            await pg.evaluate(f"(() => {{ const P=window.__polvo; P.prefs.model='{m}'; P.selRaw(); }})()")
            await asyncio.sleep(2.5)
            await pg.evaluate("window.__polvo.refreshMyCar()")
            await asyncio.sleep(1.2)
            await pg.screenshot(path=f'/tmp/rnd/t_race_{i}.png')
        print('errs', errs[:8])
        await b.close(); srv.shutdown()
asyncio.run(main())
