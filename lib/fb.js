'use strict';
/**
 * fb.js – Facebook access via a real, locally installed browser (Edge/Chrome)
 * controlled by Playwright. The login lives in a persistent browser profile
 * inside ./session, so your everyday browser stays untouched.
 *
 * Three jobs:
 *   1. login()   – opens a visible window, waits until you are logged in
 *   2. scan()    – scrolls the photos tab and the reels tab, collects tiles
 *                  (groups: the photos and videos of the group's media tab)
 *   3. resolve() – finds the full-resolution image / HD video URL of one item
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SESSION_DIR = path.join(ROOT, 'session');
const PROFILE_DIR = path.join(SESSION_DIR, 'browser');
const META_FILE = path.join(SESSION_DIR, 'meta.json');
const FB = 'https://www.facebook.com';
const IDLE_CLOSE_MS = 8 * 60 * 1000;
const FALLBACK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

let chromium = null;
function pw() {
    if (!chromium) chromium = require('playwright-core').chromium;
    return chromium;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const code = (c, message) => Object.assign(new Error(message || c), { code: c });

function readMeta() {
    try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; }
}
function writeMeta() {
    try {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        fs.writeFileSync(META_FILE, JSON.stringify(state.meta, null, 2));
    } catch (e) { console.warn('[fb] could not write session meta:', e.message); }
}

const state = {
    ctx: null,          // current persistent browser context
    mode: null,         // 'login' | 'work'
    headless: true,
    page: null,         // page used for scrolling profile tabs
    resolver: null,     // lightweight same-origin page used for fetch() lookups
    channel: null,      // which browser was found: msedge | chrome | chromium
    login: { pending: false, error: null },
    lastError: null,
    meta: readMeta(),
    idleTimer: null,
    launching: null,
};

function userAgent() { return state.meta.ua || FALLBACK_UA; }

function touch() {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => { if (state.mode === 'work') closeCtx(); }, IDLE_CLOSE_MS);
}

async function closeCtx() {
    const ctx = state.ctx;
    state.ctx = null; state.mode = null; state.page = null; state.resolver = null;
    if (ctx) await ctx.close().catch(() => {});
}

async function launch(headless) {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const channels = process.env.AV_BROWSER ? [process.env.AV_BROWSER] : ['msedge', 'chrome', 'chromium'];
    let lastErr = null;
    for (const channel of channels) {
        try {
            const opts = {
                headless,
                args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
                ignoreDefaultArgs: ['--enable-automation'],
                viewport: headless ? { width: 1366, height: 900 } : null,
            };
            if (channel !== 'chromium') opts.channel = channel;
            if (headless) opts.userAgent = userAgent();
            const ctx = await pw().launchPersistentContext(PROFILE_DIR, opts);
            state.channel = channel;
            return ctx;
        } catch (e) {
            lastErr = e;
            // profile folder locked by a still-running window → no point trying other browsers
            if (/lock|in use|user data directory is already in use/i.test(e.message)) break;
        }
    }
    const err = code('NO_BROWSER', 'No usable browser found (Microsoft Edge or Google Chrome).');
    err.detail = lastErr ? lastErr.message.split('\n')[0] : '';
    throw err;
}

/* ------------------------------------------------------------------ login */

function status() {
    return {
        loggedIn: !!state.meta.loggedIn,
        name: state.meta.name || '',
        uid: state.meta.uid || '',
        avatar: state.meta.avatar || '',
        loginPending: state.login.pending,
        loginError: state.login.error,
        browser: state.channel,
        busy: state.mode === 'work',
    };
}

async function readViewer(page) {
    await page.goto(FB + '/me', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('[role="main"]', { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    return page.evaluate(() => {
        const main = document.querySelector('[role="main"]') || document.body;
        const name = document.title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\|\s*Facebook\s*$/i, '').trim();
        let avatar = '', best = 0;
        for (const im of main.querySelectorAll('svg image')) {
            const w = im.getBoundingClientRect().width;
            const href = im.getAttribute('xlink:href') || im.getAttribute('href') || '';
            if (href && w > best) { best = w; avatar = href; }
        }
        return { name, avatar, ua: navigator.userAgent };
    });
}

async function login() {
    if (state.login.pending) return status();
    await closeCtx();
    state.login = { pending: true, error: null };
    let ctx;
    try {
        ctx = await launch(false);
    } catch (e) {
        state.login = { pending: false, error: e.code || e.message };
        throw e;
    }
    state.ctx = ctx; state.mode = 'login';
    ctx.on('close', () => {
        if (state.ctx === ctx) { state.ctx = null; state.mode = null; state.page = null; state.resolver = null; }
        state.login.pending = false;
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    page.goto(FB + '/login/').catch(() => {});

    (async () => {
        const started = Date.now();
        while (state.login.pending && state.ctx === ctx && Date.now() - started < 20 * 60 * 1000) {
            await sleep(1200);
            let cookies = [];
            try { cookies = await ctx.cookies(FB); } catch { break; }
            const cu = cookies.find((c) => c.name === 'c_user');
            const xs = cookies.find((c) => c.name === 'xs');
            const url = page.isClosed() ? '' : page.url();
            if (!cu || !xs || /\/(login|checkpoint|two_step|recover|auth_platform)/.test(url)) continue;
            await sleep(1500);
            let info = {};
            try { info = await readViewer(page); } catch { /* name/avatar are optional */ }
            state.meta = {
                ...state.meta,
                loggedIn: true,
                uid: cu.value,
                name: info.name || state.meta.name || '',
                avatar: info.avatar || state.meta.avatar || '',
                ua: (info.ua || state.meta.ua || FALLBACK_UA).replace(/Headless/g, ''),
                since: Date.now(),
            };
            writeMeta();
            state.login.pending = false;
            await sleep(700);
            await ctx.close().catch(() => {});
            return;
        }
        state.login.pending = false;
        if (state.ctx === ctx) await closeCtx();
    })().catch((e) => { state.login = { pending: false, error: e.message }; });

    return status();
}

async function cancelLogin() {
    if (state.mode === 'login') await closeCtx();
    state.login.pending = false;
    return status();
}

async function logout() {
    await closeCtx();
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 }); } catch { /* retried next time */ }
    state.meta = {};
    writeMeta();
    return status();
}

/* ------------------------------------------------------------ work context */

async function ensureWork() {
    if (state.login.pending) throw code('LOGIN_IN_PROGRESS');
    if (state.ctx && state.mode === 'work') { touch(); return state.ctx; }
    if (state.launching) return state.launching;
    state.launching = (async () => {
        await closeCtx();
        const ctx = await launch(true);
        state.ctx = ctx; state.mode = 'work';
        ctx.on('close', () => {
            if (state.ctx === ctx) { state.ctx = null; state.mode = null; state.page = null; state.resolver = null; }
        });
        touch();
        return ctx;
    })();
    try { return await state.launching; } finally { state.launching = null; }
}

async function hasSessionCookie(ctx) {
    const cookies = await ctx.cookies(FB).catch(() => []);
    return cookies.some((c) => c.name === 'c_user');
}

function markLoggedOut() {
    if (state.meta.loggedIn) { state.meta.loggedIn = false; writeMeta(); }
}

async function workPage() {
    const ctx = await ensureWork();
    if (state.page && !state.page.isClosed()) return state.page;
    const page = ctx.pages().find((p) => p !== state.resolver) || await ctx.newPage();
    // Videos and fonts are not needed for collecting links → faster scrolling.
    await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'media' || t === 'font') return route.abort();
        return route.fallback();
    });
    state.page = page;
    return page;
}

let resolverOpening = null;
async function resolverPage() {
    const ctx = await ensureWork();
    if (state.resolver && !state.resolver.isClosed()) return state.resolver;
    if (resolverOpening) return resolverOpening;
    resolverOpening = (async () => {
        const page = await ctx.newPage();
        // robots.txt = tiny page on the facebook.com origin → same-origin fetch() with your cookies
        await page.goto(FB + '/robots.txt', { waitUntil: 'domcontentloaded', timeout: 30000 });
        state.resolver = page;
        return page;
    })();
    try { return await resolverOpening; } finally { resolverOpening = null; }
}

/* ------------------------------------------------------------------- urls */

function parseProfile(input) {
    let s = String(input || '').trim();
    if (!s) return null;
    if (/^\d{5,}$/.test(s)) return { kind: 'id', id: s, key: s };
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    let u;
    try { u = new URL(s); } catch { return null; }
    if (!/(^|\.)(facebook\.com|fb\.com)$/i.test(u.hostname)) return null;
    if (/^\/profile\.php/i.test(u.pathname)) {
        const id = u.searchParams.get('id');
        return id ? { kind: 'id', id, key: id } : null;
    }
    const parts = u.pathname.split('/').filter(Boolean);
    // groups: facebook.com/groups/<id or name>/… (also links to a post or the media tab of a group)
    if (parts[0] === 'groups' && parts[1] && !['feed', 'discover', 'joins', 'create', 'search'].includes(parts[1].toLowerCase())) {
        return { kind: 'group', id: parts[1], key: 'group_' + parts[1] };
    }
    if (parts[0] === 'people' && /^\d+$/.test(parts[2] || '')) return { kind: 'id', id: parts[2], key: parts[2] };
    const reserved = ['photo', 'photo.php', 'photos', 'reel', 'reels', 'watch', 'groups', 'events', 'share', 'story.php',
        'permalink.php', 'login', 'marketplace', 'pages', 'video.php', 'hashtag', 'search', 'home.php', 'gaming'];
    if (!parts[0]) return null;
    if (reserved.includes(parts[0].toLowerCase())) return { kind: 'url', url: u.href, key: 'link' };
    return { kind: 'vanity', name: parts[0], key: parts[0] };
}

function tabUrl(p, tab) {
    if (p.kind === 'id') return `${FB}/profile.php?id=${encodeURIComponent(p.id)}&sk=${tab}`;
    const seg = tab === 'reels_tab' ? 'reels' : tab;
    return `${FB}/${encodeURIComponent(p.name)}/${seg}`;
}

function profileUrl(p) {
    if (p.kind === 'group') return `${FB}/groups/${p.id}/`;
    return p.kind === 'id' ? `${FB}/profile.php?id=${p.id}` : `${FB}/${p.name}`;
}

const groupUrl = (p, tab) => `${FB}/groups/${encodeURIComponent(p.id)}/media/${tab}/`;

/* ------------------------------------------------------------------- scan */

async function gotoChecked(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (/\/(login|checkpoint)/.test(page.url())) { markLoggedOut(); throw code('LOGIN_REQUIRED'); }
    await page.waitForSelector('[role="main"]', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1600);
    const unavailable = await page.evaluate(() => /Dieser Inhalt ist momentan nicht verfügbar|This content isn't available|Diese Seite ist leider nicht verfügbar|This page isn't available/i
        .test((document.body.innerText || '').slice(0, 6000)));
    if (unavailable) throw code('NOT_AVAILABLE');
}

function readProfileInPage() {
    const main = document.querySelector('[role="main"]') || document.body;
    const name = document.title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\|\s*Facebook\s*$/i, '').trim();
    let avatar = '', best = 0;
    for (const im of main.querySelectorAll('svg image')) {
        const w = im.getBoundingClientRect().width;
        const href = im.getAttribute('xlink:href') || im.getAttribute('href') || '';
        if (href && w > best) { best = w; avatar = href; }
    }
    const coverEl = main.querySelector('img[data-imgperflogname="profileCoverPhoto"]');
    let followers = '';
    for (const a of main.querySelectorAll('a[href*="followers"], a[href*="friends"]')) {
        const t = (a.innerText || '').trim();
        if (/\d/.test(t)) { followers = t; break; }
    }
    return { name, avatar, cover: coverEl ? coverEl.src : '', followers };
}

function extractTilesInPage(arg) {
    const { kind, skip = [] } = typeof arg === 'string' ? { kind: arg } : arg;
    const main = document.querySelector('[role="main"]') || document.body;
    const out = [];
    const good = (src) => src && !src.startsWith('data:');
    if (kind === 'image') {
        for (const a of main.querySelectorAll('a[href*="fbid="]')) {
            let id = '';
            try { id = new URL(a.href, location.href).searchParams.get('fbid') || ''; } catch { /* ignore */ }
            if (!/^\d+$/.test(id) || skip.includes(id)) continue;
            const img = a.querySelector('img');
            if (!img) continue;
            out.push({ id, href: `https://www.facebook.com/photo/?fbid=${id}`, thumb: good(img.currentSrc || img.src) ? (img.currentSrc || img.src) : '', alt: img.alt || '' });
        }
    } else {
        // reels (/reel/<id>) and, in groups, videos (/<owner>/videos/<id>/, /watch/?v=<id>)
        for (const a of main.querySelectorAll('a[href*="/reel/"], a[href*="/videos/"], a[href*="watch/?v="], a[href*="watch?v="]')) {
            const reel = /\/reel\/(\d+)/.exec(a.href);
            const m = reel || /\/videos\/(?:[^/?#]+\/)?(\d{6,})/.exec(a.href) || /[?&]v=(\d{6,})/.exec(a.href);
            if (!m) continue;
            const img = a.querySelector('img');
            const views = ((a.innerText || '').trim().split('\n').pop() || '').trim();
            out.push({
                id: m[1], href: reel ? `https://www.facebook.com/reel/${m[1]}/` : `https://www.facebook.com/watch/?v=${m[1]}`,
                thumb: img && good(img.src) ? img.src : '', views: /\d/.test(views) ? views : '', alt: img && img.alt ? img.alt : '',
            });
        }
    }
    return out;
}

/* group header: name, member count, cover photo (groups have no profile picture → the cover is used) */
function readGroupInPage() {
    const main = document.querySelector('[role="main"]') || document.body;
    const h1 = main.querySelector('h1') || document.querySelector('h1');
    const name = (h1 && h1.innerText.trim()) || document.title.replace(/^\(\d+\+?\)\s*/, '').replace(/\s*\|\s*Facebook\s*$/i, '').trim();
    const text = (document.body.innerText || '').slice(0, 8000);
    const members = (text.match(/([\d.,]+\s*(?:Tsd\.|Mio\.|K|M)?\s*(?:Mitglieder|members))/i) || [])[1] || '';
    const coverLink = main.querySelector('a[aria-label="Titelbild"], a[aria-label="Cover photo"], a[aria-label="Cover Photo"]') || main.querySelector('a[href*="set=p."]');
    let coverId = '';
    try { coverId = coverLink ? (new URL(coverLink.href, location.href).searchParams.get('fbid') || '') : ''; } catch { /* ignore */ }
    const img = coverLink && coverLink.querySelector('img');
    const privateGroup = /Private Gruppe|Private group/i.test(text) && /Gruppe beitreten|Join group|Join Group/i.test(text)
        && !main.querySelector('a[href*="fbid="]:not([aria-label]), a[href*="/videos/"] img, a[href*="/reel/"] img');
    return { name, followers: members, cover: img ? (img.currentSrc || img.src) : '', coverId, privateGroup };
}

async function revealMissingThumbs(page, kind, ids) {
    return page.evaluate(async ({ kind, ids }) => {
        for (const id of ids) {
            const sel = kind === 'image' ? `a[href*="fbid=${id}"]` : `a[href*="/reel/${id}"], a[href*="/videos/"][href*="${id}"], a[href*="v=${id}"]`;
            const a = document.querySelector(sel);
            if (!a) continue;
            a.scrollIntoView({ block: 'center' });
            await new Promise((r) => setTimeout(r, 260));
        }
    }, { kind, ids: ids.slice(0, 400) });
}

async function collect(page, kind, { max, signal, onItems, onUpdate, skip = [] }) {
    const seen = new Map();
    let stale = 0;
    const take = async () => {
        const batch = await page.evaluate(extractTilesInPage, { kind, skip });
        const fresh = [], updated = [];
        for (const t of batch) {
            const prev = seen.get(t.id);
            if (!prev) {
                if (seen.size >= max) break;
                seen.set(t.id, t); fresh.push(t);
            } else if (!prev.thumb && t.thumb) {
                prev.thumb = t.thumb; updated.push(t);
            }
        }
        if (fresh.length) onItems(fresh);
        if (updated.length) onUpdate(updated);
        return fresh.length;
    };
    while (!signal.aborted && seen.size < max) {
        const n = await take();
        stale = n ? 0 : stale + 1;
        if (stale >= 7) break;
        if (stale >= 3) {   // nothing new and Facebook shows no loading indicator → end of the list
            const loading = await page.evaluate(() => !!document.querySelector('[role="main"] [role="progressbar"], [role="main"] [data-visualcompletion="loading-state"]')).catch(() => false);
            if (!loading) break;
        }
        // real wheel events + jump to the end → Facebook's infinite scroll loads the next batch
        await page.mouse.wheel(0, 2400).catch(() => {});
        await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
        await page.waitForTimeout(stale ? 1000 + stale * 400 : 800);
        touch();
    }
    const missing = [...seen.values()].filter((t) => !t.thumb).map((t) => t.id);
    if (missing.length && !signal.aborted) {
        await revealMissingThumbs(page, kind, missing).catch(() => {});
        await take().catch(() => {});
    }
    return seen.size;
}

/**
 * Scans a profile. Events: profile, phase, items, update.
 */
async function scan(input, { signal, emit, max = 5000 }) {
    let target = parseProfile(input);
    if (!target) throw code('BAD_URL');
    if (!state.meta.loggedIn) throw code('LOGIN_REQUIRED');
    const ctx = await ensureWork();
    if (!(await hasSessionCookie(ctx))) { markLoggedOut(); throw code('LOGIN_REQUIRED'); }
    const page = await workPage();

    if (target.kind === 'url') {             // share links etc. → follow the redirect first
        await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(1500);
        target = parseProfile(page.url());
        if (!target || target.kind === 'url') throw code('BAD_URL');
    }

    if (target.kind === 'group') { await scanGroup(page, target, { signal, emit, max }); touch(); return; }

    emit('phase', { phase: 'images' });
    await gotoChecked(page, tabUrl(target, 'photos_by'));
    const profile = await page.evaluate(readProfileInPage);
    emit('profile', { ...profile, key: target.key, url: profileUrl(target) });

    const onItems = (type) => (tiles) => emit('items', tiles.map((t) => ({ ...t, type })));
    const onUpdate = (type) => (tiles) => emit('thumbs', tiles.map((t) => ({ ...t, type })));

    let found = await collect(page, 'image', { max, signal, onItems: onItems('image'), onUpdate: onUpdate('image') });
    if (signal.aborted) return;
    if (!found) {                            // pages sometimes only have the general photos tab
        try {
            await gotoChecked(page, tabUrl(target, 'photos'));
            found = await collect(page, 'image', { max, signal, onItems: onItems('image'), onUpdate: onUpdate('image') });
        } catch (e) { if (e.code === 'LOGIN_REQUIRED') throw e; }
        if (signal.aborted) return;
    }

    emit('phase', { phase: 'reels' });
    try {
        await gotoChecked(page, tabUrl(target, 'reels_tab'));
        await collect(page, 'reel', { max, signal, onItems: onItems('reel'), onUpdate: onUpdate('reel') });
    } catch (e) {
        if (e.code === 'LOGIN_REQUIRED') throw e;
        emit('notice', { code: 'NO_REELS_TAB' });   // profile without reels tab
    }
    touch();
}

/* a group: media tab → photos, then videos (shown under "Reels") */
async function scanGroup(page, target, { signal, emit, max }) {
    const onItems = (type) => (tiles) => emit('items', tiles.map((t) => ({ ...t, type })));
    const onUpdate = (type) => (tiles) => emit('thumbs', tiles.map((t) => ({ ...t, type })));
    emit('phase', { phase: 'images' });
    await gotoChecked(page, groupUrl(target, 'photos'));
    const g = await page.evaluate(readGroupInPage);
    if (g.privateGroup) throw code('GROUP_PRIVATE');
    emit('profile', { name: g.name, avatar: g.cover, cover: g.cover, followers: g.followers, key: target.key, url: profileUrl(target) });
    const skip = g.coverId ? [g.coverId] : [];            // the cover photo is not part of the group's photos
    await collect(page, 'image', { max, signal, skip, onItems: onItems('image'), onUpdate: onUpdate('image') });
    if (signal.aborted) return;
    emit('phase', { phase: 'reels' });
    await gotoChecked(page, groupUrl(target, 'videos'));
    await collect(page, 'reel', { max, signal, onItems: onItems('reel'), onUpdate: onUpdate('reel') });
}

/* ---------------------------------------------------------------- resolve */

async function resolvePhotoInPage(fbid) {
    const r = await fetch('/photo/?fbid=' + fbid, { credentials: 'include', headers: { accept: 'text/html,application/xhtml+xml' } });
    if (/\/(login|checkpoint)/.test(r.url)) return { error: 'LOGIN_REQUIRED' };
    const t = await r.text();
    if (t.includes('{"__dr":"CometErrorRoot.react"}')) return { error: 'RATE_LIMITED' };
    const dec = (s) => { try { return JSON.parse('"' + s + '"'); } catch { return s.replace(/\\\//g, '/'); } };
    const m = /,"image":\{"uri":"((?:[^"\\]|\\.)+)","width":(\d+),"height":(\d+)\}/.exec(t)
        || /"image":\{"uri":"((?:[^"\\]|\\.)+)","width":(\d+),"height":(\d+)\}/.exec(t);
    if (!m) return { error: 'NO_URL' };
    const ct = /"created_time":(\d{9,})/.exec(t);
    const pt = /\\"publish_time\\":(\d{9,})/.exec(t);
    let caption = '';
    const mi = t.indexOf('"message":{"delight_ranges"');
    if (mi > 0) {
        const end = t.indexOf('"},"message_preferred_body"', mi);
        if (end > mi && end - mi < 60000) {
            const seg = t.slice(mi, end);
            const k = seg.lastIndexOf('],"text":"');
            if (k >= 0) caption = dec(seg.slice(k + 10));
        }
    }
    const ac = /"accessibility_caption":"((?:[^"\\]|\\.)*)"/.exec(t);
    return {
        url: dec(m[1]), width: +m[2], height: +m[3],
        time: +((ct && ct[1]) || (pt && pt[1]) || 0),
        caption, alt: ac ? dec(ac[1]) : '',
    };
}

async function resolveReelInPage(vid) {
    const r = await fetch('/watch/?v=' + vid, { credentials: 'include', headers: { accept: 'text/html,application/xhtml+xml' } });
    if (/\/(login|checkpoint)/.test(r.url)) return { error: 'LOGIN_REQUIRED' };
    const t = await r.text();
    if (t.includes('{"__dr":"CometErrorRoot.react"}')) return { error: 'RATE_LIMITED' };
    const dec = (s) => { try { return JSON.parse('"' + s + '"'); } catch { return s.replace(/\\\//g, '/'); } };
    const arrAt = (s, i) => {            // raw JSON array/object starting at i
        let d = 0, str = false, esc = false;
        for (let k = i; k < s.length; k++) {
            const c = s[k];
            if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
            if (c === '"') str = true;
            else if (c === '[' || c === '{') d++;
            else if (c === ']' || c === '}') { d--; if (d === 0) return s.slice(i, k + 1); }
        }
        return null;
    };
    const tryAt = (pos) => {
        const pi = t.indexOf('"progressive_urls":', pos);
        if (pi < 0) return null;
        try { return JSON.parse(arrAt(t, pi + 19)); } catch { return null; }
    };
    // The video's own delivery block sits right after its DASH manifest link (…mpd?v=<id>).
    const anchor = t.indexOf('dash_mpd_debug.mpd?v=' + vid);
    const list = (anchor >= 0 && tryAt(anchor)) || tryAt(0) || [];
    let url = '', quality = '';
    const usable = list.filter((x) => x && x.progressive_url);
    const hd = usable.find((x) => /hd/i.test((x.metadata && x.metadata.quality) || ''));
    const pick = hd || usable[usable.length - 1];
    if (pick) { url = pick.progressive_url; quality = (pick.metadata && pick.metadata.quality) || ''; }
    if (!url) {
        for (const k of ['browser_native_hd_url', 'playable_url_quality_hd', 'browser_native_sd_url', 'playable_url']) {
            const m = new RegExp('"' + k + '":"((?:[^"\\\\]|\\\\.)+)"').exec(t);
            if (m) { url = dec(m[1]); quality = /hd/.test(k) ? 'HD' : 'SD'; break; }
        }
    }
    if (!url) return { error: 'NO_URL' };
    return { url, quality: quality.toUpperCase() };
}

async function resolve(type, fbid) {
    const page = await resolverPage();
    touch();
    let res;
    try {
        res = await page.evaluate(type === 'reel' ? resolveReelInPage : resolvePhotoInPage, fbid);
    } catch (e) {
        if (state.resolver === page) state.resolver = null;   // page crashed/closed → reopen next time
        throw code('RESOLVE_FAILED', e.message.split('\n')[0]);
    }
    if (res.error) {
        if (res.error === 'LOGIN_REQUIRED') markLoggedOut();
        throw code(res.error);
    }
    return res;
}

async function shutdown() { await closeCtx(); }

module.exports = {
    status, login, cancelLogin, logout, scan, resolve, parseProfile, userAgent, shutdown, FB,
    _inPage: { readProfileInPage, readGroupInPage, extractTilesInPage, resolvePhotoInPage, resolveReelInPage },   // for diagnostics
};
