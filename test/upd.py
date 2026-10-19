import asyncio, json
from playwright.async_api import async_playwright
W='/home/claude/polvo-app/www'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'])
        ctx = await b.new_context(viewport={'width':390,'height':844}, has_touch=True, is_mobile=True)
        mock = open('/home/claude/polvo-app/test/mock-supabase.js').read()
        cfg = "window.POLVO_CFG={url:'x',key:'y',admin:'',repo:'mecanismos-unsj/polvo'};"
        rel = json.dumps({'tag_name':'v1.9','assets':[{'name':'polvo.apk','browser_download_url':'https://example.com/polvo.apk'}]})
        async def route(r):
            u=r.request.url
            if u.endswith('vendor/supabase.js'): await r.fulfill(body=mock, content_type='text/javascript')
            elif u.endswith('polvo-config.js'): await r.fulfill(body=cfg, content_type='text/javascript')
            elif 'api.github.com' in u: await r.fulfill(body=rel, content_type='application/json')
            else: await r.continue_()
        await ctx.route('**/*', route)
        import http.server, threading, functools
        h=functools.partial(http.server.SimpleHTTPRequestHandler,directory=W); h.log_message=lambda *a:None
        srv=http.server.ThreadingHTTPServer(('127.0.0.1',8778),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
        pg = await ctx.new_page(); errs=[]
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://127.0.0.1:8778/index.html'); await asyncio.sleep(4)
        print('banner', await pg.is_visible('#updBox'), await pg.inner_text('#updBox') if await pg.is_visible('#updBox') else '')
        await pg.screenshot(path='/home/claude/polvo-app/test/upd.png')
        print(errs); await b.close(); srv.shutdown()
asyncio.run(main())
