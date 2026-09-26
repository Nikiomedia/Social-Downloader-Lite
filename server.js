'use strict';
/**
 * Aurora Vault – local server.
 * Serves the web app (public/), talks to Facebook through lib/fb.js and
 * handles downloads, the media proxy, ZIP export (streamed, nothing is stored
 * on the server) and the favorites list (data/favorites.json).
 *
 * Start: start.bat (Windows) or `node server.js`
 * Env:   PORT=4870           port (next free port is used if taken)
 *        HOST=127.0.0.1      listen address (0.0.0.0 = reachable in the network)
 *        AV_PASSWORD=…       password protection (HTTP login, any user name)
 *        NO_OPEN=1           do not open the browser on start
 *        AV_BROWSER=msedge|chrome
 */
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
    console.error(`\n  Aurora Vault needs Node.js 20 or newer (found ${process.versions.node}).\n  Download: https://nodejs.org\n`);
    process.exit(1);
}

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { spawn } = require('child_process');

const fb = require('./lib/fb');
const demo = require('./lib/demo');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const FAV_FILE = path.join(DATA, 'favorites.json');
const START_PORT = Number(process.env.PORT) || 4870;
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.AV_PASSWORD || '';
const VERSION = require('./package.json').version;
const RESOLVE_CONCURRENCY = 3;
const ZIP_LOOKAHEAD = 3;
const RESOLVE_TTL = 6 * 60 * 60 * 1000;

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.ico': 'image/x-icon', '.zip': 'application/zip', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomBytes(6).toString('hex');

/* ================================================================ helpers */

function send(res, status, body, headers = {}) {
    if (res.headersSent) { try { res.end(); } catch { /* closed */ } return; }
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(data);
}

function readJson(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('TOO_LARGE'), { code: 'TOO_LARGE' })); req.destroy(); } else chunks.push(c); });
        req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('BAD_JSON'), { code: 'BAD_JSON' })); } });
        req.on('error', reject);
    });
}

function sseOpen(res) {
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no',
    });
    res.write('retry: 2500\n\n');
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 15000);
    res.on('close', () => clearInterval(hb));
    return (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ } };
}

function disposition(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function safeName(s, max = 48) {
    return String(s || '')
        .normalize('NFC')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[.\-]+$/g, '')
        .replace(/^[.\-]+/g, '')
        .slice(0, max) || 'facebook';
}

async function serveFile(req, res, file, { download = false, filename, cache = 'no-cache' } = {}) {
    let st;
    try { st = await fsp.stat(file); } catch { return send(res, 404, { error: 'NOT_FOUND' }); }
    if (!st.isFile()) return send(res, 404, { error: 'NOT_FOUND' });
    const headers = {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'accept-ranges': 'bytes', 'cache-control': cache, 'last-modified': st.mtime.toUTCString(),
    };
    if (download) headers['content-disposition'] = disposition(filename || path.basename(file));
    const range = req.headers.range;
    if (range && st.size > 0) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m && m[1] !== '' ? Number(m[1]) : NaN;
        let end = m && m[2] !== '' ? Number(m[2]) : NaN;
        if (Number.isNaN(start)) { start = Math.max(0, st.size - end); end = st.size - 1; }
        else if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
        if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
        headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
        headers['content-length'] = end - start + 1;
        res.writeHead(206, headers);
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    headers['content-length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

function allowedRemote(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && /(^|\.)fbcdn\.net$/i.test(u.hostname);
    } catch { return false; }
}

function remoteHeaders(extra = {}) {
    return { 'user-agent': fb.userAgent(), referer: 'https://www.facebook.com/', accept: '*/*', ...extra };
}

async function proxy(req, res, url, { download = false, filename } = {}) {
    if (!allowedRemote(url)) return send(res, 403, { error: 'FORBIDDEN_HOST' });
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    let up;
    try {
        up = await fetch(url, { headers: remoteHeaders(req.headers.range ? { range: req.headers.range } : {}), signal: ctrl.signal, redirect: 'follow' });
    } catch (e) {
        return send(res, 502, { error: 'UPSTREAM', detail: e.message });
    }
    const headers = {
        'content-type': up.headers.get('content-type') || 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
        'accept-ranges': up.headers.get('accept-ranges') || 'bytes',
    };
    for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
        const v = up.headers.get(h);
        if (v) headers[h] = v;
    }
    if (download) headers['content-disposition'] = disposition(filename || 'download');
    res.writeHead(up.status, headers);
    if (req.method === 'HEAD' || !up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

/* whole file into memory (used for ZIP entries: one broken download must not break the archive) */
async function fetchBuffer(url, limit = 1024 * 1024 * 1024) {
    if (!allowedRemote(url)) throw Object.assign(new Error('FORBIDDEN_HOST'), { code: 'FORBIDDEN_HOST' });
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const up = await fetch(url, { headers: remoteHeaders(), redirect: 'follow' });
            if (!up.ok) throw new Error('HTTP ' + up.status);
            const buf = Buffer.from(await up.arrayBuffer());
            if (buf.length > limit) throw new Error('TOO_LARGE');
            return buf;
        } catch (e) {
            lastErr = e;
            await sleep(600 * (attempt + 1));
        }
    }
    throw lastErr;
}

function openBrowser(url) {
    if (process.env.NO_OPEN) return;
    try {
        if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } catch { /* ignore */ }
}

function checkAuth(req) {
    if (!PASSWORD) return true;
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    const a = crypto.createHash('sha256').update(pass).digest();
    const b = crypto.createHash('sha256').update(PASSWORD).digest();
    return crypto.timingSafeEqual(a, b);
}

/* ================================================================== scans */

const scans = new Map();
const MAX_SCANS = 6;
const resolveCache = new Map();    // "type:fbid" → { r, ts }  (re-scans don't fetch everything again)

function mediaUrl(src) {
    if (!src) return '';
    if (src.startsWith('/')) return src;
    return '/api/media?u=' + encodeURIComponent(src);
}

function dimsFromThumb(src) {
    const m = /[?&]cstp=mx(\d+)x(\d+)/.exec(src || '');
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function extOf(item) {
    const src = item.file || item.src || '';
    const m = /\.(jpe?g|png|webp|gif|mp4|webm|mov)(?:$|[?#])/i.exec(src.split('?')[0] + '?');
    if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    return item.type === 'reel' ? 'mp4' : 'jpg';
}

function fileNameOf(item) { return `${item.type}_${item.fbid}.${extOf(item)}`; }
function subDirOf(item) { return item.type === 'reel' ? 'reels' : 'images'; }
const isHd = (item) => item.status === 'ready' && (item.type === 'image' || item.quality !== 'SD');

function publicItem(item) {
    return {
        id: item.key, type: item.type, fbid: item.fbid, href: item.href,
        thumb: mediaUrl(item.thumbSrc), width: item.width, height: item.height,
        views: item.views || '', alt: item.alt || '', caption: item.caption || '', time: item.time || 0,
        quality: item.quality || '', status: item.status, error: item.error || '', hd: isHd(item), idx: item.idx,
    };
}

function scanMeta(scan) {
    const counts = { image: 0, reel: 0, ready: 0, pending: 0 };
    for (const it of scan.items.values()) {
        counts[it.type]++;
        if (it.status === 'ready') counts.ready++;
        else if (it.status === 'pending') counts.pending++;
    }
    return {
        id: scan.id, status: scan.status, phase: scan.phase, error: scan.error, demo: scan.demo,
        profile: scan.profile ? { ...scan.profile, avatar: mediaUrl(scan.profile.avatar), cover: mediaUrl(scan.profile.cover) } : null,
        counts, favKey: favKeyOf(scan), queue: scan.queue.length + scan.active,
    };
}

function broadcast(scan, event, data) {
    for (const emit of scan.clients) emit(event, data);
}

function setSlug(scan) {
    const p = scan.profile || {};
    scan.slug = scan.demo ? 'demo' : `${safeName(p.name)}_${safeName(p.key || 'profile', 40)}`;
}

function addTiles(scan, tiles) {
    const fresh = [];
    for (const t of tiles) {
        const key = (t.type === 'reel' ? 'r' : 'i') + t.id;
        if (scan.items.has(key)) continue;
        const dims = dimsFromThumb(t.thumb) || (t.demo ? { width: t.demo.width, height: t.demo.height } : null)
            || (t.type === 'reel' ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 });
        const item = {
            key, type: t.type, fbid: t.id, href: t.href, thumbSrc: t.thumb, width: dims.width, height: dims.height,
            views: t.views || '', alt: t.alt || '', caption: '', time: 0, quality: '', status: 'pending',
            idx: scan.order.length, demo: t.demo || null, src: null, file: null,
        };
        const cached = !scan.demo && resolveCache.get(`${item.type}:${item.fbid}`);
        if (cached && Date.now() - cached.ts < RESOLVE_TTL) applyResolved(item, cached.r);
        scan.items.set(key, item);
        scan.order.push(key);
        fresh.push(publicItem(item));
    }
    if (fresh.length) broadcast(scan, 'items', fresh);
}

function newScan(input) {
    const scan = {
        id: uid(), input, demo: demo.isDemo(input), profile: null, items: new Map(), order: [],
        phase: 'starting', status: 'running', error: null, clients: new Set(), ctrl: new AbortController(),
        queue: [], active: 0, pausedUntil: 0, slug: '', created: Date.now(), lastClient: Date.now(),
    };
    scans.set(scan.id, scan);
    while (scans.size > MAX_SCANS) {
        const oldest = [...scans.values()].sort((a, b) => a.created - b.created)[0];
        oldest.ctrl.abort(); scans.delete(oldest.id);
    }
    runScan(scan);
    return scan;
}

async function runScan(scan) {
    const emit = (event, data) => {
        if (event === 'profile') {
            scan.profile = data; setSlug(scan);
            broadcast(scan, 'meta', scanMeta(scan));
        } else if (event === 'phase') {
            scan.phase = data.phase; broadcast(scan, 'meta', scanMeta(scan));
        } else if (event === 'items') {
            addTiles(scan, data);
        } else if (event === 'thumbs') {
            const upd = [];
            for (const t of data) {
                const it = scan.items.get((t.type === 'reel' ? 'r' : 'i') + t.id);
                if (it && !it.thumbSrc && t.thumb) {
                    it.thumbSrc = t.thumb;
                    const d = dimsFromThumb(t.thumb); if (d && it.status !== 'ready') Object.assign(it, d);
                    upd.push(publicItem(it));
                }
            }
            if (upd.length) broadcast(scan, 'update', upd);
        } else if (event === 'notice') {
            broadcast(scan, 'notice', data);
        }
    };
    try {
        if (scan.demo) await demo.scan({ signal: scan.ctrl.signal, emit });
        else await fb.scan(scan.input, { signal: scan.ctrl.signal, emit });
        scan.status = scan.ctrl.signal.aborted ? 'stopped' : 'done';
    } catch (e) {
        scan.status = 'error';
        scan.error = e.code || 'SCAN_FAILED';
        scan.errorDetail = e.detail || e.message;
        console.warn('[scan]', scan.error, scan.errorDetail);
    }
    scan.phase = scan.status;
    broadcast(scan, 'meta', scanMeta(scan));
    if (scan.status === 'done') touchFavorite(scan);
}

/* --------------------------------------------------------------- resolve */

function applyResolved(item, r) {
    item.src = r.url; item.file = r.file || null;
    if (r.width) item.width = r.width;
    if (r.height) item.height = r.height;
    item.time = r.time || item.time; item.caption = r.caption || item.caption;
    item.alt = r.alt || item.alt; item.quality = r.quality || item.quality;
    item.status = 'ready'; item.error = '';
}

function resolveOne(scan, item) {
    if (item.status === 'ready') return Promise.resolve(item);
    if (item._p) return item._p;
    item._p = (async () => {
        try {
            const r = scan.demo ? await demo.resolve(item) : await fb.resolve(item.type, item.fbid);
            if (!scan.demo) resolveCache.set(`${item.type}:${item.fbid}`, { r, ts: Date.now() });
            applyResolved(item, r);
            broadcast(scan, 'update', [publicItem(item)]);
            return item;
        } catch (e) {
            item.error = e.code || 'RESOLVE_FAILED';
            if (e.code !== 'RATE_LIMITED') item.status = 'error';
            broadcast(scan, 'update', [publicItem(item)]);
            if (e.code === 'RATE_LIMITED' || e.code === 'LOGIN_REQUIRED') broadcast(scan, 'notice', { code: e.code });
            throw e;
        } finally {
            item._p = null;
        }
    })();
    return item._p;
}

/* front = true: visible tiles jump the queue; bulk checks (HD filter) go to the back */
function enqueue(scan, keys, front = false) {
    const add = [];
    for (const k of keys) {
        const it = scan.items.get(k);
        if (!it || it.status === 'ready' || it._p) continue;
        if (it.status === 'error') { if (!front) continue; it.status = 'pending'; }
        if (it._queued) { if (front) { scan.queue = scan.queue.filter((q) => q !== it); add.push(it); } continue; }
        it._queued = true;
        add.push(it);
    }
    if (front) scan.queue.unshift(...add); else scan.queue.push(...add);
    pump(scan);
}

function pump(scan) {
    if (Date.now() < scan.pausedUntil) {
        clearTimeout(scan._pumpTimer);
        scan._pumpTimer = setTimeout(() => pump(scan), scan.pausedUntil - Date.now() + 50);
        return;
    }
    while (scan.active < RESOLVE_CONCURRENCY && scan.queue.length) {
        const it = scan.queue.shift();
        it._queued = false;
        if (it.status === 'ready' || it._p) continue;
        scan.active++;
        resolveOne(scan, it)
            .catch((e) => {
                if (e.code === 'RATE_LIMITED') { scan.pausedUntil = Date.now() + 60000; scan.queue.push(it); it._queued = true; }
                if (e.code === 'LOGIN_REQUIRED') { scan.queue.forEach((q) => { q._queued = false; }); scan.queue = []; }
            })
            .finally(() => {
                scan.active--;
                if (!scan.queue.length && !scan.active) broadcast(scan, 'meta', scanMeta(scan));
                setTimeout(() => pump(scan), scan.demo ? 20 : 180 + Math.random() * 320);
            });
    }
}

/* ------------------------------------------------------------------- zip */

const jobs = new Map();

function jobMeta(job) {
    return { id: job.id, state: job.state, done: job.done, total: job.total, failed: job.failed.length, size: job.size, error: job.error, current: job.current, name: job.name };
}

function jobEmit(job, force = true) {
    const now = Date.now();
    if (!force && now - (job._lastEmit || 0) < 120) return;
    job._lastEmit = now;
    const m = jobMeta(job);
    for (const emit of job.clients) emit('job', m);
}

async function loadEntry(scan, item) {
    await resolveOne(scan, item);
    if (item.file) return fsp.readFile(item.file);
    return fetchBuffer(item.src);
}

function appendEntry(archive, data, name, job) {
    return new Promise((resolve, reject) => {
        const onEntry = (e) => { if (e.name === name) { cleanup(); resolve(); } };
        const onError = (err) => { cleanup(); reject(err); };
        const cleanup = () => { archive.off('entry', onEntry); archive.off('error', onError); job._abort = null; };
        job._abort = () => onError(new Error('ABORTED'));
        archive.on('entry', onEntry);
        archive.on('error', onError);
        archive.append(data, { name, date: new Date() });
    });
}

/* The ZIP is built while it is being downloaded – no temporary file on the server. */
async function streamZip(job, scan, res) {
    const archiver = require('archiver');
    const archive = archiver('zip', { store: true });
    const items = job.items;
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    job.name = `${scan.slug || 'facebook'}_${safeName(job.label, 20)}_${stamp}.zip`;
    job.state = 'fetching';
    res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': disposition(job.name), 'cache-control': 'no-store' });
    res.on('close', () => {
        if (job.state === 'done' || res.writableFinished) return;
        job.cancelled = true;          // browser download cancelled or tab closed
        if (job._abort) job._abort();
    });
    archive.on('warning', () => {});
    archive.on('error', (e) => { job.cancelled = true; job.error = e.message; if (job._abort) job._abort(); });
    archive.pipe(res);
    jobEmit(job);

    const tasks = new Array(items.length);
    const manifest = [];
    for (let i = 0; i < items.length && !job.cancelled; i++) {
        for (let k = i; k < Math.min(items.length, i + ZIP_LOOKAHEAD); k++) {
            if (!tasks[k]) { tasks[k] = loadEntry(scan, items[k]); tasks[k].catch(() => {}); }
        }
        const item = items[i];
        try {
            const buf = await tasks[i];
            tasks[i] = true;   // release the buffer
            const name = `${subDirOf(item)}/${fileNameOf(item)}`;
            await appendEntry(archive, buf, name, job);
            manifest.push({ file: name, type: item.type, id: item.fbid, page: item.href, width: item.width, height: item.height, time: item.time || null, caption: item.caption || '', alt: item.alt || '', views: item.views || '', quality: item.quality || '' });
        } catch {
            job.failed.push(item.key);
        }
        job.done++;
        job.current = publicItem(item).thumb;
        jobEmit(job, false);
    }
    if (job.cancelled) {
        archive.abort();
        if (!res.writableEnded) res.destroy();
        job.state = job.error ? 'error' : 'cancelled';
        return jobEmit(job);
    }
    archive.append(JSON.stringify({ app: 'Aurora Vault', version: VERSION, created: new Date().toISOString(), profile: scan.profile, items: manifest }, null, 2), { name: 'manifest.json' });
    await new Promise((resolve) => { res.on('finish', resolve); res.on('close', resolve); archive.finalize().catch(resolve); });
    job.size = archive.pointer();
    job.state = job.cancelled ? 'cancelled' : 'done';
    jobEmit(job);
    job.items = null;
    setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref();
}

/* ============================================================== favorites */

function favKeyOf(scan) {
    if (scan.demo) return 'demo';
    return scan.profile && scan.profile.key ? String(scan.profile.key) : '';
}

function readFavs() {
    try {
        const d = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'));
        return Array.isArray(d.favorites) ? d.favorites : [];
    } catch { return []; }
}

function writeFavs(list) {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = FAV_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ app: 'Aurora Vault', version: VERSION, favorites: list }, null, 2));
    fs.renameSync(tmp, FAV_FILE);
    return list;
}

async function avatarData(src) {
    try {
        if (!src) return '';
        if (src.startsWith('/demo/')) {
            const buf = await fsp.readFile(path.join(PUBLIC, src));
            return 'data:image/jpeg;base64,' + buf.toString('base64');
        }
        const buf = await fetchBuffer(src, 600 * 1024);
        return 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch { return ''; }
}

function scanCounts(scan) {
    let image = 0, reel = 0;
    for (const it of scan.items.values()) { if (it.type === 'image') image++; else reel++; }
    return { image, reel };
}

async function addFavorite(scan) {
    const key = favKeyOf(scan);
    if (!key || !scan.profile) throw Object.assign(new Error('NO_PROFILE'), { code: 'NO_PROFILE' });
    const p = scan.profile;
    const list = readFavs();
    const prev = list.find((f) => f.key === key);
    const fav = {
        key,
        name: p.name || key,
        url: scan.demo ? 'demo' : (p.url || scan.input),
        followers: p.followers || '',
        avatar: (await avatarData(p.avatar)) || (prev && prev.avatar) || '',
        counts: scanCounts(scan),
        added: prev ? prev.added : new Date().toISOString(),
        lastScan: new Date().toISOString(),
    };
    const next = prev ? list.map((f) => (f.key === key ? fav : f)) : [fav, ...list];
    return writeFavs(next);
}

function touchFavorite(scan) {
    const key = favKeyOf(scan);
    if (!key) return;
    const list = readFavs();
    const f = list.find((x) => x.key === key);
    if (!f) return;
    f.lastScan = new Date().toISOString();
    f.counts = scanCounts(scan);
    if (scan.profile && scan.profile.followers) f.followers = scan.profile.followers;
    try { writeFavs(list); } catch { /* ignore */ }
}

function cleanFavorite(x) {
    if (!x || typeof x.key !== 'string' || typeof x.url !== 'string' || !x.key.trim()) return null;
    const avatar = typeof x.avatar === 'string' && x.avatar.startsWith('data:image/') && x.avatar.length < 900000 ? x.avatar : '';
    return {
        key: x.key.slice(0, 120), name: String(x.name || x.key).slice(0, 160), url: x.url.slice(0, 500),
        followers: String(x.followers || '').slice(0, 60), avatar,
        counts: { image: Number(x.counts && x.counts.image) || 0, reel: Number(x.counts && x.counts.reel) || 0 },
        added: String(x.added || new Date().toISOString()), lastScan: String(x.lastScan || ''),
    };
}

/* ================================================================ routing */

async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = (re) => re.exec(p);
    let r;

    if (p === '/api/status' && req.method === 'GET') {
        const st = fb.status();
        return send(res, 200, { ...st, avatar: mediaUrl(st.avatar), version: VERSION, platform: process.platform });
    }
    if (p === '/api/login' && req.method === 'POST') {
        try { return send(res, 200, await fb.login()); } catch (e) { return send(res, 500, { error: e.code || 'LOGIN_FAILED', detail: e.detail || e.message }); }
    }
    if (p === '/api/login/cancel' && req.method === 'POST') return send(res, 200, await fb.cancelLogin());
    if (p === '/api/logout' && req.method === 'POST') return send(res, 200, await fb.logout());

    /* ----- scans */
    if (p === '/api/scans' && req.method === 'POST') {
        const body = await readJson(req);
        const input = String(body.url || '').trim();
        if (!demo.isDemo(input) && !fb.parseProfile(input)) return send(res, 400, { error: 'BAD_URL' });
        const scan = newScan(input);
        return send(res, 200, { id: scan.id });
    }
    if ((r = m(/^\/api\/scans\/([a-f0-9]+)\/events$/))) {
        const scan = scans.get(r[1]);
        if (!scan) return send(res, 404, { error: 'SCAN_NOT_FOUND' });
        const emit = sseOpen(res);
        emit('snapshot', { meta: scanMeta(scan), items: scan.order.map((k) => publicItem(scan.items.get(k))) });
        scan.clients.add(emit);
        res.on('close', () => { scan.clients.delete(emit); scan.lastClient = Date.now(); });
        return;
    }
    if ((r = m(/^\/api\/scans\/([a-f0-9]+)\/stop$/)) && req.method === 'POST') {
        const scan = scans.get(r[1]);
        if (scan) scan.ctrl.abort();
        return send(res, 200, { ok: true });
    }
    if ((r = m(/^\/api\/scans\/([a-f0-9]+)\/prefetch$/)) && req.method === 'POST') {
        const scan = scans.get(r[1]);
        if (!scan) return send(res, 404, { error: 'SCAN_NOT_FOUND' });
        const body = await readJson(req);
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 20000) : [];
        enqueue(scan, ids, body.priority !== 'low');
        broadcast(scan, 'meta', scanMeta(scan));
        return send(res, 200, { ok: true, queued: scan.queue.length });
    }
    if ((r = m(/^\/api\/scans\/([a-f0-9]+)\/items\/([ir]\d+)\/(media|download|info)$/))) {
        const scan = scans.get(r[1]);
        const item = scan && scan.items.get(r[2]);
        if (!item) return send(res, 404, { error: 'ITEM_NOT_FOUND' });
        const action = r[3];
        try {
            await resolveOne(scan, item);
            if (action === 'info') return send(res, 200, publicItem(item));
            const download = action === 'download';
            const name = fileNameOf(item);
            if (item.file) return serveFile(req, res, item.file, { download, filename: name, cache: 'private, max-age=600' });
            return proxy(req, res, item.src, { download, filename: name });
        } catch (e) {
            return send(res, e.code === 'LOGIN_REQUIRED' ? 401 : 502, { error: e.code || 'FAILED', detail: e.message });
        }
    }
    if (p === '/api/media' && (req.method === 'GET' || req.method === 'HEAD')) {
        return proxy(req, res, url.searchParams.get('u') || '');
    }

    /* ----- zip */
    if (p === '/api/zip' && req.method === 'POST') {
        const body = await readJson(req);
        const scan = scans.get(String(body.scanId || ''));
        if (!scan) return send(res, 404, { error: 'SCAN_NOT_FOUND' });
        if (!scan.slug) setSlug(scan);
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const items = ids.map((k) => scan.items.get(k)).filter(Boolean);
        if (!items.length) return send(res, 400, { error: 'NOTHING_SELECTED' });
        const job = { id: uid(), scanId: scan.id, label: String(body.label || 'all'), items, total: items.length, done: 0, failed: [], state: 'ready', size: 0, error: null, clients: new Set(), current: '', name: '' };
        jobs.set(job.id, job);
        setTimeout(() => { if (job.state === 'ready') jobs.delete(job.id); }, 30 * 60 * 1000).unref();
        return send(res, 200, { id: job.id });
    }
    if ((r = m(/^\/api\/jobs\/([a-f0-9]+)\/download$/)) && req.method === 'GET') {
        const job = jobs.get(r[1]);
        if (!job) return send(res, 404, { error: 'JOB_NOT_FOUND' });
        if (job.state !== 'ready') return send(res, 409, { error: 'ALREADY_STARTED' });
        const scan = scans.get(job.scanId);
        if (!scan) return send(res, 404, { error: 'SCAN_NOT_FOUND' });
        return streamZip(job, scan, res);
    }
    if ((r = m(/^\/api\/jobs\/([a-f0-9]+)\/events$/))) {
        const job = jobs.get(r[1]);
        if (!job) return send(res, 404, { error: 'JOB_NOT_FOUND' });
        const emit = sseOpen(res);
        emit('job', jobMeta(job));
        job.clients.add(emit);
        res.on('close', () => job.clients.delete(emit));
        return;
    }
    if ((r = m(/^\/api\/jobs\/([a-f0-9]+)\/cancel$/)) && req.method === 'POST') {
        const job = jobs.get(r[1]);
        if (job) {
            job.cancelled = true;
            if (job._abort) job._abort();
            if (job.state === 'ready') { job.state = 'cancelled'; jobEmit(job); }
        }
        return send(res, 200, { ok: true });
    }

    /* ----- favorites */
    if (p === '/api/favorites' && req.method === 'GET') return send(res, 200, { favorites: readFavs() });
    if (p === '/api/favorites' && req.method === 'POST') {
        const body = await readJson(req);
        const scan = scans.get(String(body.scanId || ''));
        if (!scan) return send(res, 404, { error: 'SCAN_NOT_FOUND' });
        try { return send(res, 200, { favorites: await addFavorite(scan) }); } catch (e) { return send(res, 400, { error: e.code || 'FAILED' }); }
    }
    if ((r = m(/^\/api\/favorites\/(.+)$/)) && req.method === 'DELETE') {
        const key = decodeURIComponent(r[1]);
        return send(res, 200, { favorites: writeFavs(readFavs().filter((f) => f.key !== key)) });
    }
    if (p === '/api/favorites-export' && req.method === 'GET') {
        const body = JSON.stringify({ app: 'Aurora Vault', version: VERSION, exported: new Date().toISOString(), favorites: readFavs() }, null, 2);
        return send(res, 200, body, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': disposition(`aurora-vault-favorites_${new Date().toISOString().slice(0, 10)}.json`) });
    }
    if (p === '/api/favorites-import' && req.method === 'POST') {
        const body = await readJson(req);
        const incoming = (Array.isArray(body.favorites) ? body.favorites : []).map(cleanFavorite).filter(Boolean);
        if (!incoming.length) return send(res, 400, { error: 'NO_FAVORITES' });
        const map = new Map(readFavs().map((f) => [f.key, f]));
        for (const f of incoming) map.set(f.key, { ...(map.get(f.key) || {}), ...f });
        return send(res, 200, { favorites: writeFavs([...map.values()]), imported: incoming.length });
    }
    return send(res, 404, { error: 'NOT_FOUND' });
}

async function handleStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const abs = path.resolve(PUBLIC, '.' + rel);
    if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
    const cache = rel.startsWith('/demo/') || rel.startsWith('/fonts/') ? 'public, max-age=3600' : 'no-cache';
    return serveFile(req, res, abs, { cache });
}

const server = http.createServer(async (req, res) => {
    if (!checkAuth(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Aurora Vault", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
        return res.end('Password required');
    }
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
    try {
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
        return await handleStatic(req, res, url);
    } catch (e) {
        console.error('[server]', e);
        return send(res, 500, { error: e.code || 'SERVER_ERROR', detail: e.message });
    }
});

// stop running scans nobody watches anymore (tab closed)
setInterval(() => {
    for (const scan of scans.values()) {
        if (scan.status === 'running' && scan.clients.size === 0 && Date.now() - scan.lastClient > 90000) scan.ctrl.abort();
    }
}, 15000).unref();

function listen(port, tries = 0) {
    server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && tries < 20) return listen(port + 1, tries + 1);
        console.error(e); process.exit(1);
    });
    server.listen(port, HOST, () => {
        const url = `http://localhost:${port}`;
        console.log('\n  ┌─────────────────────────────────────────┐');
        console.log('  │  AURORA VAULT  ·  Facebook Media Vault  │');
        console.log('  └─────────────────────────────────────────┘');
        console.log(`\n  App:        ${url}${HOST !== '127.0.0.1' && HOST !== 'localhost' ? `   (listening on ${HOST})` : ''}`);
        if (PASSWORD) console.log('  Password:   on');
        else if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('  WARNING:    reachable in the network without a password. Set AV_PASSWORD.');
        console.log('\n  Keep this window open while you use the app. Close it to stop.\n');
        openBrowser(url);
    });
}

async function shutdown() {
    await fb.shutdown().catch(() => {});
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

listen(START_PORT);
