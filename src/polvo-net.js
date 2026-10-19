// POLVO · capa de red para la app de Android
// Reemplaza los servicios de Claude (sala, base de datos y usuario) por:
//   · Supabase: cuentas, catálogo de autos, pistas, autos pintados y la "presentación" entre teléfonos
//   · WebRTC: la carrera en sí, con conexión directa entre teléfonos (sin pasar por ningún servidor)
// El juego habla con esto a través de window.claude.use('room' | 'db' | 'user'), igual que en claude.ai.
(() => {
  'use strict';
  const CFG = window.POLVO_CFG || {};
  const log = (...a) => { if (CFG.debug) console.log('[polvo-net]', ...a); };
  window.__POLVO_APP = true;

  let sb = null, session = null;
  const ready = (async () => {
    if (!CFG.url || !CFG.key || !window.supabase) throw new Error('sin configuración');
    sb = window.supabase.createClient(CFG.url, CFG.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'polvo.auth' },
      realtime: { params: { eventsPerSecond: 40 } },
    });
    const { data } = await sb.auth.getSession();
    session = data && data.session;
    if (!session) {
      const r = await sb.auth.signInAnonymously();
      if (r.error) throw r.error;
      session = r.data.session;
    }
    sb.auth.onAuthStateChange((_ev, s) => { session = s; });
    return sb;
  })();
  ready.catch((e) => console.warn('[polvo-net] sin servidor:', e && e.message));

  const isAdmin = () => !!(session && session.user && !session.user.is_anonymous && CFG.admin &&
    String(session.user.email || '').toLowerCase() === String(CFG.admin).toLowerCase());
  const errOf = (e) => { const x = new Error((e && e.message) || 'error'); x.code = e && /row-level security|permission|42501/i.test(e.message + ' ' + e.code) ? 'invalid_argument' : (e && e.code) || 'error'; return x; };

  // ===================================================================
  // BASE DE DATOS: una tabla "docs" con documentos por ruta (catalog/x, tracks/y, bodies/z, data/users/u/...)
  // ===================================================================
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const idOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  const snapOf = (path, data) => ({ id: idOf(path), exists: data != null, data: () => (data == null ? undefined : JSON.parse(JSON.stringify(data))) });
  const db = {
    doc(path) {
      return {
        async get() {
          const { data, error } = await sb.from('docs').select('data').eq('path', path).maybeSingle();
          if (error) throw errOf(error);
          return snapOf(path, data ? data.data : null);
        },
        async set(v) {
          const { error } = await sb.from('docs').upsert({ path, data: v }, { onConflict: 'path' });
          if (error) throw errOf(error);
        },
        async update(v) {
          const cur = await this.get();
          const merged = Object.assign({}, cur.exists ? cur.data() : {}, v);
          const { error } = await sb.from('docs').upsert({ path, data: merged }, { onConflict: 'path' });
          if (error) throw errOf(error);
        },
        async delete() {
          const { error } = await sb.from('docs').delete().eq('path', path);
          if (error) throw errOf(error);
        },
      };
    },
    collection(coll) {
      return {
        onSnapshot(fn, onErr) {
          let alive = true, ch = null;
          (async () => {
            const { data, error } = await sb.from('docs').select('path,data').eq('coll', coll);
            if (!alive) return;
            if (error) { if (onErr) onErr(errOf(error)); return; }
            const changes = (data || []).map((r) => ({ type: 'added', doc: snapOf(r.path, r.data) }));
            fn({ docChanges: () => changes });
            ch = sb.channel('docs:' + coll + ':' + Math.random().toString(36).slice(2, 8))
              .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'docs', filter: 'coll=eq.' + coll }, (p) => fn({ docChanges: () => [{ type: 'added', doc: snapOf(p.new.path, p.new.data) }] }))
              .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'docs', filter: 'coll=eq.' + coll }, (p) => fn({ docChanges: () => [{ type: 'modified', doc: snapOf(p.new.path, p.new.data) }] }))
              .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'docs' }, (p) => { const o = p.old || {}; if (o.path && parentOf(o.path) === coll) fn({ docChanges: () => [{ type: 'removed', doc: snapOf(o.path, null) }] }); })
              .subscribe();
          })().catch((e) => onErr && onErr(errOf(e)));
          return () => { alive = false; if (ch) sb.removeChannel(ch); };
        },
      };
    },
  };

  // ===================================================================
  // USUARIO
  // ===================================================================
  const user = {
    async id() { return session && session.user ? session.user.id : null; },
    async canEdit() { return isAdmin(); },
    async isOwner() { return isAdmin(); },
  };

  // ===================================================================
  // SALA: Supabase solo presenta a los teléfonos; la carrera va por WebRTC directo
  // ===================================================================
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }].concat(CFG.turn ? [CFG.turn] : []);
  const room = {
    async join(name) {
      // el id empieza por la hora de entrada: el que llegó primero queda primero al elegir anfitrión
      const me = 'p' + Date.now().toString(36).padStart(9, '0') + Math.random().toString(36).slice(2, 6);
      const peers = new Map();   // id -> { pc, dc, presence, last, joinedSent, timer }
      const peerFns = [], connFns = [];
      let myP = null, lastSend = 0, lastRelay = 0, closed = false, connected = false;
      const ch = sb.channel('polvo:' + name, { config: { broadcast: { self: false, ack: false }, presence: { key: me } } });

      const view = (id, p) => ({ peer: id, kind: 'viewer', sameTab: false, presence: p.presence });
      const selfView = () => ({ peer: me, kind: 'viewer', sameTab: true, presence: myP || {} });
      const emit = (joined, updated, left) => {
        const all = [selfView()];
        for (const [id, p] of peers) if (p.presence) all.push(view(id, p));
        const ev = { peers: all, joined, updated, left };
        for (const f of peerFns) { try { f(ev); } catch (e) { console.error(e); } }
      };
      const gotPresence = (id, pres) => {
        if (closed || id === me || !pres) return;
        let p = peers.get(id);
        if (!p) { p = { pc: null, dc: null }; peers.set(id, p); }
        const isNew = !p.presence;
        p.presence = pres; p.last = performance.now();
        if (isNew) emit([view(id, p)], [], []); else emit([], [view(id, p)], []);
      };
      const drop = (id) => {
        const p = peers.get(id); if (!p) return;
        try { p.dc && p.dc.close(); } catch (e) { /* nada */ }
        try { p.pc && p.pc.close(); } catch (e) { /* nada */ }
        clearTimeout(p.timer);
        peers.delete(id);
        if (p.presence) emit([], [], [{ peer: id, kind: 'viewer', sameTab: false, presence: p.presence }]);
      };
      const sig = (to, d) => ch.send({ type: 'broadcast', event: 'sig', payload: { to, from: me, d } });
      const wireDC = (id, dc) => {
        const p = peers.get(id); if (!p) return;
        p.dc = dc;
        dc.onmessage = (e) => { try { gotPresence(id, JSON.parse(e.data)); } catch (err) { /* mensaje roto */ } };
        dc.onopen = () => { log('canal directo con', id); if (myP) try { dc.send(JSON.stringify(myP)); } catch (err) { /* nada */ } };
      };
      const makePC = (id, initiator) => {
        let p = peers.get(id);
        if (!p) { p = { pc: null, dc: null }; peers.set(id, p); }
        if (p.pc) { try { p.pc.close(); } catch (e) { /* nada */ } }
        let pc;
        try { pc = new RTCPeerConnection({ iceServers: ICE }); } catch (e) { p.pc = null; return null; } // sin WebRTC: queda el respaldo
        p.pc = pc; p.dc = null;
        pc.onicecandidate = (e) => { if (e.candidate) sig(id, { c: e.candidate.toJSON() }); };
        pc.onconnectionstatechange = () => {
          log(id, pc.connectionState);
          if (pc.connectionState === 'failed') retry(id);
        };
        if (initiator) {
          wireDC(id, pc.createDataChannel('s', { ordered: false, maxRetransmits: 0 }));
          pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => sig(id, { sdp: pc.localDescription.toJSON() })).catch((e) => log('offer', e));
        } else pc.ondatachannel = (e) => wireDC(id, e.channel);
        clearTimeout(p.timer);
        p.timer = setTimeout(() => { if (!p.dc || p.dc.readyState !== 'open') retry(id); }, 9000);
        return pc;
      };
      const retry = (id) => { if (closed || !peers.has(id)) return; if (me < id) makePC(id, true); else sig(id, { again: 1 }); };
      ch.on('broadcast', { event: 'sig' }, async ({ payload }) => {
        const { to, from, d } = payload || {};
        if (to !== me || !from || !d || closed) return;
        try {
          if (d.again) { if (me < from) makePC(from, true); return; }
          if (d.sdp && d.sdp.type === 'offer') {
            const pc = makePC(from, false); if (!pc) return;
            await pc.setRemoteDescription(d.sdp);
            await pc.setLocalDescription(await pc.createAnswer());
            sig(from, { sdp: pc.localDescription.toJSON() });
            const p = peers.get(from); for (const c of p.pend || []) await pc.addIceCandidate(c).catch(() => {}); p.pend = [];
          } else if (d.sdp && d.sdp.type === 'answer') {
            const p = peers.get(from); if (!p || !p.pc) return;
            await p.pc.setRemoteDescription(d.sdp);
            for (const c of p.pend || []) await p.pc.addIceCandidate(c).catch(() => {}); p.pend = [];
          } else if (d.c) {
            const p = peers.get(from); if (!p || !p.pc) return;
            if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.c).catch(() => {}); else (p.pend = p.pend || []).push(d.c);
          }
        } catch (e) { log('señal', e); }
      });
      // respaldo: si con alguien no hay canal directo, el estado viaja por Supabase a menor frecuencia
      ch.on('broadcast', { event: 'pr' }, ({ payload }) => {
        if (!payload || payload.from === me) return;
        const p = peers.get(payload.from);
        if (p && p.dc && p.dc.readyState === 'open') return;
        gotPresence(payload.from, payload.p);
      });
      ch.on('presence', { event: 'sync' }, () => {
        const st = ch.presenceState();
        const ids = Object.keys(st).filter((k) => k !== me);
        for (const id of ids) { const p = peers.get(id); if (!p || !p.pc) { if (me < id) makePC(id, true); else if (!p) peers.set(id, { pc: null, dc: null }); } }
        for (const [id, p] of [...peers]) if (!ids.includes(id) && !(p.dc && p.dc.readyState === 'open')) drop(id);
      });
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), 12000);
        ch.subscribe(async (status) => {
          const ok = status === 'SUBSCRIBED';
          if (ok) { clearTimeout(t); try { await ch.track({ at: Date.now() }); } catch (e) { /* nada */ } res(); }
          if (connected !== ok) { connected = ok; for (const f of connFns) try { f(ok); } catch (e) { /* nada */ } }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); rej(Object.assign(new Error(status), { code: status })); }
        });
      });
      // limpieza de pares que dejaron de mandar
      const gc = setInterval(() => { const t = performance.now(); for (const [id, p] of peers) if (p.presence && t - p.last > 12000) drop(id); }, 3000);
      setTimeout(() => emit([], [], []), 0);
      return {
        onPeers(fn, onErr) { peerFns.push(fn); setTimeout(() => emit([], [], []), 0); return () => { const i = peerFns.indexOf(fn); if (i >= 0) peerFns.splice(i, 1); }; },
        onConnection(fn) { connFns.push(fn); setTimeout(() => fn(connected), 0); return () => { const i = connFns.indexOf(fn); if (i >= 0) connFns.splice(i, 1); }; },
        async presence(obj) {
          myP = obj;
          const t = performance.now();
          if (t - lastSend < 33) return; // ~30 por segundo
          lastSend = t;
          const msg = JSON.stringify(obj);
          let missing = false;
          for (const [, p] of peers) {
            if (p.dc && p.dc.readyState === 'open') { try { p.dc.send(msg); } catch (e) { missing = true; } } else missing = true;
          }
          if (missing && t - lastRelay > 125) { lastRelay = t; ch.send({ type: 'broadcast', event: 'pr', payload: { from: me, p: obj } }); }
        },
        async leave() {
          closed = true; clearInterval(gc);
          for (const id of [...peers.keys()]) { const p = peers.get(id); try { p.dc && p.dc.close(); p.pc && p.pc.close(); } catch (e) { /* nada */ } clearTimeout(p.timer); }
          peers.clear();
          try { await ch.untrack(); } catch (e) { /* nada */ }
          sb.removeChannel(ch);
        },
        // para el diagnóstico en pantalla
        stats() { let direct = 0, relay = 0; const dbg = []; for (const [id, p] of peers) dbg.push([id, p.dc && p.dc.readyState, p.pc && p.pc.connectionState]); for (const [, p] of peers) if (p.dc && p.dc.readyState === 'open') direct++; else if (p.presence) relay++; return { direct, relay, dbg }; },
      };
    },
  };

  window.claude = {
    async use(name) {
      try { await ready; } catch (e) { return null; }
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'room') return room;
      return null;
    },
  };

  // ===================================================================
  // CUENTA DEL DUEÑO (para publicar autos en el catálogo) e importación de los datos de Claude
  // ===================================================================
  function accountUi() {
    const row = document.getElementById('mTools') || document.querySelector('#menu .row');
    const full = document.getElementById('bFull'); if (full) full.hidden = true;
    const st = document.createElement('style'); st.textContent = '#touch [data-k="fs"]{display:none!important}'; document.head.appendChild(st);
    if (!row || document.getElementById('bAccount')) return;
    const b = document.createElement('button'); b.className = 'btn sm'; b.id = 'bAccount'; b.textContent = 'Cuenta';
    row.appendChild(b);
    const panel = document.createElement('section');
    panel.className = 'panel keyspanel'; panel.id = 'accPanel'; panel.hidden = true; panel.setAttribute('aria-label', 'Cuenta');
    panel.innerHTML = `<h2>Cuenta</h2>
      <p class="note" id="accState"></p>
      <div id="accForm" style="display:grid;gap:8px">
        <input class="field" id="accEmail" type="email" placeholder="Email" autocomplete="username">
        <input class="field" id="accPass" type="password" placeholder="Contraseña (mínimo 6)" autocomplete="current-password">
        <div class="row"><button class="btn primary" id="accIn">Entrar</button><button class="btn" id="accUp">Crear cuenta</button></div>
        <p class="note">Solo hace falta para el dueño del juego (para publicar autos). Los demás juegan como invitados.</p>
      </div>
      <div class="row" id="accOut" hidden><button class="btn" id="accLogout">Cerrar sesión</button></div>
      <div id="accAdmin" hidden style="display:grid;gap:8px">
        <p class="label" style="margin:0">Dueño</p>
        <button class="btn sm" id="accSeed">Actualizar autos y pistas</button>
        <p class="note" id="accSeedNote"></p>
      </div>
      <p class="note" id="accNet"></p>
      <div class="row"><button class="btn primary" id="accClose">Listo</button></div>`;
    document.body.appendChild(panel);
    const $ = (id) => document.getElementById(id);
    const msg = (t) => { $('accState').textContent = t; };
    const refresh = () => {
      const u = session && session.user;
      const anon = !u || u.is_anonymous;
      msg(!sb ? 'Sin conexión con el servidor.' : anon ? 'Jugás como invitado.' : 'Sesión iniciada: ' + u.email + (isAdmin() ? ' · dueño' : ''));
      $('accForm').hidden = !anon; $('accOut').hidden = anon; $('accAdmin').hidden = !isAdmin();
    };
    b.addEventListener('click', () => { refresh(); panel.hidden = false; });
    $('accClose').addEventListener('click', () => { panel.hidden = true; });
    const go = async (fn) => {
      const email = $('accEmail').value.trim(), password = $('accPass').value;
      if (!email || password.length < 6) { msg('Poné un email y una contraseña de 6 caracteres o más.'); return; }
      msg('Un momento…');
      const r = await fn({ email, password });
      if (r.error) { msg(/confirm/i.test(r.error.message) ? 'Falta confirmar el email: abrí el link que te llegó y volvé a entrar.' : 'No se pudo: ' + r.error.message); return; }
      if (!r.data.session) { msg('Te mandamos un email para confirmar la cuenta. Abrí el link y después tocá Entrar.'); return; }
      location.reload();
    };
    $('accIn').addEventListener('click', () => ready.then(() => go((x) => sb.auth.signInWithPassword(x))));
    $('accUp').addEventListener('click', () => ready.then(() => go((x) => sb.auth.signUp(x))));
    $('accLogout').addEventListener('click', async () => { await sb.auth.signOut(); localStorage.removeItem('polvo.auth'); location.reload(); });
    // deja el catálogo igual al de esta versión de la app: sube los autos y pistas, y saca los autos que ya no están
    async function syncSeed(note) {
      const say = (t) => { if (note) note.textContent = t; };
      say('Leyendo datos…');
      const seed = await (await fetch('seed.json')).json();
      const paths = Object.keys(seed);
      const keep = new Set(paths.filter((p) => /^catalog\/[^/]+$/.test(p)));
      const { data: cur, error: e0 } = await sb.from('docs').select('path,data').eq('coll', 'catalog');
      if (e0) throw e0;
      for (const r of cur || []) {
        if (keep.has(r.path)) continue;
        const n = Math.min(12, Math.max(1, (r.data && r.data.n) || 1));
        for (let i = 0; i < n; i++) await sb.from('docs').delete().eq('path', r.path + '/parts/p' + i);
        const { error } = await sb.from('docs').delete().eq('path', r.path); if (error) throw error;
      }
      let n = 0;
      for (const p of paths) {
        const { error } = await sb.from('docs').upsert({ path: p, data: seed[p] }, { onConflict: 'path' });
        if (error) throw error;
        n++; say(`Subiendo ${n} de ${paths.length}…`);
      }
      say('Listo: autos y pistas actualizados.');
      try { localStorage.setItem('polvo.seedv', String(window.POLVO_VERSION || '')); } catch (e) { /* nada */ }
    }
    $('accSeed').addEventListener('click', async () => {
      const note = $('accSeedNote'), btn = $('accSeed'); btn.disabled = true;
      try { await syncSeed(note); } catch (e) { note.textContent = 'No se pudo actualizar: ' + (e.message || e); }
      btn.disabled = false;
    });
    // el dueño, al abrir una versión nueva, actualiza el catálogo solo
    ready.then(() => {
      let v = null; try { v = localStorage.getItem('polvo.seedv'); } catch (e) { /* nada */ }
      if (isAdmin() && window.POLVO_VERSION && v !== String(window.POLVO_VERSION)) syncSeed(null).catch(() => {});
    }, () => {});
    ready.then(refresh, refresh);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', accountUi); else accountUi();

  // ===================================================================
  // AVISO DE VERSIÓN NUEVA: al abrir, se fija en GitHub si hay una APK más nueva
  // ===================================================================
  async function checkUpdate() {
    const mine = Number(window.POLVO_VERSION) || 0;
    if (!mine || !CFG.repo) return;
    try {
      const r = await fetch('https://api.github.com/repos/' + CFG.repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
      if (!r.ok) return;
      const rel = await r.json();
      const n = Number(String(rel.tag_name || '').replace(/^v1\./, '')) || 0;
      const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
      if (n <= mine || !apk) return;
      if (sessionStorage.getItem('polvo.skip') === String(n)) return;
      const menu = document.getElementById('menu'); if (!menu || document.getElementById('updBox')) return;
      const box = document.createElement('div');
      box.id = 'updBox';
      box.style.cssText = 'display:grid;gap:8px;padding:10px 12px;border:1px solid var(--plate);border-radius:5px;background:rgba(240,192,58,.1)';
      box.innerHTML = `<p class="note" style="margin:0;color:var(--paper)"><b>Hay una versión nueva (1.${n}).</b> Tenés la 1.${mine}.</p>
        <div style="display:grid;grid-template-columns:1fr auto;gap:8px"><button class="btn primary sm" id="updGo">Actualizar</button><button class="btn sm" id="updLater">Más tarde</button></div>`;
      menu.insertBefore(box, menu.children[1] || null);
      box.querySelector('#updGo').addEventListener('click', () => {
        // se abre en el navegador del teléfono, que la descarga; después hay que tocar el archivo para instalarla
        location.href = apk.browser_download_url;
        box.querySelector('.note').innerHTML = '<b>Descargando…</b> Cuando termine, abrí el archivo <b>polvo.apk</b> desde la notificación y tocá <b>Actualizar</b>.';
      });
      box.querySelector('#updLater').addEventListener('click', () => { sessionStorage.setItem('polvo.skip', String(n)); box.remove(); });
    } catch (e) { /* sin internet: se avisa la próxima vez */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(checkUpdate, 1500)); else setTimeout(checkUpdate, 1500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });

})();
