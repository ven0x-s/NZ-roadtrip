/* Nieuw-Zeeland per camper: kaart, stops en notities die in GitHub worden opgeslagen. */
(() => {
  'use strict';

  const REPO = { owner: 'ven0x-s', name: 'NZ-roadtrip', branch: 'main', notesPath: 'data/notes.json' };
  const KEY = { token: 'nzr.token', draft: 'nzr.draft.', island: 'nzr.island' };
  const STATUS = { idee: 'Idee', favoriet: 'Favoriet', geboekt: 'Geboekt' };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* geen opslag */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* geen opslag */ } },
  };

  const state = {
    route: null,
    stops: [],
    byId: {},
    notes: {},
    island: store.get(KEY.island) || 'zuid',
    selected: null,
    token: store.get(KEY.token) || '',
    canWrite: false,
    picking: null,
    saving: Promise.resolve(),
  };

  /* ---------- kleine helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const today = () => new Date().toISOString().slice(0, 10);
  const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

  const fmt = new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const fmtDate = (iso) => fmt.format(new Date(iso + 'T00:00:00Z')).replace(/\./g, '');
  const range = (s) => `${fmtDate(s.from)} – ${fmtDate(s.to)}`;
  const nightsLabel = (n) => `${n} ${n === 1 ? 'nacht' : 'nachten'}`;

  let toastTimer;
  function toast(msg, isErr = false, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 7000 : ms);
  }

  /* ---------- base64 met UTF-8 ---------- */
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  /* ---------- GitHub ---------- */
  class GhError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  async function gh(path, opts = {}) {
    const headers = { Accept: 'application/vnd.github+json', ...(opts.headers || {}) };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    let res;
    try {
      res = await fetch('https://api.github.com' + path, { ...opts, headers, cache: 'no-store' });
    } catch {
      throw new GhError(0, 'Geen verbinding met GitHub. Controleer je internet en probeer het opnieuw.');
    }
    return res;
  }

  function explain(status) {
    if (status === 401) return 'Je GitHub sleutel klopt niet of is verlopen. Open Bewerken om een nieuwe te plakken.';
    if (status === 403) return 'GitHub weigert het opslaan. Geef de sleutel Contents: Read and write op NZ-roadtrip, of wacht even als je vaak hebt opgeslagen.';
    if (status === 404) return 'De repository of het notitiebestand is niet gevonden. Controleer of de sleutel toegang heeft tot NZ-roadtrip.';
    if (status === 0) return 'Geen verbinding met GitHub. Controleer je internet en probeer het opnieuw.';
    return `Opslaan mislukt (GitHub status ${status}). Probeer het opnieuw.`;
  }

  async function fetchRemote() {
    const res = await gh(`/repos/${REPO.owner}/${REPO.name}/contents/${REPO.notesPath}?ref=${REPO.branch}`);
    if (!res.ok) throw new GhError(res.status, explain(res.status));
    const j = await res.json();
    return { json: JSON.parse(b64decode(j.content || '') || '{}'), sha: j.sha };
  }

  async function loadNotes() {
    try {
      const { json } = await fetchRemote();
      return json;
    } catch {
      try {
        const r = await fetch('data/notes.json?ts=' + Date.now(), { cache: 'no-store' });
        if (r.ok) return await r.json();
      } catch { /* laat leeg */ }
      return {};
    }
  }

  function normalize(entry) {
    const e = entry && typeof entry === 'object' ? JSON.parse(JSON.stringify(entry)) : {};
    if (typeof e.notes !== 'string') e.notes = '';
    if (!Array.isArray(e.links)) e.links = [];
    if (!Array.isArray(e.campings)) e.campings = [];
    return e;
  }

  /* Past een wijziging toe op de nieuwste versie in GitHub, zodat edits van een ander apparaat blijven staan. */
  function commit(stopId, mutate, message) {
    if (!state.canWrite) { openSettings(); return Promise.resolve(false); }
    const local = normalize(state.notes[stopId]);
    mutate(local);
    state.notes[stopId] = local;
    renderPanel();
    renderMapForSelection();
    toast('Opslaan…', false, 60000);

    const job = state.saving.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const { json, sha } = await fetchRemote();
        const entry = normalize(json[stopId]);
        mutate(entry);
        json[stopId] = entry;
        const body = JSON.stringify({
          message: `${message} (${state.byId[stopId]?.name || stopId})`,
          content: b64encode(JSON.stringify(json, null, 1) + '\n'),
          sha,
          branch: REPO.branch,
        });
        const res = await gh(`/repos/${REPO.owner}/${REPO.name}/contents/${REPO.notesPath}`, {
          method: 'PUT', body, headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) { state.notes = json; return true; }
        if (res.status !== 409 && res.status !== 422) throw new GhError(res.status, explain(res.status));
      }
      throw new GhError(409, 'Iemand anders sloeg tegelijk op. Ververs de pagina en probeer het opnieuw.');
    });

    state.saving = job.catch(() => {});
    return job.then(() => {
      toast('Opgeslagen in GitHub');
      renderPanel(); renderMapForSelection(); renderList();
      return true;
    }).catch(async (err) => {
      toast(err.message || explain(err.status), true);
      if (err.status === 401) setToken('');
      state.notes = await loadNotes();
      renderPanel(); renderMapForSelection();
      return false;
    });
  }

  /* ---------- sleutel ---------- */
  function setToken(tok) {
    state.token = tok;
    if (tok) store.set(KEY.token, tok); else store.del(KEY.token);
    state.canWrite = Boolean(tok);
    updateEditBadge();
  }
  function updateEditBadge() {
    const b = $('#btnSettings');
    b.classList.toggle('on', state.canWrite);
    $('#editLabel').textContent = state.canWrite ? 'Bewerken aan' : 'Alleen lezen';
  }
  async function testToken(tok) {
    const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.name}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + tok }, cache: 'no-store',
    }).catch(() => null);
    if (!res) return { ok: false, msg: 'Geen verbinding met GitHub.' };
    if (res.status === 401) return { ok: false, msg: 'Deze sleutel wordt niet herkend. Controleer of je hem helemaal hebt geplakt.' };
    if (!res.ok) return { ok: false, msg: `Geen toegang tot ${REPO.owner}/${REPO.name} (status ${res.status}).` };
    const j = await res.json();
    if (j.permissions && !j.permissions.push) return { ok: false, msg: 'De sleutel mag alleen lezen. Zet Contents op Read and write.' };
    return { ok: true, msg: 'Gelukt. Je kunt nu notities, video\'s en campings opslaan.' };
  }
  function openSettings() {
    const d = $('#settings');
    $('#tokenInput').value = '';
    const st = $('#tokenStatus');
    st.className = 'dlg-status';
    st.textContent = state.canWrite ? 'Er is al een sleutel bewaard op dit apparaat.' : '';
    $('#tokenRemove').hidden = !state.canWrite;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function bindSettings() {
    $('#repoName').textContent = `${REPO.owner}/${REPO.name}`;
    $('#btnSettings').addEventListener('click', openSettings);
    $('#dlgClose').addEventListener('click', () => $('#settings').close());
    $('#tokenRemove').addEventListener('click', () => {
      setToken('');
      $('#tokenStatus').textContent = 'Sleutel verwijderd van dit apparaat.';
      $('#tokenRemove').hidden = true;
      renderPanel();
    });
    $('#tokenSave').addEventListener('click', async () => {
      const tok = $('#tokenInput').value.trim();
      const st = $('#tokenStatus');
      if (!tok) { st.className = 'dlg-status err'; st.textContent = 'Plak eerst je sleutel in het veld.'; return; }
      st.className = 'dlg-status'; st.textContent = 'Sleutel testen…';
      const r = await testToken(tok);
      st.className = 'dlg-status ' + (r.ok ? 'ok' : 'err');
      st.textContent = r.msg;
      if (r.ok) {
        setToken(tok);
        $('#tokenInput').value = '';
        $('#tokenRemove').hidden = false;
        renderPanel();
        setTimeout(() => $('#settings').close(), 900);
      }
    });
    $('#settingsForm').addEventListener('submit', (e) => e.preventDefault());
  }

  /* ---------- kaart ---------- */
  let map, tiles, routeLayer, stopLayer, detailLayer;
  const stopMarkers = {};

  function tileUrl() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return `https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'rastertiles/voyager'}/{z}/{x}/{y}{r}.png`;
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: false });
    tiles = L.tileLayer(tileUrl(), {
      maxZoom: 18, subdomains: 'abcd',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { tiles.setUrl(tileUrl()); drawRoute(); });
    routeLayer = L.layerGroup().addTo(map);
    stopLayer = L.layerGroup().addTo(map);
    detailLayer = L.layerGroup().addTo(map);
    map.on('click', (e) => {
      if (!state.picking) return;
      const cb = state.picking;
      stopPicking();
      cb(+e.latlng.lat.toFixed(5), +e.latlng.lng.toFixed(5));
    });
    map.setView([-41.5, 172.5], 5);
  }

  function visibleStops() {
    return state.island === 'alles' ? state.stops : state.stops.filter((s) => s.island === state.island);
  }

  function drawRoute() {
    routeLayer.clearLayers();
    const z = state.stops.filter((s) => s.island === 'zuid').map((s) => [s.lat, s.lng]);
    const n = state.stops.filter((s) => s.island === 'noord').map((s) => [s.lat, s.lng]);
    const show = state.island;
    const zc = cssVar('--route'), nc = cssVar('--route-n');
    if (show !== 'noord') L.polyline(z, { color: zc, weight: 3, opacity: show === 'alles' || show === 'zuid' ? .9 : .3 }).addTo(routeLayer);
    if (show !== 'zuid') L.polyline(n, { color: nc, weight: 3, opacity: .9 }).addTo(routeLayer);
    const f = state.route.ferry;
    L.polyline([z[z.length - 1], f.from, f.to, n[0]], { color: cssVar('--muted'), weight: 2, dashArray: '4 7' })
      .bindTooltip(`${f.name}, ${fmtDate(f.date)}. ${f.info}`, { sticky: true })
      .addTo(routeLayer);
  }

  function drawStops() {
    stopLayer.clearLayers();
    const vis = new Set(visibleStops().map((s) => s.id));
    state.stops.forEach((s) => {
      if (!vis.has(s.id)) return;
      const on = state.selected === s.id;
      const icon = L.divIcon({
        className: '', iconSize: [26, 26], iconAnchor: [13, 13],
        html: `<div class="mk ${s.island === 'noord' ? 'n' : ''} ${on ? 'on' : ''} ${state.selected && !on ? 'dim' : ''}">${s.seq}</div>`,
      });
      const m = L.marker([s.lat, s.lng], { icon, zIndexOffset: on ? 1000 : 0, keyboard: true, title: s.name })
        .bindTooltip(`${s.seq}. ${s.name}`, { direction: 'top', offset: [0, -12] })
        .on('click', () => select(s.id));
      m.addTo(stopLayer);
      stopMarkers[s.id] = m;
    });
  }

  function renderMapForSelection() {
    detailLayer.clearLayers();
    drawStops();
    if (!state.selected) return;
    const s = state.byId[state.selected];
    s.activities.forEach((a) => {
      L.circleMarker([a.lat, a.lng], {
        radius: 6, color: cssVar('--route'), weight: 2, fillColor: cssVar('--panel'), fillOpacity: 1,
      }).bindTooltip(a.name, { direction: 'top' }).addTo(detailLayer);
    });
    normalize(state.notes[s.id]).campings.forEach((c) => {
      if (typeof c.lat !== 'number' || typeof c.lng !== 'number') return;
      const icon = L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 18], html: `<div class="cmk ${c.status || 'idee'}"></div>` });
      L.marker([c.lat, c.lng], { icon, title: c.name })
        .bindTooltip(`${c.name} (${STATUS[c.status] || 'Idee'})`, { direction: 'top', offset: [0, -16] })
        .addTo(detailLayer);
    });
  }

  function fitSelection() {
    if (!state.selected) {
      const pts = visibleStops().map((s) => [s.lat, s.lng]);
      if (pts.length) map.fitBounds(pts, { padding: [30, 30] });
      return;
    }
    const s = state.byId[state.selected];
    const pts = [[s.lat, s.lng], ...s.activities.map((a) => [a.lat, a.lng])];
    normalize(state.notes[s.id]).campings.forEach((c) => { if (typeof c.lat === 'number') pts.push([c.lat, c.lng]); });
    const prev = state.stops[state.stops.indexOf(s) - 1];
    if (prev && prev.island === s.island) pts.push([prev.lat, prev.lng]);
    map.flyToBounds(pts, { padding: [40, 40], maxZoom: 12, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.6 });
  }

  function startPicking(cb) {
    state.picking = cb;
    document.body.classList.add('picking');
    $('#pickbar').hidden = false;
    if (matchMedia('(max-width: 860px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function stopPicking() {
    state.picking = null;
    document.body.classList.remove('picking');
    $('#pickbar').hidden = true;
  }

  /* Leest coördinaten uit een Google Maps link, als die erin staan. */
  function coordsFromUrl(u) {
    if (!u) return null;
    const pats = [/@(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|ll|query)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/];
    for (const p of pats) {
      const m = u.match(p);
      if (m) { const lat = +m[1], lng = +m[2]; if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng }; }
    }
    return null;
  }

  /* ---------- video's en links ---------- */
  function igPermalink(u) {
    const m = String(u).match(/instagram\.com\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/i);
    if (!m) return null;
    const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
    return `https://www.instagram.com/${kind}/${m[2]}/`;
  }
  function ytId(u) {
    const m = String(u).match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/i);
    return m ? m[1] : null;
  }
  function linkKind(u) {
    if (igPermalink(u)) return 'instagram';
    if (ytId(u)) return 'youtube';
    if (/tiktok\.com/i.test(u)) return 'tiktok';
    return 'link';
  }
  let igLoading = null;
  function processInstagram() {
    if (window.instgrm && window.instgrm.Embeds) { window.instgrm.Embeds.process(); return; }
    if (!igLoading) {
      igLoading = new Promise((res) => {
        const s = document.createElement('script');
        s.src = 'https://www.instagram.com/embed.js'; s.async = true; s.onload = res; s.onerror = res;
        document.body.appendChild(s);
      });
    }
    igLoading.then(() => window.instgrm && window.instgrm.Embeds.process());
  }
  function embedFor(link) {
    const ig = igPermalink(link.url);
    if (ig) {
      const bq = h('blockquote', { class: 'instagram-media', 'data-instgrm-permalink': ig + '?utm_source=ig_embed', 'data-instgrm-version': '14' },
        h('a', { href: ig, target: '_blank', rel: 'noopener', text: 'Bekijk op Instagram' }));
      return h('div', { class: 'embed' }, bq);
    }
    const yt = ytId(link.url);
    if (yt) {
      return h('div', { class: 'embed' }, h('iframe', {
        src: `https://www.youtube-nocookie.com/embed/${yt}`, title: link.title || 'YouTube video', loading: 'lazy',
        allow: 'accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen', allowfullscreen: true,
      }));
    }
    return null;
  }

  /* ---------- panelen ---------- */
  function counts(id) {
    const e = normalize(state.notes[id]);
    const vids = e.links.filter((l) => ['instagram', 'youtube', 'tiktok'].includes(linkKind(l.url))).length;
    return {
      vids, links: e.links.length - vids, camps: e.campings.length,
      fav: e.campings.some((c) => c.status === 'favoriet' || c.status === 'geboekt'),
      booked: e.campings.find((c) => c.status === 'geboekt'),
      notes: e.notes.trim().length > 0,
    };
  }

  function stopRow(s) {
    const c = counts(s.id);
    const chips = [];
    if (c.booked) chips.push(h('span', { class: 'chip fav', text: 'geboekt' }));
    if (c.camps) chips.push(h('span', { class: 'chip has', text: `${c.camps} ${c.camps === 1 ? 'camping' : 'campings'}` }));
    if (c.vids) chips.push(h('span', { class: 'chip has', text: `${c.vids} video${c.vids === 1 ? '' : "'s"}` }));
    if (c.notes) chips.push(h('span', { class: 'chip has', text: 'notitie' }));
    return h('li', null, h('button', { type: 'button', class: 'stop-btn', onclick: () => select(s.id) },
      h('span', { class: 'num' + (s.island === 'noord' ? ' n' : ''), text: s.seq }),
      h('span', { style: 'min-width:0' },
        h('span', { class: 'stop-name', text: s.name }),
        h('span', { class: 'stop-date', text: `${range(s)} · ${nightsLabel(s.nights)}` })),
      h('span', { class: 'chips' }, chips)));
  }

  function renderList() {
    if (state.selected) return;
    const p = $('#panel');
    p.replaceChildren();
    const vis = visibleStops();
    const isl = state.route.islands[state.island];
    const nights = vis.reduce((a, s) => a + s.nights, 0);
    p.append(h('div', { class: 'list-head' },
      h('div', null,
        h('h2', { text: isl ? isl.name : 'Hele route' }),
        h('div', { class: 'maori', text: isl ? isl.maori : 'Zuidereiland, ferry en Noordereiland' })),
      h('span', { class: 'meta', text: `${vis.length} stops · ${nights} nachten` })));
    const f = state.route.ferry;
    const ferryRow = () => h('div', { class: 'ferry-row' }, h('b', { text: `Ferry ${fmtDate(f.date)}` }), h('span', { text: `${f.name}. ${f.info}` }));
    const groups = state.island === 'alles' ? ['zuid', 'noord'] : [state.island];
    groups.forEach((g) => {
      if (state.island === 'alles') p.append(h('p', { class: 'group-title', text: state.route.islands[g].name }));
      if (g === 'noord' && state.island === 'noord') p.append(ferryRow());
      p.append(h('ul', { class: 'stops' }, vis.filter((s) => s.island === g).map(stopRow)));
      if (g === 'zuid') p.append(ferryRow());
    });
  }

  function roNote() {
    return h('p', { class: 'ro-note' }, 'Alleen lezen op dit apparaat. ',
      h('button', { type: 'button', onclick: openSettings, text: 'Zet bewerken aan' }), ' om iets toe te voegen.');
  }

  function confirmButton(label, onConfirm) {
    let armed = false, timer;
    const b = h('button', { type: 'button', class: 'small danger', text: label });
    b.addEventListener('click', () => {
      if (!armed) {
        armed = true; b.classList.add('confirm'); b.textContent = 'Zeker weten?';
        timer = setTimeout(() => { armed = false; b.classList.remove('confirm'); b.textContent = label; }, 3000);
        return;
      }
      clearTimeout(timer); onConfirm();
    });
    return b;
  }

  function campingCard(stopId, c) {
    const url = safeUrl(c.url);
    const status = STATUS[c.status] ? c.status : 'idee';
    const card = h('div', { class: 'card' + (status === 'favoriet' ? ' fav' : status === 'geboekt' ? ' booked' : '') },
      h('div', { class: 'card-top' },
        h('span', { class: 'card-title', text: c.name }),
        h('span', { class: 'chips' },
          c.by === 'voorstel' ? h('span', { class: 'tag voorstel', text: 'voorstel' }) : null,
          h('span', { class: 'tag ' + status, text: STATUS[status] }))),
      c.note ? h('p', { class: 'card-note', style: 'margin:0', text: c.note }) : null);
    const actions = h('div', { class: 'card-actions' });
    if (url) actions.append(h('a', { class: 'small', href: url, target: '_blank', rel: 'noopener', text: host(url) }));
    if (typeof c.lat === 'number') {
      actions.append(h('button', { type: 'button', class: 'small', text: 'Op kaart', onclick: () => map.flyTo([c.lat, c.lng], 14) }));
      actions.append(h('a', { class: 'small', href: `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`, target: '_blank', rel: 'noopener', text: 'Route' }));
    }
    if (state.canWrite) {
      const sel = h('select', { class: 'small', 'aria-label': `Status van ${c.name}` },
        Object.entries(STATUS).map(([v, l]) => h('option', { value: v, text: l, selected: v === status })));
      sel.addEventListener('change', () => commit(stopId, (e) => {
        const x = e.campings.find((k) => k.id === c.id); if (x) x.status = sel.value;
      }, `Camping ${STATUS[sel.value].toLowerCase()}: ${c.name}`));
      actions.append(sel);
      actions.append(h('button', { type: 'button', class: 'small', text: typeof c.lat === 'number' ? 'Verplaats' : 'Zet op kaart', onclick: () => {
        startPicking((lat, lng) => commit(stopId, (e) => {
          const x = e.campings.find((k) => k.id === c.id); if (x) { x.lat = lat; x.lng = lng; }
        }, `Locatie camping: ${c.name}`));
      } }));
      actions.append(confirmButton('Verwijder', () => commit(stopId, (e) => {
        e.campings = e.campings.filter((k) => k.id !== c.id);
      }, `Camping verwijderd: ${c.name}`)));
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  }

  function campingForm(stopId) {
    let picked = null;
    const name = h('input', { type: 'text', id: 'campName', placeholder: 'Bijv. Lake Tekapo Holiday Park', required: true });
    const url = h('input', { type: 'url', id: 'campUrl', placeholder: 'Website of Google Maps link' });
    const note = h('input', { type: 'text', id: 'campNote', placeholder: 'Prijs, powered site, tips…' });
    const status = h('select', { id: 'campStatus' }, Object.entries(STATUS).map(([v, l]) => h('option', { value: v, text: l })));
    const where = h('p', { class: 'hint', text: 'Nog geen plek op de kaart. Plak een Google Maps link met coördinaten, of kies hem op de kaart.' });
    const setWhere = () => { where.textContent = picked ? `Plek op de kaart: ${picked.lat.toFixed(4)}, ${picked.lng.toFixed(4)}` : 'Nog geen plek op de kaart. Plak een Google Maps link met coördinaten, of kies hem op de kaart.'; };
    url.addEventListener('input', () => { const c = coordsFromUrl(url.value); if (c) { picked = c; setWhere(); } });
    const form = h('form', { class: 'form', onsubmit: (ev) => {
      ev.preventDefault();
      const n = name.value.trim();
      if (!n) { name.focus(); toast('Geef de camping een naam.', true); return; }
      const item = { id: uid('c'), name: n, url: safeUrl(url.value.trim()) || '', note: note.value.trim(), status: status.value, added: today(), by: 'rick' };
      if (picked) { item.lat = picked.lat; item.lng = picked.lng; }
      commit(stopId, (e) => { if (!e.campings.some((k) => k.id === item.id)) e.campings.push(item); }, `Camping toegevoegd: ${n}`);
    } },
      h('label', { for: 'campName', text: 'Naam camping' }), name,
      h('div', { class: 'row' },
        h('div', null, h('label', { for: 'campUrl', text: 'Link' }), url),
        h('div', null, h('label', { for: 'campStatus', text: 'Status' }), status)),
      h('label', { for: 'campNote', text: 'Notitie' }), note,
      where,
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'ghost', text: 'Kies op kaart', onclick: () => startPicking((lat, lng) => { picked = { lat, lng }; setWhere(); form.scrollIntoView({ block: 'center', behavior: 'smooth' }); }) }),
        h('span', { class: 'grow' }),
        h('button', { type: 'submit', class: 'primary', text: 'Camping toevoegen' })));
    return form;
  }

  function linkCard(stopId, l) {
    const url = safeUrl(l.url);
    const kind = linkKind(l.url);
    const label = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok', link: host(l.url) }[kind];
    const card = h('div', { class: 'card' },
      h('div', { class: 'card-top' },
        h('span', { class: 'card-title', text: l.title || label }),
        h('span', { class: 'tag', text: label })));
    const emb = embedFor(l);
    if (emb) card.append(emb);
    const actions = h('div', { class: 'card-actions' });
    if (url) actions.append(h('a', { class: 'small', href: url, target: '_blank', rel: 'noopener', text: 'Openen' }));
    if (state.canWrite) actions.append(confirmButton('Verwijder', () => commit(stopId, (e) => {
      e.links = e.links.filter((k) => k.id !== l.id);
    }, 'Link verwijderd')));
    card.append(actions);
    return card;
  }

  function linkForm(stopId) {
    const url = h('input', { type: 'url', id: 'linkUrl', placeholder: 'https://www.instagram.com/reel/…', required: true });
    const title = h('input', { type: 'text', id: 'linkTitle', placeholder: 'Bijv. Hooker Valley bij zonsopkomst' });
    return h('form', { class: 'form', onsubmit: (ev) => {
      ev.preventDefault();
      const u = safeUrl(url.value.trim());
      if (!u) { url.focus(); toast('Plak een volledige link die begint met https://', true); return; }
      const item = { id: uid('l'), url: u, title: title.value.trim(), added: today() };
      commit(stopId, (e) => { if (!e.links.some((k) => k.id === item.id)) e.links.push(item); }, `${linkKind(u) === 'link' ? 'Link' : 'Video'} toegevoegd`);
    } },
      h('label', { for: 'linkUrl', text: 'Link naar Instagram, YouTube, TikTok of een website' }), url,
      h('label', { for: 'linkTitle', text: 'Titel (optioneel)' }), title,
      h('div', { class: 'btnrow' }, h('span', { class: 'grow' }), h('button', { type: 'submit', class: 'primary', text: 'Toevoegen' })));
  }

  function notesSection(stopId) {
    const e = normalize(state.notes[stopId]);
    const sec = h('section', { class: 'sec' }, h('h3', null, 'Notities'));
    if (!state.canWrite) {
      sec.append(e.notes ? h('p', { class: 'notes-view', text: e.notes }) : h('p', { class: 'hint', text: 'Nog geen notities.' }));
      return sec;
    }
    const draftKey = KEY.draft + stopId;
    const draft = store.get(draftKey);
    const ta = h('textarea', { id: 'notes-' + stopId, 'aria-label': 'Notities', placeholder: 'Wat willen jullie hier doen, eten, onthouden…' });
    ta.value = draft != null ? draft : e.notes;
    const info = h('span', { class: 'hint', text: draft != null && draft !== e.notes ? 'Niet opgeslagen wijziging' : '' });
    const btn = h('button', { type: 'button', class: 'primary', text: 'Notitie opslaan', disabled: !(draft != null && draft !== e.notes) });
    ta.addEventListener('input', () => {
      const dirty = ta.value !== normalize(state.notes[stopId]).notes;
      if (dirty) store.set(draftKey, ta.value); else store.del(draftKey);
      btn.disabled = !dirty;
      info.textContent = dirty ? 'Niet opgeslagen wijziging' : '';
    });
    btn.addEventListener('click', async () => {
      const text = ta.value;
      btn.disabled = true;
      const ok = await commit(stopId, (x) => { x.notes = text; }, 'Notitie bijgewerkt');
      if (ok) store.del(draftKey);
    });
    sec.append(ta, h('div', { class: 'btnrow' }, info, h('span', { class: 'grow' }), btn));
    return sec;
  }

  function renderDetail() {
    const s = state.byId[state.selected];
    const p = $('#panel');
    const e = normalize(state.notes[s.id]);
    const idx = state.stops.indexOf(s);
    const prev = state.stops[idx - 1], next = state.stops[idx + 1];
    const isl = state.route.islands[s.island];

    const acts = h('ul', { class: 'acts' }, s.activities.map((a) => h('li', null,
      h('button', { type: 'button', class: 'act', onclick: () => map.flyTo([a.lat, a.lng], 13) },
        h('i', { class: 'pip' }), h('span', null, h('b', { text: a.name }), h('span', { text: a.tip }))))));

    const order = { geboekt: 0, favoriet: 1, idee: 2 };
    const camps = [...e.campings].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

    const d = h('div', { class: 'detail' },
      h('div', { class: 'dnav' },
        h('button', { type: 'button', class: 'iconbtn', onclick: () => select(null), text: '‹ Alle stops' }),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Vorige stop', disabled: !prev, onclick: () => prev && select(prev.id), text: '‹' }),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Volgende stop', disabled: !next, onclick: () => next && select(next.id), text: '›' })),
      h('div', { class: 'dhead' },
        h('span', { class: 'eyebrow', text: `Stop ${s.seq} · ${isl.name}` }),
        h('h2', { text: s.name }),
        h('div', { class: 'facts' },
          h('span', { class: 'fact', text: `${range(s)} · ${nightsLabel(s.nights)}` }),
          s.arrive ? h('span', { class: 'fact', text: s.arrive }) : null,
          s.sleep ? h('span', { class: 'fact sleep', text: s.sleep }) : null)),
      h('section', { class: 'sec' }, h('h3', null, 'Activiteiten'), acts),
      h('section', { class: 'sec' },
        h('h3', null, h('span', { text: s.sleep ? 'Campings en slapen' : 'Campings' }), h('span', { text: e.campings.length || '' })),
        camps.length ? camps.map((c) => campingCard(s.id, c)) : h('p', { class: 'hint', text: 'Nog geen campings toegevoegd.' }),
        state.canWrite ? campingForm(s.id) : null),
      h('section', { class: 'sec' },
        h('h3', null, h('span', { text: "Video's en links" }), h('span', { text: e.links.length || '' })),
        e.links.length ? e.links.map((l) => linkCard(s.id, l)) : h('p', { class: 'hint', text: 'Nog geen video\'s of links. Plak bijvoorbeeld een Instagram reel van deze plek.' }),
        state.canWrite ? linkForm(s.id) : null),
      notesSection(s.id),
      state.canWrite ? null : roNote());

    p.replaceChildren(d);
    if (e.links.some((l) => igPermalink(l.url))) processInstagram();
  }

  function renderPanel() {
    if (!state.route) return;
    if (state.selected) renderDetail(); else renderList();
  }

  /* ---------- navigatie ---------- */
  function select(id, opts = {}) {
    stopPicking();
    const prevSel = state.selected;
    state.selected = id && state.byId[id] ? id : null;
    if (state.selected) {
      const isl = state.byId[state.selected].island;
      if (state.island !== 'alles' && state.island !== isl) setIsland(isl, { keepSelection: true });
      if (!opts.fromHash && location.hash !== '#' + state.selected) history.replaceState(null, '', '#' + state.selected);
    } else if (location.hash) {
      history.replaceState(null, '', location.pathname + location.search);
    }
    renderPanel();
    renderMapForSelection();
    fitSelection();
    const panel = $('#panel');
    if (matchMedia('(max-width: 860px)').matches) {
      if (prevSel !== state.selected) panel.scrollIntoView({ block: 'start' });
    } else panel.scrollTop = 0;
  }

  function setIsland(isl, opts = {}) {
    state.island = isl;
    store.set(KEY.island, isl);
    document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.island === isl)));
    drawRoute();
    if (!opts.keepSelection) { state.selected = null; history.replaceState(null, '', location.pathname + location.search); }
    renderPanel();
    renderMapForSelection();
    if (!opts.keepSelection) fitSelection();
  }

  /* ---------- start ---------- */
  async function boot() {
    bindSettings();
    state.canWrite = Boolean(state.token);
    updateEditBadge();
    $('#pickCancel').addEventListener('click', stopPicking);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.picking) stopPicking(); });
    document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setIsland(b.dataset.island)));

    initMap();
    try {
      const r = await fetch('data/route.json', { cache: 'no-store' });
      state.route = await r.json();
    } catch {
      $('#panel').replaceChildren(h('p', { class: 'empty', text: 'De route kon niet worden geladen. Ververs de pagina.' }));
      return;
    }
    state.stops = state.route.stops.map((s, i) => ({ ...s, seq: i + 1 }));
    state.stops.forEach((s) => { state.byId[s.id] = s; });
    const first = state.stops[0], last = state.stops[state.stops.length - 1];
    $('#sub').textContent = `${fmtDate(first.from)} tot ${fmtDate(last.to)} ${state.route.year}`;

    state.notes = await loadNotes();
    if (!['zuid', 'noord', 'alles'].includes(state.island)) state.island = 'zuid';
    const hashId = decodeURIComponent(location.hash.slice(1));
    if (hashId && state.byId[hashId]) state.island = state.byId[hashId].island;
    setIsland(state.island);
    if (hashId && state.byId[hashId]) select(hashId, { fromHash: true });

    window.addEventListener('hashchange', () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id !== (state.selected || '')) select(id || null, { fromHash: true });
    });
    window.addEventListener('resize', () => map.invalidateSize());
  }

  boot();
})();
