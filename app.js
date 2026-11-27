// ---------- Hulpfuncties ----------
const $ = s => document.querySelector(s);
const app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { } }
};
const loader = '<p class="animate-pulse py-20 text-center text-mute">Laden…</p>';
let KEY = ls.get('rawg_key') || '';
let liked = new Set();
let prev = () => viewSearch('');
let plat = '', favPlat = '', favSort = 'new', query = '', mainSort = 'rel', nav = 0, feedState = null, feedCleanup = () => {};
let urls = [];

// Blob uit lokale opslag => tijdelijke object-URL; gewone URL blijft zoals hij is
const src = x => {
  if (x instanceof Blob) { const u = URL.createObjectURL(x); urls.push(u); return u; }
  return x || '';
};
const resetUrls = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };

let tt;
const toast = m => {
  const t = $('#toast');
  t.textContent = m; t.classList.remove('hidden');
  clearTimeout(tt); tt = setTimeout(() => t.classList.add('hidden'), 4000);
};
const updateCount = () => { $('#count').textContent = liked.size; };

// ---------- Lokale opslag (IndexedDB: tekst én afbeeldingen) ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('gamekast', 2);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains('games')) d.createObjectStore('games', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const tx = async (store, mode, fn) => {
  const d = await dbp;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error);
  });
};
const dbAll = () => tx('games', 'readonly', s => s.getAll());
const dbGet = id => tx('games', 'readonly', s => s.get(id));
const dbPut = g => tx('games', 'readwrite', s => s.put(g));
const dbDel = id => tx('games', 'readwrite', s => s.delete(id));

// ---------- API (RAWG) ----------
// Antwoorden worden onthouden zolang de pagina open is: terugkeren kost zo geen nieuwe aanvraag
const apiCache = new Map();
async function api(path, params = {}) {
  const ck = path + '?' + new URLSearchParams(params);
  if (apiCache.has(ck)) return apiCache.get(ck);
  const u = new URL('https://api.rawg.io/api' + path);
  u.search = new URLSearchParams({ key: KEY, ...params });
  const r = await fetch(u);
  if (r.status === 401) throw new Error('Ongeldige API-sleutel. Pas hem aan via de knop “API-sleutel”.');
  if (!r.ok) throw new Error('De API gaf foutcode ' + r.status + '.');
  const data = await r.json();
  if (apiCache.size >= 120) apiCache.delete(apiCache.keys().next().value);
  apiCache.set(ck, data);
  return data;
}

const onRawg = u => {
  try { const h = new URL(u).hostname; return h === 'rawg.io' || h.endsWith('.rawg.io'); } catch { return false; }
};
const toBlob = async u => {
  if (!u || u instanceof Blob) return u;
  try {
    // GitHub-raw mag de browser rechtstreeks ophalen; alleen RAWG loopt via de lokale proxy
    const r = await (onRawg(u) ? fetch('gamekast.php?action=img&url=' + encodeURIComponent(u)) : fetch(u));
    if (!r.ok) throw 0;
    const b = await r.blob();
    if (!/^image\//.test(b.type)) throw 0; // geen afbeelding (bijv. PHP wordt niet uitgevoerd)
    return b;
  } catch { return u; } // valt terug op de URL als de afbeelding niet te downloaden is
};
async function saveLocal(g) {
  const shots = g.screenshots.slice(0, 12);
  const [cover, ...imgs] = await Promise.all([toBlob(g.cover), ...shots.map(toBlob)]);
  const offline = [cover, ...imgs].every(x => !x || x instanceof Blob);
  return { ...g, cover, screenshots: imgs, offline, savedAt: Date.now() };
}

// ---------- Opslaan op de server (gamekast.php) ----------
const slug = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'game';
const ext = x => ({ 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[x.type] || 'jpg');

// Bestanden per game: info.json, cover en screenshots
function filesFor(g) {
  const files = [], imgs = { cover: null, screenshots: [] };
  if (g.cover instanceof Blob) { imgs.cover = 'cover.' + ext(g.cover); files.push({ name: imgs.cover, data: g.cover }); }
  g.screenshots.forEach((x, i) => {
    if (!(x instanceof Blob)) return;
    const n = `screenshot-${String(i + 1).padStart(2, '0')}.${ext(x)}`;
    imgs.screenshots.push(n); files.push({ name: n, data: x });
  });
  const info = {
    id: g.id, naam: g.name, uitgebracht: g.released, beoordeling: g.rating, metacritic: g.metacritic,
    genres: g.genres, platforms: g.platforms, ontwikkelaars: g.developers,
    beschrijving: g.description, website: g.website,
    afbeeldingen: imgs,
    nietGedownload: [g.cover, ...g.screenshots].filter(x => typeof x === 'string'),
    opgeslagenOp: new Date(g.savedAt || Date.now()).toISOString()
  };
  files.push({ name: 'info.json', data: new Blob([JSON.stringify(info, null, 2)], { type: 'application/json' }) });
  return files;
}
const folderName = g => `${slug(g.name)}-${g.id}`;

async function serverPost(qs, body = null) {
  const r = await fetch('gamekast.php?' + qs, { method: 'POST', body });
  if (!r.ok) {
    const t = (await r.text().catch(() => '')).trim();
    throw new Error(t && !t.startsWith('<') ? t : 'HTTP ' + r.status + ' (wordt gamekast.php wel door PHP uitgevoerd?)');
  }
}

// Eerst de map leegmaken (oude screenshots weg), dan elk bestand apart naar gamekast.php
async function saveToServer(g) {
  const folder = folderName(g);
  await serverPost(`action=clean&folder=${encodeURIComponent(folder)}`);
  for (const f of filesFor(g)) {
    await serverPost(`action=put&folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(f.name)}`, f.data);
  }
  return folder;
}

// ---------- Weergaven ----------
const fail = e => {
  const msg = e instanceof TypeError
    ? 'Geen verbinding met de API. Controleer je internet. Je favorieten blijven beschikbaar.'
    : e.message;
  app.innerHTML = `<div class="mx-auto max-w-lg rounded-xl border border-coral/40 bg-panel p-5">
<h2 class="mb-1 font-display text-xl font-semibold">Er ging iets mis</h2>
<p class="text-sm text-mute">${esc(msg)}</p></div>`;
};

function viewKey() {
  ++nav;
  resetUrls();
  app.innerHTML = `<div class="mx-auto max-w-lg rounded-2xl border border-edge bg-panel p-6">
<h2 class="mb-2 font-display text-2xl font-extrabold">Stel je API-sleutel in</h2>
<p class="mb-4 text-sm leading-relaxed text-mute">Gamekast haalt games op via de gratis
  <a class="text-gold underline" href="https://rawg.io/apidocs" target="_blank" rel="noopener">RAWG API</a>.
  Maak daar een account, kopieer je sleutel en plak die hieronder. De sleutel blijft alleen in deze browser.</p>
<form id="keyForm" class="flex gap-2">
  <input id="keyIn" value="${esc(KEY)}" placeholder="Plak je RAWG API-sleutel" aria-label="API-sleutel"
    class="flex-1 rounded-lg border border-edge bg-night px-3 py-2">
  <button class="rounded-lg bg-gold px-4 py-2 font-semibold text-night">Opslaan</button>
</form></div>`;
  $('#keyForm').onsubmit = e => {
    e.preventDefault();
    KEY = $('#keyIn').value.trim(); ls.set('rawg_key', KEY); apiCache.clear();
    KEY ? viewSearch('') : viewKey();
  };
}

// ---------- Feed-pagina: gamelijst links, doorlopende feed rechts (zoeken en favorieten) ----------
const SEL = 'w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm';
const SORT_LOCAL = [['new', 'Nieuwste eerst'], ['old', 'Oudste eerst'], ['az', 'A → Z'], ['za', 'Z → A']];
const SORT_MAIN = [['rel', 'Meest relevant'], ...SORT_LOCAL];
const SORT_API = { new: '-released', old: 'released', az: 'name', za: '-name' };
// Games zonder releasedatum komen in beide richtingen onderaan
const byDate = d => (a, b) => (!a.released - !b.released) || d * (a.released || '').localeCompare(b.released || '');
const SORTERS = {
  new: byDate(-1), old: byDate(1),
  az: (a, b) => a.name.localeCompare(b.name), za: (a, b) => b.name.localeCompare(a.name)
};
const shotAt = {}; // gekozen screenshot per game, blijft bewaard bij terugkeren

// Snel-like hartje, tegenover de titel van een post
const likeLabel = on => on ? 'Verwijder uit favorieten' : 'Zet in favorieten';
const likeCls = on => 'like h-10 w-10 shrink-0 rounded-full border text-xl leading-none transition ' +
  (on ? 'border-coral bg-coral text-white' : 'border-white/30 text-mute hover:border-coral hover:text-coral');
const likeBtn = id => {
  const on = liked.has(id);
  return `<button class="${likeCls(on)}" aria-pressed="${on}" aria-label="${likeLabel(on)}" title="${likeLabel(on)}">${on ? '♥' : '♡'}</button>`;
};
function paintLike(btn, id, busy = false) {
  const on = liked.has(id);
  btn.className = likeCls(on) + (busy ? ' animate-pulse' : '');
  btn.disabled = busy;
  btn.textContent = on ? '♥' : '♡';
  btn.setAttribute('aria-pressed', on);
  btn.setAttribute('aria-label', likeLabel(on));
  btn.title = likeLabel(on);
}

// Eén post in de feed: titel, hoofdafbeelding met pijltjes, rij screenshots, beschrijving en platforms
function postHtml(g, hl, quick) {
  const pl = [...(g.platforms || [])].sort((a, b) => (b === hl) - (a === hl));
  const meta = [g.released?.slice(0, 4), (g.genres || []).slice(0, 2).join(', ')].filter(Boolean).join(' · ');
  const imgs = [...new Set([g.cover, ...(g.screenshots || [])])].filter(Boolean);
  const cur = Math.min(shotAt[g.id] || 0, Math.max(imgs.length - 1, 0));
  const srcs = imgs.map(x => esc(src(x)));
  return `
    <article data-id="${g.id}" data-i="${cur}" class="scroll-mt-20 overflow-hidden rounded-2xl border border-edge bg-panel">
      <div class="flex items-start justify-between gap-3 px-4 pt-4">
        <button class="open min-w-0 flex-1 text-left">
          <h2 class="font-display text-xl font-extrabold hover:text-gold">${esc(g.name)}</h2>
          <p class="mt-0.5 text-xs text-mute">${esc(meta)}</p>
        </button>
        ${quick ? likeBtn(g.id) : ''}
      </div>
      ${imgs.length ? `<div class="hero relative mt-3">
        <img src="${srcs[cur]}" alt="" class="main open aspect-video w-full cursor-pointer object-cover">
        ${imgs.length > 1 ? `<span class="count absolute right-3 top-3 rounded-full bg-night/80 px-2 py-0.5 text-xs">${cur + 1} / ${imgs.length}</span>
        <button data-d="-1" ${cur === 0 ? 'disabled' : ''} aria-label="Vorige screenshot" class="nav absolute left-2 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full bg-night/70 text-2xl leading-none hover:bg-night">‹</button>
        <button data-d="1" ${cur === imgs.length - 1 ? 'disabled' : ''} aria-label="Volgende screenshot" class="nav absolute right-2 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full bg-night/70 text-2xl leading-none hover:bg-night">›</button>` : ''}
      </div>` : ''}
      ${imgs.length > 1 ? `<div class="strip relative flex gap-2 overflow-x-auto p-3">${srcs.map((u, k) =>
        `<img src="${u}" loading="lazy" alt="" class="thumb aspect-video h-20 shrink-0 cursor-pointer rounded-lg object-cover${k === cur ? ' on' : ''}">`).join('')}</div>` : ''}
      ${g.description ? `<p class="line-clamp-3 px-4 pt-2 text-sm leading-relaxed text-[#d9d5f5]">${esc(g.description)}</p>` : ''}
      <div class="flex flex-wrap gap-1.5 px-4 pb-4 pt-3">${pl.slice(0, 8).map(p =>
        `<span class="rounded-full px-2 py-0.5 text-xs ${p === hl ? 'bg-gold font-semibold text-night' : 'bg-edge text-mute'}">${esc(p)}</span>`).join('')}${pl.length > 8 ? `<span class="px-1 py-0.5 text-xs text-mute">+${pl.length - 8}</span>` : ''}</div>
    </article>`;
}

// Toont afbeelding i als hoofdafbeelding van een post en markeert hem in de rij
function setShot(art, i, smooth = true) {
  const thumbs = art.querySelectorAll('.thumb'), t = thumbs[i];
  if (!t) return;
  art.dataset.i = i;
  shotAt[art.dataset.id] = i;
  art.querySelector('.main').src = t.src;
  thumbs.forEach((x, k) => x.classList.toggle('on', k === i));
  const c = art.querySelector('.count');
  if (c) c.textContent = `${i + 1} / ${thumbs.length}`;
  const pv = art.querySelector('.nav[data-d="-1"]'), nx = art.querySelector('.nav[data-d="1"]');
  if (pv) pv.disabled = i === 0;
  if (nx) nx.disabled = i === thumbs.length - 1;
  const strip = art.querySelector('.strip');
  strip.scrollTo({ left: t.offsetLeft - (strip.clientWidth - t.offsetWidth) / 2, behavior: smooth ? 'smooth' : 'auto' });
}

/* Bouwt de pagina en geeft { setItems, loading } terug.
   o.key, o.quick, o.onUnlike(id), o.empty, o.platforms [[waarde, label]], o.platform, o.sorts, o.sort,
   o.highlight() (platformnaam die in de posts goud wordt), o.onPlatform(v), o.onSort(v) */
function feedPage(o) {
  feedCleanup();
  const BATCH = 8;
  const opts = (arr, v) => arr.map(([k, t]) => `<option value="${esc(k)}"${k === v ? ' selected' : ''}>${esc(t)}</option>`).join('');
  app.innerHTML = `
    <div class="grid gap-6 lg:grid-cols-[260px_minmax(0,42rem)] lg:justify-center">
      <aside>
        <div class="lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100vh-6.5rem)] lg:flex-col">
          <div class="mb-3 flex flex-col gap-2">
            <select id="fpPlatform" class="${SEL}" aria-label="Filter op platform">${opts(o.platforms, o.platform)}</select>
            <select id="fpSort" class="${SEL}" aria-label="Sorteer games">${opts(o.sorts, o.sort)}</select>
          </div>
          <p id="fpInfo" class="mb-2 text-sm text-mute"></p>
          <div id="fpList" class="relative hidden min-h-0 flex-1 overflow-y-auto rounded-xl border border-edge bg-panel lg:block"></div>
        </div>
      </aside>
      <div>
        <div id="feed" class="space-y-6"></div>
        <div id="sentinel" class="h-10"></div>
      </div>
    </div>`;

  const feed = $('#feed'), sentinel = $('#sentinel'), listEl = $('#fpList');
  let items = [], total = 0, shown = 0, activeId = null, lock = 0, ticking = false, extending = false;
  const obs = new IntersectionObserver(e => { if (e[0].isIntersecting) more(); }, { rootMargin: '800px' });

  function dispose() {
    obs.disconnect();
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKey);
  }

  // Markeert een game in de lijst en houdt hem in beeld
  function setActive(id) {
    if (id === activeId) return;
    activeId = id;
    const cur = listEl.querySelector('.act');
    if (cur) cur.classList.remove('act');
    const b = listEl.querySelector(`[data-id="${id}"]`);
    if (!b) return;
    b.classList.add('act');
    const t = b.offsetTop, h = b.offsetHeight;
    if (t < listEl.scrollTop) listEl.scrollTop = t;
    else if (t + h > listEl.scrollTop + listEl.clientHeight) listEl.scrollTop = t + h - listEl.clientHeight;
  }

  // De game die op een vaste lijn (35% van de schermhoogte) staat is de game die je bekijkt
  function spy() {
    ticking = false;
    if (!document.body.contains(feed)) return dispose();
    if (!items.length || performance.now() < lock) return;
    const posts = feed.children, line = window.innerHeight * 0.35;
    let idx = 0;
    for (let i = 0; i < posts.length; i++) {
      if (posts[i].getBoundingClientRect().top <= line) idx = i; else break;
    }
    if (shown >= items.length && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) idx = posts.length - 1;
    setActive(+posts[idx].dataset.id);
  }
  function onScroll() { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }

  // Pijltjestoetsen bladeren door de screenshots van de game die je bekijkt
  function onKey(e) {
    if (!document.body.contains(feed)) return dispose();
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test((document.activeElement || {}).tagName)) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const d = e.key === 'ArrowDown' ? 1 : -1;
      let k = items.findIndex(g => g.id === activeId);
      if (k < 0) k = d > 0 ? -1 : items.length;
      const next = items[k + d];
      if (!next) return; // eerste of laatste game: de pagina scrolt gewoon door
      e.preventDefault();
      jumpTo(next.id);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const art = feed.querySelector(`[data-id="${activeId}"]`);
    if (!art) return;
    const i = (+art.dataset.i || 0) + (e.key === 'ArrowRight' ? 1 : -1);
    if (i < 0 || i >= art.querySelectorAll('.thumb').length) return;
    e.preventDefault();
    setShot(art, i);
  }

  // Scrolt naar een game en maakt hem de actieve game (render zo nodig tot die game)
  function jumpTo(id) {
    const idx = items.findIndex(g => g.id === id);
    if (idx < 0) return;
    if (idx >= shown) more(idx + 1 - shown);
    lock = performance.now() + 1000; // tijdens het scrollen de markering niet laten wisselen
    setActive(id);
    const calm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    feed.querySelector(`[data-id="${id}"]`).scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  }

  // Plaatst de volgende posts; de sentinel onderaan laadt er meer bij tijdens het scrollen
  function more(n = BATCH) {
    if (shown >= items.length) {
      if (o.loadMore && total > items.length) extend().then(() => { if (shown < items.length) more(); });
      return;
    }
    const next = items.slice(shown, shown + n);
    feed.insertAdjacentHTML('beforeend', next.map(g => postHtml(g, o.highlight(), o.quick)).join(''));
    shown += next.length;
    next.forEach(g => { if (shotAt[g.id]) setShot(feed.querySelector(`[data-id="${g.id}"]`), shotAt[g.id], false); });
    sentinel.classList.toggle('hidden', shown >= items.length);
    if (shown < items.length) { obs.unobserve(sentinel); obs.observe(sentinel); }
  }

  // Haalt de volgende API-pagina op zodra de huidige op is (alleen bij zoeken)
  async function extend() {
    if (extending) return;
    extending = true;
    const cur = items;
    try {
      const r = await o.loadMore();
      if (items !== cur) return;
      const have = new Set(items.map(g => g.id));
      const add = r.items.filter(g => !have.has(g.id));
      items.push(...add);
      total = r.total;
      if (!add.length) total = items.length; // API gaf alleen duplicaten: niet blijven opnieuw proberen
      info();
    } catch (e) {
      toast('Meer games laden is mislukt: ' + (e.message || 'onbekende fout'));
    } finally {
      extending = false;
      sentinel.classList.toggle('hidden', shown >= items.length && !(o.loadMore && total > items.length));
    }
  }

  // Vervangt alle games; st = bewaarde stand (scrollpositie en aantal posts) bij terugkeren
  function info() {
    $('#fpInfo').textContent = (total > items.length ? `${items.length} van ${total.toLocaleString('nl-NL')}` : items.length) + (total === 1 ? ' game' : ' games');
  }

  function setItems(list, count = list.length, st = null) {
    resetUrls();
    items = list; total = count; shown = 0; activeId = null; lock = 0;
    info();
    listEl.innerHTML = list.map(g =>
      `<button data-id="${g.id}" class="favGame block w-full border-b border-edge px-4 py-2.5 text-left text-sm hover:bg-night">${esc(g.name)}</button>`).join('');
    feed.innerHTML = list.length ? '' : `<p class="text-center text-mute">${o.empty}</p>`;
    more(st ? Math.max(st.shown, BATCH) : BATCH);
    window.scrollTo(0, st ? st.y : 0);
    spy();
  }

  // Haalt één game uit de feed en de lijst (bij uitliken op de favorietenpagina)
  function remove(id) {
    const k = items.findIndex(g => g.id === id);
    if (k < 0) return;
    items.splice(k, 1);
    if (k < shown) shown--;
    total = items.length;
    const art = feed.querySelector(`[data-id="${id}"]`), b = listEl.querySelector(`[data-id="${id}"]`);
    if (art) art.remove();
    if (b) b.remove();
    if (activeId === id) activeId = null;
    info();
    if (!items.length) feed.innerHTML = `<p class="text-center text-mute">${o.empty}</p>`;
    sentinel.classList.toggle('hidden', shown >= items.length);
    spy();
  }

  function loading() {
    resetUrls();
    items = []; shown = 0; activeId = null;
    $('#fpInfo').textContent = '';
    listEl.innerHTML = '';
    sentinel.classList.add('hidden');
    feed.innerHTML = loader;
  }

  $('#fpPlatform').onchange = e => o.onPlatform(e.target.value);
  $('#fpSort').onchange = e => o.onSort(e.target.value);

  // Klik in de lijst: scroll naar die game
  listEl.onclick = e => {
    const b = e.target.closest('.favGame');
    if (b) jumpTo(+b.dataset.id);
  };

  feed.onclick = e => {
    const a = e.target.closest('article');
    if (!a) return;
    const lk = e.target.closest('.like');
    if (lk) {
      const id = +a.dataset.id;
      quickLike(lk, id).then(() => { if (o.onUnlike && !liked.has(id)) o.onUnlike(id); });
      return;
    }
    const nv = e.target.closest('.nav');
    if (nv) { setShot(a, (+a.dataset.i || 0) + +nv.dataset.d); return; }
    const th = e.target.closest('.thumb');
    if (th) { setShot(a, [...a.querySelectorAll('.thumb')].indexOf(th)); return; }
    if (!e.target.closest('.open')) return;
    feedState = { key: o.key, y: window.scrollY, shown }; // om na "Terug" op dezelfde plek uit te komen
    viewGame(+a.dataset.id);
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('keydown', onKey);
  feedCleanup = dispose;
  return { setItems, loading, remove };
}

// ---------- Hoofdpagina: zoeken bij RAWG ----------
const fromApi = g => ({
  id: g.id, name: g.name, released: g.released,
  genres: (g.genres || []).map(x => x.name),
  platforms: (g.platforms || []).map(p => p.platform.name),
  cover: g.background_image,
  screenshots: (g.short_screenshots || []).map(x => x.image),
  description: ''
});

let pageNo = 1;
async function fetchGames(page = pageNo) {
  const p = { page_size: 24, page };
  if (query) p.search = query;
  const ord = mainSort === 'rel' ? (query ? '' : '-added') : SORT_API[mainSort];
  if (ord) p.ordering = ord;
  if (plat) p.platforms = plat;
  const d = await api('/games', p);
  return { items: d.results.map(fromApi), total: d.count };
}

async function viewSearch(q = query, restore = false) {
  query = q;
  pageNo = 1;
  prev = () => viewSearch(query, true);
  resetUrls();
  const me = ++nav;
  if (!KEY) return viewKey();
  app.innerHTML = loader;
  try {
    await loadPlatforms();
    const r = await fetchGames();
    if (me !== nav) return;
    const reload = async () => {
      const again = ++nav;
      pageNo = 1;
      page.loading();
      try {
        const r2 = await fetchGames();
        if (again === nav) page.setItems(r2.items, r2.total);
      } catch (e) { if (again === nav) fail(e); }
    };
    const page = feedPage({
      key: 'search', quick: true, empty: 'Geen games gevonden. Probeer een andere zoekterm.',
      platforms: [['', 'Alle platforms'], ...platList.map(p => [String(p.id), p.name])], platform: plat,
      sorts: SORT_MAIN, sort: mainSort,
      highlight: () => (platList.find(p => String(p.id) === plat) || {}).name || '',
      onPlatform: v => { plat = v; reload(); },
      onSort: v => { mainSort = v; reload(); },
      loadMore: async () => {
        const p = pageNo + 1;
        const r = await fetchGames(p);
        if (pageNo === p - 1) pageNo = p;
        return r;
      }
    });
    page.setItems(r.items, r.total, restore && feedState && feedState.key === 'search' ? feedState : null);
  } catch (e) { if (me === nav) fail(e); }
}

// ---------- Favorieten ----------
async function viewLiked(restore = false) {
  prev = () => viewLiked(true);
  resetUrls();
  const me = ++nav;
  const list = (await dbAll().catch(() => [])) || [];
  if (me !== nav) return;
  if (!list.length) { app.innerHTML = '<p class="text-mute">Nog geen favorieten.</p>'; return; }

  if (!SORTERS[favSort]) favSort = 'new';
  const names = [...new Set(list.flatMap(g => g.platforms || []))].sort((a, b) => a.localeCompare(b));
  if (!names.includes(favPlat)) favPlat = '';
  const view = () => list.filter(g => !favPlat || (g.platforms || []).includes(favPlat)).sort(SORTERS[favSort]);

  const page = feedPage({
    key: 'fav', quick: true, empty: 'Geen favorieten voor dit platform.',
    platforms: [['', 'Alle platforms'], ...names.map(n => [n, n])], platform: favPlat,
    sorts: SORT_LOCAL, sort: favSort,
    highlight: () => favPlat,
    onPlatform: v => { favPlat = v; page.setItems(view()); },
    onSort: v => { favSort = v; page.setItems(view()); },
    onUnlike: id => {
      const k = list.findIndex(g => g.id === id);
      if (k >= 0) list.splice(k, 1);
      if (!list.length) { feedCleanup(); app.innerHTML = '<p class="text-mute">Nog geen favorieten.</p>'; return; }
      page.remove(id);
    }
  });
  page.setItems(view(), undefined, restore && feedState && feedState.key === 'fav' ? feedState : null);
}

// ---------- Games ophalen en in- of uit de favorieten zetten ----------
// ---------- GitHub als spiegel van opgeslagen games ----------
// Na `php sync.php` staan opgeslagen games ook in deze repo. Eerst daar kijken
// kost geen RAWG-API-calls; alleen onbekende games gaan alsnog naar de API.
const REPO_RAW = 'https://raw.githubusercontent.com/Panman-Alfa-College/gamekast/main';
let repoIndex = null;
async function repoFolder(id) {
  if (repoIndex === null) {
    try {
      const r = await fetch(REPO_RAW + '/games/index.json');
      repoIndex = r.ok ? await r.json() : {};
    } catch { repoIndex = {}; }
  }
  return repoIndex[id] || '';
}
const fromInfo = (d, folder) => ({
  id: d.id, name: d.naam, released: d.uitgebracht, rating: d.beoordeling, metacritic: d.metacritic,
  genres: d.genres || [], platforms: d.platforms || [], developers: d.ontwikkelaars || [],
  description: d.beschrijving || '', website: d.website || '', vanGithub: true,
  cover: d.afbeeldingen?.cover ? `${REPO_RAW}/games/${folder}/${d.afbeeldingen.cover}` : '',
  screenshots: (d.afbeeldingen?.screenshots || []).map(n => `${REPO_RAW}/games/${folder}/${n}`)
});

async function fetchGame(id) {
  const folder = await repoFolder(id);
  if (folder) {
    try {
      const r = await fetch(`${REPO_RAW}/games/${folder}/info.json`);
      if (r.ok) return fromInfo(await r.json(), folder);
    } catch { } // GitHub onbereikbaar of game er niet in: gewoon de API proberen
  }
  const [d, s] = await Promise.all([api('/games/' + id), api(`/games/${id}/screenshots`)]);
  return {
    id: d.id, name: d.name, released: d.released, rating: d.rating, metacritic: d.metacritic,
    genres: (d.genres || []).map(x => x.name),
    platforms: (d.platforms || []).map(p => p.platform.name),
    developers: (d.developers || []).map(x => x.name),
    description: d.description_raw, website: d.website,
    cover: d.background_image, screenshots: s.results.map(x => x.image)
  };
}

// Zet een game in of uit de favorieten (bestanden op schijf blijven bij uitliken staan)
async function toggleLike(g) {
  if (liked.has(g.id)) {
    await dbDel(g.id); liked.delete(g.id);
    toast('Verwijderd uit je favorieten. Bestanden op schijf blijven staan.');
  } else {
    const saved = await saveLocal(g);
    await dbPut(saved); liked.add(g.id);
    const note = saved.offline ? '' : ' Let op: sommige afbeeldingen konden niet worden gedownload.';
    let msg;
    try { msg = `Opgeslagen op de server in games/${await saveToServer(saved)}.`; }
    catch (err) { msg = 'Opgeslagen in de browser, maar niet op de server: ' + err.message + '.'; }
    toast(msg + note);
  }
  updateCount();
}

// Hartje in de feed: haalt eerst de volledige game op, zodat de favoriet compleet is
async function quickLike(btn, id) {
  paintLike(btn, id, true);
  try {
    await toggleLike(liked.has(id) ? { id } : await fetchGame(id));
  } catch (e) {
    toast(e instanceof TypeError ? 'Geen verbinding met de API.'
      : e instanceof DOMException ? 'Opslaan is mislukt. Staat opslag in je browser uit?' : e.message);
  }
  paintLike(btn, id);
}

async function viewGame(id) {
  const me = ++nav;
  resetUrls();
  app.innerHTML = loader;
  let g = await dbGet(id).catch(() => null);
  if (me !== nav) return;
  const local = !!g; // staat hij in de lokale opslag, dan komt alles daarvandaan
  try {
    if (!g) {
      g = await fetchGame(id);
    }
  } catch (e) { if (me === nav) fail(e); return; }
  if (me !== nav) return;

  const row = (l, v) => v ? `<div><dt class="text-mute">${l}</dt><dd class="font-medium">${esc(v)}</dd></div>` : '';
  const date = g.released ? new Date(g.released).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const site = /^https?:\/\//.test(g.website || '')
    ? `<div><dt class="text-mute">Website</dt><dd><a class="text-gold underline" href="${esc(g.website)}" target="_blank" rel="noopener">${esc(g.website)}</a></dd></div>` : '';

  app.innerHTML = `
  <button id="back" class="mb-4 text-sm text-mute hover:text-white">Terug naar overzicht</button>
  <div class="relative mb-6 h-56 overflow-hidden rounded-2xl bg-panel sm:h-72">
${g.cover ? `<img src="${esc(src(g.cover))}" alt="" class="absolute inset-0 h-full w-full object-cover">` : ''}
<div class="absolute inset-0 bg-gradient-to-t from-night via-night/60 to-transparent"></div>
<div class="absolute inset-x-0 bottom-0 flex flex-wrap items-end justify-between gap-3 p-5">
  <div>
    <h1 class="font-display text-3xl font-extrabold sm:text-4xl">${esc(g.name)}</h1>
    ${local ? '<p class="mt-1 text-sm text-gold">Geladen uit je lokale opslag</p>' : g.vanGithub ? '<p class="mt-1 text-sm text-gold">Geladen van GitHub (geen API-call)</p>' : ''}
  </div>
  <button id="like"></button>
</div>
  </div>
  <div class="grid gap-6 lg:grid-cols-3">
<div class="lg:col-span-2">
  <h2 class="mb-2 font-display text-xl font-semibold">Over deze game</h2>
  <p class="mb-8 max-w-prose whitespace-pre-line leading-relaxed text-[#d9d5f5]">${esc(g.description || 'Geen beschrijving beschikbaar.')}</p>
  <h2 class="mb-3 font-display text-xl font-semibold">Screenshots</h2>
  ${g.screenshots.length ? `<div class="grid gap-3 sm:grid-cols-2">${g.screenshots.map(x =>
    `<img src="${esc(src(x))}" loading="lazy" alt="Screenshot van ${esc(g.name)}" class="shot aspect-video w-full cursor-zoom-in rounded-lg object-cover">`).join('')}</div>`
      : '<p class="text-mute">Geen screenshots beschikbaar.</p>'}
</div>
<aside>
  <dl class="space-y-3 rounded-xl border border-edge bg-panel p-4 text-sm">
    ${row('Verschijningsdatum', date)}
    ${row('Beoordeling', g.rating ? g.rating + ' van 5' : '')}
    ${row('Metacritic', g.metacritic)}
    ${row('Genres', g.genres.join(', '))}
    ${row('Platforms', g.platforms.join(', '))}
    ${row('Ontwikkelaar', g.developers.join(', '))}
    ${site}
  </dl>
</aside>
  </div>`;

  $('#back').onclick = () => prev();
  const btn = $('#like');
  const paint = () => {
    const on = liked.has(g.id);
    btn.textContent = on ? '♥ Opgeslagen' : '♡ Like';
    btn.className = 'rounded-lg border px-4 py-2 font-semibold ' + (on ? 'border-coral bg-coral text-white' : 'border-white/30 bg-night/60 hover:bg-night');
  };
  paint();
  btn.onclick = async () => {
    btn.disabled = true;
    if (!liked.has(g.id)) btn.textContent = 'Opslaan…';
    try { await toggleLike(g); } catch { toast('Opslaan is mislukt. Staat opslag in je browser uit?'); }
    btn.disabled = false; paint(); updateCount();
  };
}

// ---------- Platformen (RAWG), 30 dagen onthouden ----------
let platList = null; // [{ id, name }]
async function loadPlatforms() {
  if (platList) return;
  try {
    const c = JSON.parse(ls.get('rawg_platforms') || 'null');
    if (c && Date.now() - c.t < 30 * 864e5) { platList = c.d; return; }
  } catch { }
  const data = await api('/platforms', { page_size: 100 });
  platList = data.results.map(p => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name));
  ls.set('rawg_platforms', JSON.stringify({ t: Date.now(), d: platList }));
}

// ---------- Gebeurtenissen ----------
$('#searchForm').onsubmit = e => { e.preventDefault(); viewSearch($('#q').value.trim()); };
$('#home').onclick = () => { $('#q').value = ''; plat = ''; mainSort = 'rel'; viewSearch(''); };
$('#navLiked').onclick = () => viewLiked();
$('#keyBtn').onclick = viewKey;

let lastFocus = null;
document.addEventListener('click', e => {
  const i = e.target.closest('.shot');
  if (!i) return;
  $('#lbImg').src = i.src;
  $('#lbImg').alt = i.alt;
  lastFocus = document.activeElement;
  const lb = $('#lightbox');
  lb.classList.replace('hidden', 'flex');
  lb.focus();
});
const closeLb = () => {
  const lb = $('#lightbox');
  if (lb.classList.contains('hidden')) return;
  lb.classList.replace('flex', 'hidden');
  if (lastFocus) lastFocus.focus();
};
$('#lightbox').onclick = closeLb;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeLb();
  if (e.key === 'Tab' && !$('#lightbox').classList.contains('hidden')) e.preventDefault();
});

(async () => {
  try { liked = new Set(((await dbAll()) || []).map(g => g.id)); } catch { }
  updateCount();
  KEY ? viewSearch('') : viewKey();
})();
  
