// Supabase de mentira para probar dos pestañas en la misma máquina (BroadcastChannel + localStorage)
window.supabase = { createClient() {
  const uid = 'u' + Math.random().toString(36).slice(2, 10);
  let session = null;
  const load = () => JSON.parse(localStorage.getItem('mockdb') || '{}');
  const save = (d) => localStorage.setItem('mockdb', JSON.stringify(d));
  const parent = (p) => p.slice(0, p.lastIndexOf('/'));
  function q() {
    const st = { f: [], op: 'select', row: null };
    const run = () => {
      const d = load();
      if (st.op === 'upsert') { d[st.row.path] = st.row.data; save(d); return { data: null, error: null }; }
      if (st.op === 'delete') { for (const [k, v] of st.f) if (k === 'path') delete d[v]; save(d); return { data: null, error: null }; }
      let rows = Object.entries(d).map(([path, data]) => ({ path, data, coll: parent(path) }));
      for (const [k, v] of st.f) rows = rows.filter((r) => r[k] === v);
      return { data: st.single ? (rows[0] || null) : rows, error: null };
    };
    const api = {
      select() { return api; }, eq(k, v) { st.f.push([k, v]); return api; },
      maybeSingle() { st.single = true; return Promise.resolve(run()); },
      upsert(row) { st.op = 'upsert'; st.row = row; return Promise.resolve(run()); },
      delete() { st.op = 'delete'; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  return {
    auth: {
      async getSession() { return { data: { session } }; },
      async signInAnonymously() { session = { user: { id: uid, is_anonymous: true } }; return { data: { session }, error: null }; },
      onAuthStateChange() {},
    },
    from() { return q(); },
    channel(name, opts) {
      const key = (opts && opts.config && opts.config.presence && opts.config.presence.key) || uid;
      const bc = new BroadcastChannel('mock:' + name);
      const hs = { broadcast: {}, sync: [] };
      const pres = {};
      let tracked = false;
      const fireSync = () => hs.sync.forEach((f) => f());
      bc.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'b') (hs.broadcast[m.event] || []).forEach((f) => f({ payload: m.payload }));
        if (m.t === 'join') { const isNew = !pres[m.key]; pres[m.key] = [{}]; if (isNew) { fireSync(); if (tracked) bc.postMessage({ t: 'join', key }); } }
        if (m.t === 'leave') { delete pres[m.key]; fireSync(); }
      };
      const ch = {
        on(type, filt, cb) { if (type === 'broadcast') (hs.broadcast[filt.event] = hs.broadcast[filt.event] || []).push(cb); else if (type === 'presence' && filt.event === 'sync') hs.sync.push(cb); return ch; },
        subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 30); return ch; },
        async track() { tracked = true; pres[key] = [{}]; bc.postMessage({ t: 'join', key }); fireSync(); },
        async untrack() { bc.postMessage({ t: 'leave', key }); },
        presenceState() { return pres; },
        async send(m) { bc.postMessage({ t: 'b', event: m.event, payload: m.payload }); return 'ok'; },
        _close() { bc.close(); },
      };
      return ch;
    },
    removeChannel(ch) { if (ch && ch._close) ch._close(); },
  };
} };
