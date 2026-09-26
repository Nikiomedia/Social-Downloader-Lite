/**
 * app.js – Aurora Vault front end.
 * State, server communication (REST + Server-Sent Events), gallery rendering,
 * tabs, selection mode, downloads, ZIP vault and all the little surprises.
 */
import { t, errText, apply as applyI18n, setLang, getLang, fmtNumber, fmtBytes } from './i18n.js';
import { createAurora, PALETTES } from './aurora.js';
import {
    initParticles, burst, burstAt, initCursor, initMagnetic, scramble, countTo,
    renderHeadline, initHeadlineField, initShootingStars, onKonami, flyTo, reduce, finePointer,
} from './fx.js';
import { createLightbox } from './lightbox.js';
import { createSnake } from './game.js';
import { paintSoft } from './card-spin.js';

const $ = (id) => document.getElementById(id);
const store = {
    get(k, d) { try { const v = localStorage.getItem('av.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('av.' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

const S = {
    status: { loggedIn: false, loginPending: false },
    scanId: null,
    meta: null,
    items: new Map(),       // id → item
    order: [],              // ids in scan order
    tab: 'all',
    selecting: false,
    selected: new Set(),
    lastPicked: null,
    density: store.get('density', 'm'),
    hdOnly: store.get('hdOnly', false),
    downloaded: new Set(),  // item ids downloaded from this profile (remembered per profile in the browser)
    favorites: [],
    es: null,
    job: null,
    jobEs: null,
    lastZip: null,
};

const els = {
    app: $('app'), hero: $('hero'), results: $('results'), grid: $('grid'), empty: $('empty'),
    form: $('scanForm'), input: $('scanInput'), scanBtn: $('scanBtn'),
    band: $('band'), dock: $('dock'), vault: $('vault'), toasts: $('toasts'), conn: $('conn'), menu: $('connMenu'),
};
const tiles = new Map();    // id → tile element
let game = null;            // Aurora Snake (created further down)
let lastBusy = null;        // what was running on the last check (scan / zip / hd)

/* ================================================================ helpers */

async function api(path, body, method) {
    let res;
    try {
        res = await fetch(path, {
            method: method || (body ? 'POST' : 'GET'),
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw Object.assign(new Error('NETWORK'), { code: 'NETWORK' });
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || 'HTTP_' + res.status), { code: data?.error || 'HTTP_' + res.status, detail: data?.detail });
    return data;
}

function toast(text, kind = 'info', ms = 4200) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.style.setProperty('--t', `${ms}ms`);
    const dot = document.createElement('i');
    const msg = document.createElement('div');
    msg.textContent = text;
    el.append(dot, msg);
    els.toasts.prepend(el);
    while (els.toasts.children.length > 4) els.toasts.lastElementChild.remove();
    const kill = () => { el.classList.add('is-out'); setTimeout(() => el.remove(), 360); };
    const timer = setTimeout(kill, ms);
    el.addEventListener('click', () => { clearTimeout(timer); kill(); });
}

const counts = () => {
    let image = 0, reel = 0, ready = 0;
    for (const it of S.items.values()) { if (it.type === 'image') image++; else reel++; if (it.hd) ready++; }
    return { image, reel, all: image + reel, ready };
};

const inTab = (it) => S.tab === 'all' || it.type === S.tab;
const isVisible = (it) => inTab(it) && (!S.hdOnly || it.hd);
const visibleItems = () => S.order.map((id) => S.items.get(id)).filter(isVisible);
const mediaUrl = (item) => `/api/scans/${S.scanId}/items/${item.id}/media`;
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function nameFromDisposition(h) {
    if (!h) return '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(h);
    if (star) return decodeURIComponent(star[1]);
    const plain = /filename="([^"]+)"/i.exec(h);
    return plain ? plain[1] : '';
}

/* ============================================================ background */

const aurora = createAurora($('aurora'));
initParticles($('fx'));
initCursor($('cursorDot'), $('cursorRing'), (kind) => {
    if (kind === 'open') return S.selecting ? t('cursorPick') : t('cursorOpen');
    if (kind === 'save') return t('cursorSave');
    if (kind === 'scan') return t('cursorScan');
    if (kind === 'pro') return t('cursorPro');
    return '';
});
initMagnetic();
initShootingStars();

let palette = store.get('palette', 'aurora');
if (!PALETTES[palette]) palette = 'aurora';
aurora.setPalette(palette);
$('paletteName').textContent = PALETTES[palette].name;
$('btnPalette').addEventListener('click', (e) => {
    const keys = Object.keys(PALETTES);
    palette = keys[(keys.indexOf(palette) + 1) % keys.length];
    aurora.setPalette(palette);
    store.set('palette', palette);
    scramble($('paletteName'), PALETTES[palette].name);
    aurora.ripple(e.clientX, e.clientY, 1.4);
    burstAt(e.currentTarget, { count: 18, speed: 4 });
});

function hyperdrive() {
    aurora.hyper(4800);
    burst(window.innerWidth / 2, window.innerHeight / 2, { count: 90, speed: 11, gravity: 0.02, life: 80 });
    toast(t('toastHyper'), 'ok', 3200);
}
onKonami(hyperdrive);

// ripple when clicking empty space
document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, a, input, label, .tile, .band, .dock, .vault, .lightbox, .menu, .scanner, .toast, .stack')) return;
    aurora.ripple(e.clientX, e.clientY, 1);
});

// scroll progress line + sticky tab bar state
const scrollLine = $('scrollLine');
const tabsbar = $('tabsbar');
window.addEventListener('scroll', () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    scrollLine.style.setProperty('--p', max > 0 ? String(window.scrollY / max) : '0');
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header')) || 68;
    tabsbar.classList.toggle('is-stuck', !els.results.hidden && tabsbar.getBoundingClientRect().top <= top + 1);
}, { passive: true });

/* ================================================================== hero */

const headline = $('headline');
function renderHero() {
    renderHeadline(headline, t('headline'));
}
initHeadlineField(headline);

// floating card stack follows the pointer
const stackInner = $('stackInner');
if (finePointer && !reduce) {
    window.addEventListener('pointermove', (e) => {
        if (els.hero.offsetParent === null) return;
        const nx = e.clientX / window.innerWidth - 0.5;
        const ny = e.clientY / window.innerHeight - 0.5;
        stackInner.style.setProperty('--sry', `${(-14 + nx * 16).toFixed(2)}deg`);
        stackInner.style.setProperty('--srx', `${(6 - ny * 12).toFixed(2)}deg`);
    }, { passive: true });
}

// placeholder typewriter
const EXAMPLES = ['facebook.com/profile.php?id=61594033984017', 'facebook.com/nikomedia', 'https://www.facebook.com/people/Name/1000…'];
(function typewriter() {
    let ex = 0, i = 0, dir = 1;
    const step = () => {
        const text = EXAMPLES[ex];
        if (!els.results.hidden) {
            els.input.placeholder = t('scanAnother');
        } else if (document.activeElement !== els.input && !els.input.value) {
            i += dir;
            els.input.placeholder = text.slice(0, Math.max(0, i)) + (dir > 0 ? '▍' : '');
            if (i >= text.length + 18) dir = -1;
            else if (i <= 0 && dir < 0) { dir = 1; ex = (ex + 1) % EXAMPLES.length; }
        } else {
            els.input.placeholder = EXAMPLES[0];
        }
        setTimeout(step, dir > 0 ? (i > text.length ? 90 : 55) : 22);
    };
    if (reduce) els.input.placeholder = EXAMPLES[0]; else step();
})();

/* ============================================================ connection */

function renderConn() {
    const st = S.status;
    const state = st.loginPending ? 'pending' : st.loggedIn ? 'on' : 'off';
    els.conn.dataset.state = state;
    const label = $('connLabel');
    label.textContent = state === 'pending' ? t('connecting') : state === 'on' ? (st.name || t('connected')) : t('connect');
    const av = $('connAvatar');
    if (state === 'on' && st.avatar) {
        if (av.dataset.src !== st.avatar) {
            av.dataset.src = st.avatar;
            const im = new Image();
            im.alt = '';
            im.onload = () => av.replaceChildren(im);
            im.onerror = () => { av.textContent = initials(st.name); };
            im.src = st.avatar;
        }
    } else if (state === 'on') {
        av.textContent = initials(st.name);
    } else {
        delete av.dataset.src;
        av.innerHTML = '<svg width="15" height="15"><use href="#i-plug"/></svg>';
    }
    $('menuName').textContent = st.name || t('connected');
    $('menuUid').textContent = st.uid ? `ID ${st.uid}` : '';
    $('menuReconnect').hidden = state === 'pending';
    $('menuLogout').hidden = state !== 'on';
    $('menuCancel').hidden = state !== 'pending';
    els.menu.querySelector('.menu-head').hidden = state !== 'on';
    $('hintLogin').textContent = state === 'on' ? t('loggedHint', { name: st.name || t('connected') }) : t('needLogin');
    $('hintLogin').style.setProperty('--c', state === 'on' ? 'var(--ok)' : 'var(--warn)');
    $('hintLogin').classList.toggle('is-on', state === 'on');
}

let statusTimer = 0;
async function pollStatus() {
    clearTimeout(statusTimer);
    try {
        const prev = S.status;
        S.status = await api('/api/status');
        if (prev.loginPending && !S.status.loginPending && S.status.loggedIn) {
            toast(t('toastLoggedIn', { name: S.status.name || 'Facebook' }), 'ok');
            burstAt(els.conn, { count: 30 });
        }
        renderConn();
    } catch { /* server not reachable – retry */ }
    statusTimer = setTimeout(pollStatus, S.status.loginPending ? 1500 : 15000);
}

async function login() {
    try {
        S.status = await api('/api/login', {});
        S.status.loginPending = true;
        renderConn();
        toast(t('toastLoginOpened'), 'info', 6000);
        pollStatus();
    } catch (e) {
        toast(errText(e.code, e.detail), 'err', 7000);
    }
}

els.conn.addEventListener('click', (e) => {
    e.stopPropagation();
    fav.menu.hidden = true;
    if (els.conn.dataset.state === 'off') return login();
    els.menu.hidden = !els.menu.hidden;
});
document.addEventListener('click', (e) => { if (!els.menu.hidden && !e.target.closest('#connMenu')) els.menu.hidden = true; });
$('menuReconnect').addEventListener('click', () => { els.menu.hidden = true; login(); });
$('menuCancel').addEventListener('click', async () => { els.menu.hidden = true; S.status = await api('/api/login/cancel', {}).catch(() => S.status); renderConn(); });
$('menuLogout').addEventListener('click', async () => {
    els.menu.hidden = true;
    S.status = await api('/api/logout', {}).catch(() => S.status);
    renderConn();
    toast(t('toastLoggedOut'), 'info');
});


/* ================================================================== scan */

function moveScanner(toTop) {
    const host = toTop ? $('scannerTop') : $('scannerHome');
    if (els.form.parentElement !== host) host.append(els.form);
}

function showResults(on) {
    els.results.hidden = !on;
    els.app.classList.toggle('has-scan', on);
    moveScanner(on);
    if (!on) setSelecting(false);
    updateDock();
}

function resetResults() {
    stopPreview(true);
    if (S.es) { S.es.close(); S.es = null; }
    S.items.clear(); S.order = []; S.selected.clear(); tiles.clear();
    skeletons.length = 0;
    els.grid.replaceChildren();
    S.meta = null;
    ['statImages', 'statReels', 'statHd'].forEach((id) => { $(id)._v = 0; $(id).textContent = '0'; });
    $('profileName').textContent = '…';
    $('avatar').replaceChildren();
    $('followers').textContent = '';
    $('profileLink').textContent = '';
    S._dlLoadedFor = null;
    S.downloaded = new Set();
    const ctx = $('bandCover').getContext('2d'); ctx && ctx.clearRect(0, 0, 32, 32);
}

async function startScan(raw) {
    const url = String(raw || '').trim();
    if (!url) {
        els.input.focus();
        els.form.animate([{ translate: '0' }, { translate: '-8px' }, { translate: '8px' }, { translate: '-4px' }, { translate: '0' }], { duration: 380 });
        return;
    }
    const demo = /^demo$/i.test(url);
    if (!demo && !S.status.loggedIn) {
        toast(errText('LOGIN_REQUIRED'), 'warn');
        els.conn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 500, easing: 'cubic-bezier(.34,1.56,.64,1)' });
        burstAt(els.conn, { count: 14, speed: 3 });
        return;
    }
    els.scanBtn.disabled = true;
    try {
        const { id } = await api('/api/scans', { url });
        store.set('lastUrl', demo ? store.get('lastUrl', '') : url);
        const r = els.scanBtn.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, { count: 34, speed: 6 });
        aurora.ripple(r.left + r.width / 2, r.top + r.height / 2, 1.6);
        resetResults();
        S.scanId = id;
        showResults(true);
        setTab('all', true);
        els.input.value = demo ? '' : url;
        if (demo) toast(t('toastDemo'), 'ok');
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
        connectEvents(id);
    } catch (e) {
        toast(errText(e.code, e.detail), 'err', 6000);
    } finally {
        els.scanBtn.disabled = false;
    }
}

function connectEvents(id) {
    const es = new EventSource(`/api/scans/${id}/events`);
    S.es = es;
    let failures = 0;
    es.addEventListener('snapshot', (e) => {
        failures = 0;
        const d = JSON.parse(e.data);
        applyMeta(d.meta);
        addItems(d.items, true);
    });
    es.addEventListener('meta', (e) => applyMeta(JSON.parse(e.data)));
    es.addEventListener('items', (e) => addItems(JSON.parse(e.data)));
    es.addEventListener('update', (e) => updateItems(JSON.parse(e.data)));
    es.addEventListener('notice', (e) => {
        const d = JSON.parse(e.data);
        toast(errText(d.code), d.code === 'RATE_LIMITED' || d.code === 'NO_REELS_TAB' ? 'warn' : 'err', 6500);
        if (d.code === 'LOGIN_REQUIRED') pollStatus();
    });
    es.onerror = () => {
        failures++;
        if (failures > 3 && S.es === es) { es.close(); toast(errText('NETWORK'), 'err', 8000); }
    };
}

let prevStatus = null;
function applyMeta(meta) {
    const first = !S.meta;
    S.meta = meta;
    const p = meta.profile;
    if (p) {
        const nameEl = $('profileName');
        if (nameEl.dataset.name !== p.name) { nameEl.dataset.name = p.name; scramble(nameEl, p.name || 'Facebook', { duration: 900 }); }
        const av = $('avatar');
        if (p.avatar && av.dataset.src !== p.avatar) {
            av.dataset.src = p.avatar;
            const im = new Image(); im.alt = '';
            im.onload = () => av.replaceChildren(im);
            im.onerror = () => { av.textContent = initials(p.name); };
            im.src = p.avatar;
        } else if (!p.avatar) av.textContent = initials(p.name);
        const coverSrc = p.cover || p.avatar;
        if (coverSrc && $('bandCover').dataset.src !== coverSrc) { $('bandCover').dataset.src = coverSrc; paintSoft($('bandCover'), coverSrc); }
        $('followers').textContent = p.followers || '';
        const link = $('profileLink');
        link.href = p.url || '#';
        link.textContent = (p.url || '').replace(/^https?:\/\/(www\.)?/, '');
    }
    if (meta.favKey && S._dlLoadedFor !== meta.favKey) { S._dlLoadedFor = meta.favKey; loadDownloaded(); }
    renderFavState();
    renderCounts();
    const running = meta.status === 'running';
    els.band.classList.toggle('is-scanning', running);
    els.band.classList.toggle('is-error', meta.status === 'error');
    if (meta.status === 'error') {
        toast(errText(meta.error), 'err', 8000);
        if (meta.error === 'LOGIN_REQUIRED') pollStatus();
    }
    if (prevStatus === 'running' && meta.status === 'done' && !first) {
        const c = counts();
        toast(t('toastScanDone', { images: c.image, reels: c.reel }), 'ok');
        burstAt($('avatar'), { count: 40, speed: 6 });
    }
    prevStatus = meta.status;
    renderPhase();
    renderEmpty();
}

function renderPhase() {
    const meta = S.meta;
    if (!meta) return;
    const running = meta.status === 'running';
    const phase = running ? (meta.phase === 'starting' ? 'starting' : meta.phase) : meta.status;
    $('phaseText').textContent = t('phase_' + phase) || phase;
    $('scanStatus').hidden = !running;
    $('scanBar').hidden = !running;
    const c = counts();
    $('scanStatusText').textContent = t('scanFound', { images: fmtNumber(c.image), reels: fmtNumber(c.reel) });
    // stepper: photos → reels → done
    const idx = meta.status === 'done' ? 3 : Math.max(0, ['images', 'reels', 'done'].indexOf(meta.phase === 'starting' ? 'images' : meta.phase));
    document.querySelectorAll('#scanSteps .step').forEach((st, i) => { st.classList.toggle('is-done', i < idx); st.classList.toggle('is-active', running && i === idx); });
    document.querySelectorAll('#scanSteps .step-line').forEach((ln, i) => { ln.classList.toggle('is-done', i < idx); ln.classList.toggle('is-active', running && i === idx); });
    ensureSkeletons(running);
    refreshBusy();
}

/* shimmering placeholder tiles at the end of the grid while the scan is still running */
const skeletons = [];
const SK_RATIOS = [1.25, 1.78, 1, 1.33, 1.78, 0.8, 1.25, 1];
function spanSkeletons(gap = measureCols()) {
    skeletons.forEach((sk, i) => { sk.style.gridRowEnd = `span ${Math.max(20, Math.round((colW * SK_RATIOS[i % SK_RATIOS.length] + gap) / 2))}`; });
}
function ensureSkeletons(on) {
    if (on && !skeletons.length) {
        for (let i = 0; i < SK_RATIOS.length; i++) {
            const sk = document.createElement('div');
            sk.className = 'tile skeleton';
            sk.setAttribute('aria-hidden', 'true');
            sk.innerHTML = '<div class="tile-card"></div>';
            skeletons.push(sk);
            els.grid.append(sk);
        }
        spanSkeletons();
    } else if (!on && skeletons.length) {
        for (const sk of skeletons.splice(0)) { sk.classList.add('is-leaving'); setTimeout(() => sk.remove(), 420); }
    }
}

/* ================================================================ tiles */

function ratioOf(it) { return Math.min(1.8, Math.max(0.56, (it.height || 1) / (it.width || 1))); }

let colW = 0;
function measureCols() {
    const g = els.grid;
    const cs = getComputedStyle(g);
    const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const gap = parseFloat(cs.columnGap) || 14;
    colW = (g.clientWidth - gap * (cols - 1)) / cols;
    return gap;
}
function spanTile(tile, it, gap) {
    const h = colW * ratioOf(it) + gap;
    tile.style.gridRowEnd = `span ${Math.max(20, Math.round(h / 2))}`;
}
function layoutAll() {
    const gap = measureCols();
    for (const [id, tile] of tiles) spanTile(tile, S.items.get(id), gap);
    spanSkeletons(gap);
}
new ResizeObserver(() => requestAnimationFrame(layoutAll)).observe(els.grid);

function chipHtml(it) {
    const top = it.type === 'reel'
        ? `<span class="chip reel"><svg><use href="#i-reel"/></svg>Reel</span>`
        : `<span class="chip"><svg><use href="#i-image"/></svg>${it.width}×${it.height}</span>`;
    const bottom = it.type === 'reel' && it.views ? `<span class="chip"><svg><use href="#i-eye"/></svg>${escapeHtml(it.views)}</span>` : '';
    return { top, bottom };
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function createTile(it, delay) {
    const tile = document.createElement('div');
    tile.className = 'tile is-new';
    tile.setAttribute('role', 'listitem');
    tile.dataset.id = it.id;
    tile.style.setProperty('--d', `${delay}ms`);
    const { top, bottom } = chipHtml(it);
    tile.innerHTML = `
        <div class="tile-card">
            <button class="tile-open" type="button" data-cursor="open"><img alt="" decoding="async" loading="lazy"></button>
            <div class="tile-shade"></div>
            <div class="tile-top"><span class="tile-kind">${top}</span><span class="chip hd">HD</span></div>
            <div class="tile-bottom">${bottom}<span class="chip dl" hidden><svg><use href="#i-check"/></svg><span data-i18n="chipDownloaded">${t('chipDownloaded')}</span></span></div>
            ${it.type === 'reel' ? '<span class="tile-progress" aria-hidden="true"><i></i></span>' : ''}
            <span class="tile-check"><svg><use href="#i-check"/></svg></span>
            <button class="tile-dl" type="button" data-cursor="save" data-magnetic>
                <svg class="ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18"/></svg>
                <svg class="i-dl"><use href="#i-download"/></svg>
                <svg class="i-check"><use href="#i-check"/></svg>
            </button>
        </div>`;
    const img = tile.querySelector('img');
    img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true });
    if (it.thumb) img.src = it.thumb;
    tile.querySelector('.tile-open').setAttribute('aria-label', `${t('tileOpen')}: ${it.alt || (it.type === 'reel' ? 'Reel' : t('lbImage'))} ${it.fbid}`);
    tile.querySelector('.tile-dl').setAttribute('aria-label', t('tileDownload'));
    setTimeout(() => tile.classList.remove('is-new'), 1300 + delay);
    syncTile(tile, it);
    return tile;
}

function upgradeThumb(tile, it) {
    // grid thumbnails from Facebook are small square crops → swap in the full image once its link is known
    if (tile._hq || it.type !== 'image' || it.status !== 'ready') return;
    tile._hq = true;
    const src = mediaUrl(it);
    const pre = new Image();
    pre.onload = () => {
        const img = tile.querySelector('.tile-open img');
        if (img) { img.src = src; img.classList.add('is-loaded'); }
    };
    pre.src = src;
}

function syncTile(tile, it) {
    tile.classList.toggle('is-ready', it.status === 'ready');
    upgradeThumb(tile, it);
    tile.classList.toggle('is-selected', S.selected.has(it.id));
    tile.querySelector('.chip.dl').hidden = !S.downloaded.has(it.id);
    const hdChip = tile.querySelector('.chip.hd');
    const sd = it.type === 'reel' && it.quality === 'SD';
    hdChip.textContent = sd ? 'SD' : 'HD';
    hdChip.classList.toggle('is-sd', sd);
    const img = tile.querySelector('.tile-open img');
    if (it.thumb && !tile._hq && img.getAttribute('src') !== it.thumb) img.src = it.thumb;
    if (it.type === 'image') {
        const kind = tile.querySelector('.tile-kind .chip');
        if (kind) kind.lastChild.textContent = `${it.width}×${it.height}`;
    }
    const show = isVisible(it);
    const was = !tile.classList.contains('is-hidden');
    tile.classList.toggle('is-hidden', !show);
    if (show && !was && S.hdOnly) {      // appears because its HD link was just found
        tile.classList.remove('is-new'); void tile.offsetWidth;
        tile.style.setProperty('--d', '0ms');
        tile.classList.add('is-new');
        setTimeout(() => tile.classList.remove('is-new'), 1300);
    }
}

function addItems(list, replace = false) {
    if (replace) {
        S.items.clear(); S.order = []; tiles.clear(); skeletons.length = 0; els.grid.replaceChildren();
    }
    const gap = measureCols();
    const frag = document.createDocumentFragment();
    let k = 0;
    for (const it of list) {
        if (S.items.has(it.id)) { S.items.set(it.id, it); continue; }
        S.items.set(it.id, it);
        S.order.push(it.id);
        const tile = createTile(it, Math.min(k++ * 55, 700));
        spanTile(tile, it, gap);
        tiles.set(it.id, tile);
        frag.append(tile);
        observer.observe(tile);
    }
    els.grid.insertBefore(frag, skeletons.find((sk) => sk.parentNode === els.grid) || null);
    if (S.hdOnly) checkAllHd();
    renderCounts();
    renderPhase();
    renderEmpty();
    document.dispatchEvent(new CustomEvent('av:items'));   // an open lightbox updates its counter / next button
}

function updateItems(list) {
    const gap = measureCols();
    for (const it of list) {
        const prev = S.items.get(it.id);
        if (!prev) continue;
        S.items.set(it.id, it);
        const tile = tiles.get(it.id);
        if (tile) {
            syncTile(tile, it);
            if (Math.abs(ratioOf(prev) - ratioOf(it)) > 0.02) spanTile(tile, it, gap);
        }
        lightbox.refresh(it);
    }
    renderCounts();
    if (S.hdOnly) renderEmpty();
    document.dispatchEvent(new CustomEvent('av:items'));
}

function renderCounts() {
    const c = counts();
    countTo($('statImages'), c.image, fmtNumber);
    countTo($('statReels'), c.reel, fmtNumber);
    countTo($('statHd'), c.ready, fmtNumber);
    $('nAll').textContent = fmtNumber(c.all);
    $('nImage').textContent = fmtNumber(c.image);
    $('nReel').textContent = fmtNumber(c.reel);
    let hd = 0, pending = 0;
    for (const it of S.items.values()) {
        if (!inTab(it)) continue;
        if (it.hd) hd++; else if (it.status === 'pending') pending++;
    }
    $('nHd').textContent = fmtNumber(hd);
    $('hdSpin').hidden = !(S.hdOnly && pending > 0);
    renderZipLabel();
    updateDock();
    refreshBusy();
}

function renderEmpty() {
    const any = visibleItems().length > 0;
    els.empty.hidden = any;
    if (!any) {
        const running = S.meta?.status === 'running';
        let text = running ? t('emptyScanning') : S.tab === 'image' ? t('emptyImages') : S.tab === 'reel' ? t('emptyReels') : t('emptyAll');
        if (S.hdOnly && S.items.size) {
            const tabItems = [...S.items.values()].filter(inTab);
            const done = tabItems.filter((x) => x.status !== 'pending').length;
            text = done < tabItems.length ? t('hdChecking', { done: fmtNumber(done), total: fmtNumber(tabItems.length) }) : t('emptyHd');
        }
        $('emptyText').textContent = text;
    }
}

// resolve HD links for tiles that come into view
const pendingPrefetch = new Set();
let prefetchTimer = 0;
const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
        if (!en.isIntersecting) continue;
        const id = en.target.dataset.id;
        const it = S.items.get(id);
        if (it && it.status === 'pending') pendingPrefetch.add(id);
    }
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(flushPrefetch, 280);
}, { rootMargin: '400px 0px' });

function flushPrefetch() {
    if (!pendingPrefetch.size || !S.scanId) return;
    const ids = [...pendingPrefetch].slice(0, 120);
    ids.forEach((id) => pendingPrefetch.delete(id));
    api(`/api/scans/${S.scanId}/prefetch`, { ids }).catch(() => {});
}

/* ----------------------------------------------------- grid interactions */

let tiltTile = null, tiltRaf = 0, lastEv = null;
const gridGlow = $('gridGlow');
function applyTilt() {
    tiltRaf = 0;
    const e = lastEv;
    if (!e) return;
    gridGlow.style.setProperty('--gx', `${e.clientX}px`);
    gridGlow.style.setProperty('--gy', `${e.clientY}px`);
    gridGlow.classList.add('is-on');
    const tile = e.target.closest?.('.tile');
    if (tiltTile && tiltTile !== tile) resetTilt(tiltTile);
    tiltTile = tile;
    if (!tile || reduce) return;
    const card = tile.firstElementChild;
    const r = card.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty('--rx', `${(-ny * 9).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${(nx * 11).toFixed(2)}deg`);
    const open = card.firstElementChild;
    open.style.setProperty('--gx', `${((nx + 0.5) * 100).toFixed(1)}%`);
    open.style.setProperty('--gy', `${((ny + 0.5) * 100).toFixed(1)}%`);
}
function resetTilt(tile) {
    const card = tile.firstElementChild;
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
}
if (finePointer) {
    els.grid.addEventListener('pointermove', (e) => { lastEv = e; if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt); }, { passive: true });
    els.grid.addEventListener('pointerleave', () => { if (tiltTile) resetTilt(tiltTile); tiltTile = null; gridGlow.classList.remove('is-on'); });
}

/* ----------------------------------------------- reel preview on hover */
// Hovering a reel tile plays the reel muted and looped inside the tile.
// Only one preview at a time; a short hover-intent delay avoids firing while sweeping across the grid.
const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const preview = { tile: null, video: null, timer: 0, raf: 0 };

function startPreview(tile) {
    const it = S.items.get(tile.dataset.id);
    if (!it || it.type !== 'reel' || lightbox.isOpen) return;
    preview.tile = tile;
    tile.classList.add('is-previewing');
    preview.timer = setTimeout(() => {
        if (preview.tile !== tile) return;
        const v = document.createElement('video');
        v.className = 'tile-preview';
        v.muted = true; v.defaultMuted = true; v.loop = true; v.playsInline = true;
        v.preload = 'auto'; v.disablePictureInPicture = true;
        v.setAttribute('muted', ''); v.setAttribute('aria-hidden', 'true');
        v.poster = it.thumb;
        v.src = mediaUrl(it);
        tile.querySelector('.tile-open').append(v);
        preview.video = v;
        v.addEventListener('playing', () => { if (preview.video === v) tile.classList.add('is-playing'); });
        v.addEventListener('error', () => { if (preview.video === v) tile.classList.remove('is-previewing'); });
        v.play().catch(() => { /* autoplay refused or codec missing → poster stays */ });
        const bar = tile.querySelector('.tile-progress');
        const tick = () => {
            if (preview.video !== v) return;
            if (bar && v.duration) bar.style.setProperty('--pp', (v.currentTime / v.duration).toFixed(4));
            preview.raf = requestAnimationFrame(tick);
        };
        preview.raf = requestAnimationFrame(tick);
    }, 140);
}

/* returns the playback position so the lightbox can continue from there */
function stopPreview(instant = false) {
    clearTimeout(preview.timer);
    cancelAnimationFrame(preview.raf);
    const { tile, video } = preview;
    preview.tile = null; preview.video = null;
    let at = 0;
    if (tile) tile.classList.remove('is-previewing', 'is-playing');
    if (video) {
        at = video.currentTime || 0;
        video.pause();
        const kill = () => { video.removeAttribute('src'); video.load(); video.remove(); };
        if (instant) kill(); else setTimeout(kill, 380);   // let the fade-out finish
    }
    return at;
}

if (canHover && !reduce) {
    els.grid.addEventListener('pointerover', (e) => {
        if (e.pointerType !== 'mouse') return;
        const tile = e.target.closest('.tile');
        if (tile === preview.tile) return;
        stopPreview();
        if (tile) startPreview(tile);
    });
    els.grid.addEventListener('pointerleave', () => stopPreview());
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopPreview(true); });
}

els.grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const it = S.items.get(tile.dataset.id);
    if (!it) return;
    if (e.target.closest('.tile-dl')) { download(it, e.target.closest('.tile-dl')); return; }
    if (S.selecting || e.ctrlKey || e.metaKey) {
        if (!S.selecting) setSelecting(true);
        pick(it, e.shiftKey);
        return;
    }
    if (e.target.closest('.tile-open')) {
        const startAt = preview.tile === tile && preview.video ? preview.video.currentTime : 0;
        stopPreview(true);
        lightbox.open(it, tile, { startAt });
    }
});

/* ================================================================== tabs */

const tabInk = $('tabInk');
function moveInk() {
    const btn = document.querySelector(`.tab[data-tab="${S.tab}"]`);
    if (!btn) return;
    tabInk.style.width = `${btn.offsetWidth}px`;
    tabInk.style.transform = `translateX(${btn.offsetLeft}px)`;
}
new ResizeObserver(moveInk).observe($('tabs'));

function setTab(tab, silent = false) {
    if (tab === S.tab && !silent) return;
    applyFilter(() => { S.tab = tab; }, silent);
}

/* change tab/filter with a FLIP animation: tiles glide to their new place, newcomers materialize */
function applyFilter(change, silent = false) {
    stopPreview(true);
    // FLIP: remember where visible tiles are
    const before = new Map();
    if (!silent && !reduce) {
        for (const [id, tile] of tiles) {
            if (tile.classList.contains('is-hidden')) continue;
            const r = tile.getBoundingClientRect();
            if (r.bottom > -200 && r.top < window.innerHeight + 200) before.set(id, r);
        }
    }
    change();
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
    moveInk();
    let k = 0;
    for (const [id, tile] of tiles) {
        const it = S.items.get(id);
        const show = isVisible(it);
        const was = !tile.classList.contains('is-hidden');
        tile.classList.toggle('is-hidden', !show);
        if (show && !was && !silent) {
            tile.classList.remove('is-new'); void tile.offsetWidth;
            tile.style.setProperty('--d', `${Math.min(k++ * 35, 500)}ms`);
            tile.classList.add('is-new');
            setTimeout(() => tile.classList.remove('is-new'), 1400);
        }
    }
    if (before.size) {
        for (const [id, r0] of before) {
            const tile = tiles.get(id);
            if (tile.classList.contains('is-hidden')) continue;
            const r1 = tile.getBoundingClientRect();
            const dx = r0.left - r1.left, dy = r0.top - r1.top;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
            tile.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 620, easing: 'cubic-bezier(.16, 1, .3, 1)' });
        }
    }
    renderCounts();
    renderEmpty();
    updateDock();
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

/* ------------------------------------------------------------- HD filter */
function checkAllHd() {
    if (!S.scanId) return;
    const ids = S.order.filter((id) => S.items.get(id).status === 'pending');
    if (ids.length) api(`/api/scans/${S.scanId}/prefetch`, { ids, priority: 'low' }).catch(() => {});
}
function setHdOnly(on, silent = false) {
    applyFilter(() => { S.hdOnly = on; }, silent);
    store.set('hdOnly', on);
    $('btnHd').setAttribute('aria-pressed', String(on));
    if (on) checkAllHd();
}
$('btnHd').addEventListener('click', (e) => {
    setHdOnly(!S.hdOnly);
    if (S.hdOnly) burstAt(e.currentTarget, { count: 16, speed: 3.5, life: 40 });
});

// density
function setDensity(d) {
    S.density = d;
    store.set('density', d);
    document.documentElement.dataset.density = ['s', 'm', 'l'].includes(d) ? d : 'm';
    document.querySelectorAll('[data-density]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.density === d)));
    requestAnimationFrame(layoutAll);
}
document.querySelectorAll('[data-density]').forEach((b) => b.addEventListener('click', () => setDensity(b.dataset.density)));

/* ============================================================= selection */

function setSelecting(on) {
    S.selecting = on;
    els.app.classList.toggle('is-selecting', on);
    $('btnSelect').setAttribute('aria-pressed', String(on));
    const label = on ? t('selectDone') : t('select');
    $('btnSelectLabel').textContent = label;
    $('dockSelectLabel').textContent = label;
    $('btnSelectLabel').dataset.i18n = on ? 'selectDone' : 'select';
    $('dockSelectLabel').dataset.i18n = on ? 'selectDone' : 'select';
    if (!on) { S.selected.clear(); tiles.forEach((tile) => tile.classList.remove('is-selected')); }
    updateDock();
}

function pick(it, range) {
    const vis = visibleItems();
    if (range && S.lastPicked) {
        const a = vis.findIndex((x) => x.id === S.lastPicked);
        const b = vis.findIndex((x) => x.id === it.id);
        if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) { S.selected.add(vis[i].id); tiles.get(vis[i].id)?.classList.add('is-selected'); }
            updateDock();
            return;
        }
    }
    if (S.selected.has(it.id)) S.selected.delete(it.id); else S.selected.add(it.id);
    const tile = tiles.get(it.id);
    tile?.classList.toggle('is-selected', S.selected.has(it.id));
    if (S.selected.has(it.id) && tile) burstAt(tile.querySelector('.tile-check'), { count: 10, speed: 2.5, gravity: 0.05, life: 36 });
    S.lastPicked = it.id;
    updateDock();
}

$('btnSelect').addEventListener('click', () => setSelecting(!S.selecting));
$('btnSelectBand').addEventListener('click', () => setSelecting(!S.selecting));
$('dockSelect').addEventListener('click', () => setSelecting(!S.selecting));
$('dockSelectAll').addEventListener('click', () => {
    for (const it of visibleItems()) { S.selected.add(it.id); tiles.get(it.id)?.classList.add('is-selected'); }
    updateDock();
});
$('dockClear').addEventListener('click', () => { S.selected.clear(); tiles.forEach((x) => x.classList.remove('is-selected')); updateDock(); });

/* ================================================================== dock */

let bandVisible = true;
new IntersectionObserver(([en]) => { bandVisible = en.isIntersecting; updateDock(); refreshBusy(); }, { threshold: 0.05 }).observe(els.band);

function renderZipLabel() {
    const n = visibleItems().length;
    $('zipLabel').textContent = t('zip_' + S.tab);
    $('zipCount').textContent = fmtNumber(n);
    $('btnZip').disabled = n === 0;
}

function updateDock() {
    const inResults = !els.results.hidden;
    const on = inResults && (S.selecting || !bandVisible) && S.order.length > 0;
    els.dock.classList.toggle('is-on', on);
    document.body.classList.toggle('dock-on', on);
    $('dockSelectAll').hidden = !S.selecting;
    $('dockClear').hidden = !S.selecting;
    const label = $('dockLabel');
    if (S.selecting) {
        label.innerHTML = `<b>${fmtNumber(S.selected.size)}</b> ${escapeHtml(t('selectedN', { n: '' }).trim())}`;
        $('dockZipLabel').textContent = t('zip_selection');
        $('dockZip').disabled = S.selected.size === 0;
    } else {
        const n = visibleItems().length;
        label.innerHTML = `<b>${fmtNumber(n)}</b> ${escapeHtml(t('filesN', { n: '' }).trim())}`;
        $('dockZipLabel').textContent = t('zip_' + S.tab);
        $('dockZip').disabled = n === 0;
    }
}

/* ============================================================= downloads */

async function download(it, btn) {
    if (btn.classList.contains('is-busy')) return;
    btn.classList.remove('is-done');
    btn.classList.add('is-busy');
    btn.style.setProperty('--dp', '0.06');
    try {
        const res = await fetch(`/api/scans/${S.scanId}/items/${it.id}/download`);
        if (!res.ok) {
            let code = 'HTTP_' + res.status;
            try { code = (await res.json()).error || code; } catch { /* ignore */ }
            throw Object.assign(new Error(code), { code });
        }
        const total = Number(res.headers.get('content-length')) || 0;
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            got += value.length;
            if (total) btn.style.setProperty('--dp', String(Math.max(0.06, got / total)));
        }
        btn.style.setProperty('--dp', '1');
        const name = nameFromDisposition(res.headers.get('content-disposition')) || `${it.type}_${it.fbid}`;
        saveBlob(new Blob(chunks, { type: res.headers.get('content-type') || '' }), name);
        btn.classList.remove('is-busy');
        btn.classList.add('is-done');
        burstAt(btn, { count: 22, speed: 4.5, colors: ['#5cf2a6', '#45f0e0', '#ffffff', '#8a6cff'] });
        toast(t('toastSaved', { name }), 'ok', 2600);
        markDownloaded([it.id]);
        setTimeout(() => btn.classList.remove('is-done'), 2400);
    } catch (e) {
        btn.classList.remove('is-busy');
        toast(errText(e.code || 'NETWORK'), 'err');
        if (e.code === 'LOGIN_REQUIRED') pollStatus();
    }
}

/* remembered per profile in this browser, so the "Downloaded" mark survives a reload */
const dlKey = () => 'dl.' + (S.meta?.favKey || 'none');
function loadDownloaded() {
    S.downloaded = new Set(store.get(dlKey(), []));
    tiles.forEach((tile, id) => syncTile(tile, S.items.get(id)));
}
function markDownloaded(ids) {
    for (const id of ids) S.downloaded.add(id);
    store.set(dlKey(), [...S.downloaded].slice(-5000));
    for (const id of ids) { const tile = tiles.get(id); if (tile) syncTile(tile, S.items.get(id)); }
}

/* ================================================================= vault */

const vault = {
    el: els.vault,
    show() {
        this.el.hidden = false;
        this.el.classList.remove('is-out', 'is-done');
        $('vaultThumb').replaceChildren();
        $('vaultCancel').hidden = false; $('vaultAgain').hidden = true;
    },
    hide() {
        this.el.classList.add('is-out');
        setTimeout(() => { this.el.hidden = true; this.el.classList.remove('is-out'); }, 400);
    },
    render(job) {
        const pct = job.state === 'done' ? 1 : 0.98 * (job.done / Math.max(1, job.total));
        this.el.style.setProperty('--vp', String(pct));
        $('vaultRing').style.setProperty('--vp', String(pct));
        $('vaultPct').textContent = job.state === 'done' ? '' : `${Math.round(pct * 100)}%`;
        $('vaultTitle').textContent = t('vault_' + (job.state === 'ready' ? 'fetching' : job.state));
        let sub = '';
        if (job.state === 'fetching' || job.state === 'ready') sub = t('vaultProgress', { done: fmtNumber(job.done), total: fmtNumber(job.total) });
        else if (job.state === 'done') sub = t('vaultDoneSub', { size: fmtBytes(job.size) });
        else if (job.state === 'error') sub = errText(job.error);
        if (job.failed && job.state !== 'error') sub += ` · ${t('vaultSkipped', { n: job.failed })}`;
        $('vaultSub').textContent = sub;
        if (job.current && job.state === 'fetching') {
            const th = $('vaultThumb');
            if (th.dataset.src !== job.current) {
                th.dataset.src = job.current;
                const im = new Image(); im.alt = ''; im.src = job.current;
                th.replaceChildren(im);
            }
        }
        if (job.state === 'done') {
            this.el.classList.add('is-done');
            $('vaultThumb').innerHTML = '<svg width="30" height="30" style="color:#041013"><use href="#i-check"/></svg>';
        }
        const finished = ['done', 'error', 'cancelled'].includes(job.state);
        $('vaultCancel').hidden = finished;
        $('vaultAgain').hidden = job.state !== 'done';
    },
};

function browserDownload(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.append(a); a.click(); a.remove();
}

async function startZip(ids, label) {
    if (!ids.length) { toast(t('toastNoItems'), 'warn'); return; }
    if (S.job && !['done', 'error', 'cancelled'].includes(S.job.state)) return;
    let res;
    try { res = await api('/api/zip', { scanId: S.scanId, ids, label }); } catch (e) { toast(errText(e.code), 'err'); return; }
    S.lastZip = { ids, label };
    vault.show();
    const job = { id: res.id, state: 'fetching', done: 0, total: ids.length, failed: 0 };
    S.job = job;
    vault.render(job);
    // thumbnails fly into the vault
    const ring = $('vaultRing').getBoundingClientRect();
    let n = 0;
    for (const id of ids) {
        const tile = tiles.get(id);
        const img = tile?.querySelector('.tile-open img');
        if (!img || tile.classList.contains('is-hidden')) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight || !r.width) continue;
        const d = n * 45;
        flyTo(img.currentSrc || img.src, r, ring, { delay: d }).then(() => {
            $('vaultRing').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
        });
        if (++n >= 18) break;
    }
    if (S.jobEs) S.jobEs.close();
    const es = new EventSource(`/api/jobs/${res.id}/events`);
    S.jobEs = es;
    // the ZIP is packed while the browser downloads it – nothing is kept on the server
    es.addEventListener('open', () => browserDownload(`/api/jobs/${res.id}/download`), { once: true });
    es.addEventListener('job', (e) => {
        const j = JSON.parse(e.data);
        S.job = j;
        vault.render(j);
        refreshBusy();
        if (j.state === 'done') {
            es.close();
            markDownloaded(ids);
            burstAt($('vaultRing'), { count: 70, speed: 7, life: 75 });
            aurora.ripple(ring.left + ring.width / 2, ring.top + ring.height / 2, 1.8);
        } else if (j.state === 'error' || j.state === 'cancelled') {
            es.close();
            if (j.state === 'error') toast(errText(j.error), 'err');
            setTimeout(() => vault.hide(), 2500);
        }
    });
}

$('vaultCancel').addEventListener('click', () => S.job && api(`/api/jobs/${S.job.id}/cancel`, {}).catch(() => {}));
$('vaultAgain').addEventListener('click', () => S.lastZip && startZip(S.lastZip.ids, S.lastZip.label));
$('vaultClose').addEventListener('click', () => vault.hide());

const zipCurrentTab = () => startZip(visibleItems().map((x) => x.id), S.tab);
$('btnZip').addEventListener('click', zipCurrentTab);
$('dockZip').addEventListener('click', () => {
    if (S.selecting) startZip(visibleItems().filter((x) => S.selected.has(x.id)).map((x) => x.id), 'selection');
    else zipCurrentTab();
});

/* ============================================================= favorites */

const fav = {
    btn: $('btnFavs'), menu: $('favMenu'), list: $('favList'), count: $('favCount'),
    hero: $('heroFavs'), heroRow: $('heroFavsRow'), toggle: $('btnFav'), label: $('btnFavLabel'),
};

async function loadFavorites() {
    try { S.favorites = (await api('/api/favorites')).favorites || []; } catch { S.favorites = []; }
    renderFavorites();
}

function favMetaText(f) {
    const c = f.counts || {};
    return `${fmtNumber(c.image || 0)} ${t('statImages')} · ${fmtNumber(c.reel || 0)} ${t('statReels')}`;
}

function favAvatar(f) {
    const el = document.createElement('span');
    el.className = 'fav-av';
    if (f.avatar) {
        const im = new Image();
        im.alt = '';
        im.onerror = () => { el.textContent = initials(f.name); };
        im.src = f.avatar;
        el.append(im);
    } else el.textContent = initials(f.name);
    return el;
}

function favText(f, cls) {
    const txt = document.createElement('span');
    txt.className = cls;
    const b = document.createElement('b'); b.textContent = f.name;
    const small = document.createElement('small'); small.textContent = favMetaText(f);
    txt.append(b, small);
    return txt;
}

function renderFavorites() {
    const list = S.favorites;
    fav.count.hidden = !list.length;
    fav.count.textContent = String(list.length);
    if (!list.length) {
        const p = document.createElement('p');
        p.className = 'fav-empty';
        p.textContent = t('favEmpty');
        fav.list.replaceChildren(p);
    } else {
        fav.list.replaceChildren(...list.map((f) => {
            const row = document.createElement('div');
            row.className = 'fav-row';
            row.setAttribute('role', 'menuitem');
            row.tabIndex = 0;
            row.dataset.key = f.key;
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'fav-del';
            del.setAttribute('aria-label', `${t('favRemove')}: ${f.name}`);
            del.innerHTML = '<svg><use href="#i-close"/></svg>';
            row.append(favAvatar(f), favText(f, 'fav-txt'), del);
            return row;
        }));
    }
    fav.hero.hidden = !list.length;
    fav.heroRow.replaceChildren(...list.slice(0, 8).map((f, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hero-fav';
        b.dataset.key = f.key;
        b.dataset.cursor = 'scan';
        b.style.setProperty('--i', String(i));
        b.append(favAvatar(f), favText(f, 'hero-fav-txt'));
        return b;
    }));
    renderFavState();
}

function renderFavState() {
    const key = S.meta?.favKey;
    const on = !!key && S.favorites.some((f) => f.key === key);
    fav.toggle.setAttribute('aria-pressed', String(on));
    fav.toggle.disabled = !key || !S.meta?.profile;
    fav.label.dataset.i18n = on ? 'favSaved' : 'favAdd';
    fav.label.textContent = t(fav.label.dataset.i18n);
}

async function removeFavorite(key) {
    const f = S.favorites.find((x) => x.key === key);
    try { S.favorites = (await api(`/api/favorites/${encodeURIComponent(key)}`, null, 'DELETE')).favorites; } catch (e) { toast(errText(e.code), 'err'); return; }
    renderFavorites();
    if (f) toast(t('toastFavRemoved', { name: f.name }), 'info', 2600);
}

function scanFavorite(key, originEl) {
    const f = S.favorites.find((x) => x.key === key);
    if (!f) return;
    fav.menu.hidden = true;
    if (originEl) burstAt(originEl, { count: 18, speed: 4, life: 40 });
    startScan(f.url);
}

fav.toggle.addEventListener('click', async (e) => {
    const key = S.meta?.favKey;
    if (!key || !S.scanId) return;
    if (S.favorites.some((f) => f.key === key)) { removeFavorite(key); return; }
    const btn = e.currentTarget;
    try { S.favorites = (await api('/api/favorites', { scanId: S.scanId })).favorites; } catch (err) { toast(errText(err.code), 'err'); return; }
    renderFavorites();
    burstAt(btn, { count: 36, speed: 5.5, colors: ['#ffd76a', '#ffb347', '#fff4c2', '#45f0e0', '#ff4fb6'], shape: 'shard', life: 55 });
    btn.querySelector('.s-on').animate([{ transform: 'scale(.2) rotate(-90deg)' }, { transform: 'scale(1.5) rotate(10deg)' }, { transform: 'scale(1)' }], { duration: 600, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    fav.btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 480, delay: 200, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    toast(t('toastFavAdded', { name: S.meta?.profile?.name || key }), 'ok', 3200);
});

fav.btn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.menu.hidden = true;
    fav.menu.hidden = !fav.menu.hidden;
    if (!fav.menu.hidden) {
        const r = fav.btn.getBoundingClientRect();
        fav.menu.style.right = window.innerWidth > 520 ? `${Math.max(12, window.innerWidth - r.right - 60)}px` : '';
    }
});
fav.list.addEventListener('click', (e) => {
    const row = e.target.closest('.fav-row');
    if (!row) return;
    if (e.target.closest('.fav-del')) { e.stopPropagation(); removeFavorite(row.dataset.key); return; }
    scanFavorite(row.dataset.key, row);
});
fav.list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.fav-row');
    if (row && e.key === 'Enter') scanFavorite(row.dataset.key, row);
    if (row && (e.key === 'Delete' || e.key === 'Backspace')) removeFavorite(row.dataset.key);
});
fav.heroRow.addEventListener('click', (e) => {
    const b = e.target.closest('.hero-fav');
    if (b) scanFavorite(b.dataset.key, b);
});
document.addEventListener('click', (e) => {
    if (!fav.menu.hidden && !e.target.closest('#favMenu') && !e.target.closest('#btnFavs')) fav.menu.hidden = true;
});
$('favExport').addEventListener('click', () => browserDownload('/api/favorites-export'));
$('favImport').addEventListener('click', () => $('favFile').click());
$('favFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        const data = JSON.parse(await file.text());
        const res = await api('/api/favorites-import', { favorites: Array.isArray(data) ? data : data.favorites });
        S.favorites = res.favorites;
        renderFavorites();
        toast(t('toastFavImported', { n: res.imported }), 'ok');
    } catch (err) {
        toast(errText(err.code || 'BAD_FILE'), 'err');
    }
});

/* ======================================================== waiting + game */

function hdPending() {
    let pending = 0, total = 0, hd = 0;
    for (const it of S.items.values()) {
        if (!inTab(it)) continue;
        total++;
        if (it.status === 'pending') pending++;
        if (it.hd) hd++;
    }
    return { pending, total, hd };
}

function busyState() {
    if (S.meta?.status === 'running') {
        const c = counts();
        const phase = S.meta.phase === 'starting' ? 'starting' : S.meta.phase;
        return { kind: 'scan', text: `${t('phase_' + phase)} · ${t('scanFound', { images: fmtNumber(c.image), reels: fmtNumber(c.reel) })}` };
    }
    if (S.job && ['ready', 'fetching'].includes(S.job.state)) {
        return { kind: 'zip', text: `${t('vault_fetching')} · ${t('vaultProgress', { done: fmtNumber(S.job.done || 0), total: fmtNumber(S.job.total || 0) })}` };
    }
    if (S.hdOnly && S.items.size) {
        const h = hdPending();
        if (h.pending) return { kind: 'hd', text: t('hdChecking', { done: fmtNumber(h.total - h.pending), total: fmtNumber(h.total) }) };
    }
    return null;
}

function refreshBusy() {
    if (!game) return;
    const b = busyState();
    // the band has its own game button while it is on screen during a scan
    $('waitChip').hidden = !b || game.isOpen || (b.kind === 'scan' && bandVisible && !els.results.hidden);
    if (b) $('waitChipSub').textContent = b.text;
    const c = counts();
    const st = S.meta?.status;
    if (b) game.setStatus(b.text, 'busy');
    else if (st === 'done') game.setStatus(`${t('phase_done')} · ${t('scanFound', { images: fmtNumber(c.image), reels: fmtNumber(c.reel) })}`, 'done');
    else game.setStatus(t('gameIdle'), false);

    if (lastBusy?.kind === 'scan' && b?.kind !== 'scan') {
        scanFinished(st, b);
    } else if (lastBusy && !b && game.isOpen) {
        const msg = lastBusy.kind === 'zip' ? t('vault_done') : t('gameHdDone', { n: fmtNumber(hdPending().hd) });
        game.notify(msg, t('gameToResults'));
    }
    lastBusy = b;
}

/* The scan has just ended. In the game this is a big card (the game pauses),
   in a background tab the page title says so until you come back. */
function scanFinished(status, next) {
    // only a real end counts: 'stopped' was the user's own click, no status = a new scan is just starting
    if (status !== 'done' && status !== 'error') return;
    const ok = status === 'done';
    if (game.isOpen) {
        game.announce(() => {
            const c = counts();
            if (!ok) return { tone: 'err', title: t('phase_error'), text: errText(S.meta?.error) };
            let text = t('gameDoneText', { images: fmtNumber(c.image), reels: fmtNumber(c.reel) });
            if (next?.kind === 'hd') text += ' ' + t('gameDoneHd');
            else if (next?.kind === 'zip') text += ' ' + t('gameDoneZip');
            return { tone: 'ok', title: t('gameDoneTitle'), text };
        });
    }
    if (document.hidden) flagTitle(ok ? `✓ ${t('phase_done')}` : `✕ ${t('phase_error')}`);
}

const baseTitle = document.title;
function flagTitle(prefix) {
    document.title = `${prefix} · ${baseTitle}`;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = baseTitle; });

function foodSource() {
    const ids = S.order;
    if (!ids.length) return '';
    const recent = Math.random() < 0.6 ? ids.slice(-40) : ids;
    for (let tries = 0; tries < 6; tries++) {
        const it = S.items.get(recent[(Math.random() * recent.length) | 0]);
        if (it && it.thumb) return it.thumb;
    }
    return '';
}

game = createSnake({
    foodSource,
    onResults: () => window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }),
    onOpenChange: (open) => {
        if (open) { game.hideBanner(); stopPreview(true); }
        refreshBusy();
    },
});
const openGame = (e) => {
    if (e && e.currentTarget) burstAt(e.currentTarget, { count: 22, speed: 4.5, colors: ['#ff4fb6', '#8a6cff', '#45f0e0', '#ffffff'] });
    game.open();
};
$('btnGameBand').addEventListener('click', openGame);
$('waitChip').addEventListener('click', openGame);

/* ============================================================ back to top */

const toTop = $('toTop');
function updateToTop() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    toTop.style.setProperty('--p', max > 0 ? (window.scrollY / max).toFixed(4) : '0');
    toTop.classList.toggle('is-on', window.scrollY > 700);
}
window.addEventListener('scroll', updateToTop, { passive: true });
toTop.addEventListener('click', () => {
    const r = toTop.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, { count: 28, speed: 6, angle: -Math.PI / 2, spread: 1.1, gravity: 0.06, life: 50 });
    aurora.ripple(r.left + r.width / 2, r.top + r.height / 2, 1.2);
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
});

/* ============================================================== lightbox */

const lightbox = createLightbox({
    getList: visibleItems,
    getTile: (id) => tiles.get(id),
    mediaUrl,
    aurora,
    onDownload: (it, btn) => download(it, btn),
});

/* ================================================================ wiring */

els.form.addEventListener('submit', (e) => { e.preventDefault(); startScan(els.input.value); });
$('btnDemo').addEventListener('click', () => startScan('demo'));
$('btnNew').addEventListener('click', () => {
    showResults(false);
    els.input.value = '';
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(() => els.input.focus(), 300);
});
$('btnStop').addEventListener('click', () => S.scanId && api(`/api/scans/${S.scanId}/stop`, {}).catch(() => {}));

// brand: home + 5 quick clicks = hyperdrive
let brandClicks = [];
$('brand').addEventListener('click', () => {
    const now = Date.now();
    brandClicks = brandClicks.filter((x) => now - x < 1600).concat(now);
    if (brandClicks.length >= 5) { brandClicks = []; hyperdrive(); return; }
    if (!els.results.hidden && S.meta?.status !== 'running') $('btnNew').click();
});
$('brand').addEventListener('pointerenter', () => scramble($('brandName'), 'AURORA VAULT', { duration: 520 }));

// language
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    // on phones only the active language is shown → tapping it switches to the other one
    const other = [...document.querySelectorAll('[data-lang]')].find((x) => x !== b);
    const next = b.dataset.lang === getLang() && other && other.offsetParent === null ? other.dataset.lang : b.dataset.lang;
    setLang(next);
    document.querySelectorAll('[data-lang]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === getLang())));
}));
document.addEventListener('av:lang', () => {
    renderHero(); renderConn(); renderPhase(); renderZipLabel(); updateDock(); renderEmpty(); moveInk(); renderFavorites(); refreshBusy();
    setSelecting(S.selecting);
});

// keyboard shortcuts
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (!fav.menu.hidden || !els.menu.hidden)) { fav.menu.hidden = true; els.menu.hidden = true; return; }
    if (lightbox.isOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); els.input.focus(); els.input.select(); return; }
    if (typing) { if (e.key === 'Escape') els.input.blur(); return; }
    if (els.results.hidden) return;
    if (e.key === '1') setTab('all');
    else if (e.key === '2') setTab('image');
    else if (e.key === '3') setTab('reel');
    else if (e.key.toLowerCase() === 's') setSelecting(!S.selecting);
    else if (e.key.toLowerCase() === 'h') setHdOnly(!S.hdOnly);
    else if (e.key.toLowerCase() === 'g') game.open();
    else if (e.key === 'Escape' && S.selecting) setSelecting(false);
    else if (e.key.toLowerCase() === 'a' && S.selecting) $('dockSelectAll').click();
});

/* ================================================================== boot */

document.body.classList.add('intro');
setTimeout(() => document.body.classList.remove('intro'), 3200);
applyI18n();
document.querySelectorAll('[data-lang]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lang === getLang())));
document.documentElement.lang = getLang();
renderHero();
renderConn();
setDensity(S.density);
$('btnHd').setAttribute('aria-pressed', String(S.hdOnly));
loadFavorites();
updateToTop();
els.input.value = '';
pollStatus();
updateDock();

const params = new URLSearchParams(location.search);
if (params.has('demo')) startScan('demo');
else if (params.get('url')) startScan(params.get('url'));
