import asyncio, os
from playwright.async_api import async_playwright
W='/home/claude/polvo-app/www'
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-features=WebRtcHideLocalIpsWithMdns'])
        ctx = await b.new_context(viewport={'width':900,'height':500})
        mock = open('/home/claude/polvo-app/test/mock-supabase.js').read()
        cfg = "window.POLVO_CFG={url:'x',key:'y',admin:'',debug:true};"
        async def route(r):
            u=r.request.url
            if u.endswith('vendor/supabase.js'): await r.fulfill(body=mock, content_type='text/javascript')
            elif u.endswith('polvo-config.js'): await r.fulfill(body=cfg, content_type='text/javascript')
            else: await r.continue_()
        await ctx.route('**/*', route)
        import http.server, threading, functools
        h=functools.partial(http.server.SimpleHTTPRequestHandler,directory=W); h.log_message=lambda *a:None
        srv=http.server.ThreadingHTTPServer(('127.0.0.1',8777),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
        pages=[]; logs={0:[],1:[]}
        for i in range(2):
            pg = await ctx.new_page()
            if i==1 and os.environ.get('NORTC'): await pg.add_init_script('delete window.RTCPeerConnection; window.RTCPeerConnection = undefined;')
            pg.on('console', lambda m, i=i: logs[i].append(m.text) if ('polvo-net' in m.text or m.type=='error') else None)
            pg.on('pageerror', lambda e, i=i: logs[i].append('ERR '+str(e)))
            await pg.goto('http://127.0.0.1:8777/index.html'); pages.append(pg)
        await asyncio.sleep(3)
        A,B = pages
        print('note A:', await A.inner_text('#netNote'))
        await A.click('#bCreate'); await asyncio.sleep(1.5)
        code = (await A.inner_text('#lCode')).strip(); print('code', code)
        await B.fill('#code', code); await B.click('#bJoin'); await asyncio.sleep(6)
        for nm,pg in (('A',A),('B',B)):
            print(nm, await pg.evaluate("(() => { const P = window.__polvo; const st = P.G.net && P.G.net.r.stats ? P.G.net.r.stats() : null; return { me: P.G.myPeer, host: P.G.isHost, remotes: [...P.G.remotes.values()].map(r => ({name: r.name, act: r.active, rtt: Math.round(r.rtt||0)})), st }; })()"))
        await A.evaluate("window.__polvoInput = () => ({steer: 0, thr: 1, brk: 0, hb: 0})")
        await asyncio.sleep(3)
        print('B sees A at', await B.evaluate("(() => { const r=[...window.__polvo.G.remotes.values()][0]; return r && r.car ? [r.car.x.toFixed(1), r.car.y.toFixed(1)] : null })()"),
              'A real', await A.evaluate("[window.__polvo.G.me.car.x.toFixed(1), window.__polvo.G.me.car.y.toFixed(1)]"))
        await A.click('#bStart') if await A.is_visible('#bStart') else None
        await asyncio.sleep(2)
        print('B cfg phase', await B.evaluate("window.__polvo.G.cfg.ph"), 'racing', await B.evaluate("window.__polvo.G.racing"))
        for i in (0,1): print(i, [l for l in logs[i] if 'TUNNEL' not in l][:8])
        await b.close(); srv.shutdown()
asyncio.run(main())
