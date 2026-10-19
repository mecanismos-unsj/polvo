#!/usr/bin/env python3
"""Arma la carpeta www/ de la app a partir del juego (el mismo archivo que se publica en Claude)."""
import json, os, shutil, sys, glob
ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'src', 'polvo.html')
W = os.path.join(ROOT, 'www')
os.makedirs(os.path.join(W, 'vendor'), exist_ok=True)
os.makedirs(os.path.join(W, 'fonts'), exist_ok=True)
nm = os.path.join(ROOT, 'node_modules')
shutil.copy(f'{nm}/three/build/three.module.min.js', f'{W}/vendor/three.module.min.js')
shutil.copy(f'{nm}/meshoptimizer/meshopt_simplifier.module.js', f'{W}/vendor/meshopt_simplifier.module.js')
shutil.copy(f'{nm}/@supabase/supabase-js/dist/umd/supabase.js', f'{W}/vendor/supabase.js')
faces = []
for fam, pkg, ws in [('Saira Extra Condensed', 'saira-extra-condensed', (500, 700, 800)), ('Saira Semi Condensed', 'saira-semi-condensed', (400, 500, 600))]:
    for w in ws:
        fn = f'{pkg}-latin-{w}-normal.woff2'
        src = f'{nm}/@fontsource/{pkg}/files/{fn}'
        if os.path.exists(src):
            shutil.copy(src, f'{W}/fonts/{fn}')
            faces.append(f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;src:url({fn}) format('woff2')}}")
open(f'{W}/fonts/fonts.css', 'w').write('\n'.join(faces) + '\n')
shutil.copy(os.path.join(ROOT, 'src', 'polvo-net.js'), f'{W}/polvo-net.js')
shutil.copy(os.path.join(ROOT, 'src', 'polvo-config.js'), f'{W}/polvo-config.js')

g = open(SRC, encoding='utf-8').read()
rep = [
    ('<link rel="preconnect" href="https://fonts.googleapis.com">\n', ''),
    ('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n', ''),
    ('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Saira+Extra+Condensed:wght@500;700;800&family=Saira+Semi+Condensed:wght@400;500;600&display=swap">', '<link rel="stylesheet" href="fonts/fonts.css">'),
    ("'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js'", "'./vendor/three.module.min.js'"),
    ("'https://cdn.jsdelivr.net/npm/meshoptimizer@0.25.0/meshopt_simplifier.module.js'", "'./vendor/meshopt_simplifier.module.js'"),
    ("'Para jugar online abrí este juego desde claude.ai con tu cuenta. Mientras tanto, podés practicar.'", "'No hay conexión con el servidor del juego. Revisá internet; mientras tanto podés practicar.'"),
]
for a, b in rep:
    if a not in g:
        sys.exit('No encontré en el juego: ' + a[:70])
    g = g.replace(a, b)
for a, b in [("abriendo el juego desde claude.ai", "con conexión a internet"), ("abrí el juego desde claude.ai", "conectate a internet")]:
    g = g.replace(a, b)
ver = int(os.environ.get('GITHUB_RUN_NUMBER', '0') or 0)
head = '''<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#15130f">
<style>:root{box-sizing:border-box}body{margin:0;padding:0;background:#15130f}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>
<script src="vendor/supabase.js"></script>
<script>window.POLVO_VERSION = ''' + str(ver) + ''';</script>
<script src="polvo-config.js"></script>
<script src="polvo-net.js"></script>
</head><body>
'''
open(f'{W}/index.html', 'w', encoding='utf-8').write(head + g + '\n</body></html>\n')

# datos iniciales: autos del catálogo y pistas de la versión de Claude
seed = {}
S = os.path.join(ROOT, 'seed')
for f in sorted(glob.glob(f'{S}/catalog/*.json')):
    cid = os.path.basename(f)[:-5]
    seed[f'catalog/{cid}'] = json.load(open(f))
    for pf in sorted(glob.glob(f'{S}/catalog/{cid}/parts/*.json')):
        seed[f'catalog/{cid}/parts/{os.path.basename(pf)[:-5]}'] = json.load(open(pf))
for f in sorted(glob.glob(f'{S}/tracks/*.json')):
    seed[f'tracks/{os.path.basename(f)[:-5]}'] = json.load(open(f))
json.dump(seed, open(f'{W}/seed.json', 'w'), separators=(',', ':'))
print('www listo:', len(seed), 'documentos de inicio,', os.path.getsize(f'{W}/index.html') // 1024, 'KB de juego')
