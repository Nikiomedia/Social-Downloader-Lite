/**
 * game.js – "Aurora Snake", a small game for waiting times (scan, HD check, ZIP).
 * The snake is made of light and eats the thumbnails the scan has just found.
 * Wrap-around walls (friendly), game over only when the snake bites itself.
 * Controls: arrow keys / WASD, space = pause, Enter = start, Esc = close, swipe on touch screens.
 */
import { t, fmtNumber } from './i18n.js';

const LANDSCAPE = [26, 16];   // columns × rows
const PORTRAIT = [15, 22];    // phones held upright
const START_STEP = 128;     // ms per move
const MIN_STEP = 62;
const HUES = [[69, 240, 224], [138, 108, 255], [255, 79, 182]];
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (id) => document.getElementById(id);
const store = {
    get(k, d) { try { const v = localStorage.getItem('av.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('av.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

function mixColor(k) {           // 0..1 along the aurora gradient
    const x = Math.max(0, Math.min(1, k)) * (HUES.length - 1);
    const i = Math.min(HUES.length - 2, Math.floor(x));
    const f = x - i;
    const a = HUES[i], b = HUES[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const rgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;

export function createSnake({ foodSource, onResults, onOpenChange }) {
    const root = $('game');
    const panel = $('gamePanel');
    const stage = $('gameStage');
    const canvas = $('gameCanvas');
    const ctx = canvas.getContext('2d');
    const el = {
        score: $('gameScore'), best: $('gameBest'), status: $('gameStatus'), overlay: $('gameOverlay'),
        oTitle: $('gameOverlayTitle'), oText: $('gameOverlayText'), banner: $('gameBanner'), bannerText: $('gameBannerText'),
        bannerBtn: $('gameBannerBtn'), haul: $('gameHaul'), hint: $('gameHint'), close: $('gameClose'), veil: $('gameVeil'),
        badge: $('gameDoneBadge'), actions: $('gameActions'), cont: $('gameContinue'), contText: $('gameContinueText'),
        results: $('gameResults'), resultsText: $('gameResultsText'),
    };

    let state = 'ready';           // ready | playing | paused | over | done (scan finished, game frozen)
    let resumeTo = null;           // state to go back to after the "scan finished" card
    let doneContent = null;        // () => { title, text, tone }  (a function, so a language switch re-renders it)
    let doneAt = 0;
    let flashC = [69, 240, 224], flashA = 0.08;
    const bursts = [];
    let snake = [], prev = [], dir = { x: 1, y: 0 }, queue = [];
    let food = null, score = 0, best = store.get('snakeBest', 0), stepMs = START_STEP;
    let acc = 0, last = 0, raf = 0, cell = 24, pad = 20, dpr = 1, isOpen = false, flash = 0, lastFocus = null;
    let cols = LANDSCAPE[0], rows = LANDSCAPE[1];
    let fieldPath = null;
    const particles = [], pops = [];
    const images = new Map();
    let dots = null;               // cached background grid

    function img(url) {
        if (!url) return null;
        let im = images.get(url);
        if (!im) { im = new Image(); im.decoding = 'async'; im.src = url; images.set(url, im); }
        return im.complete && im.naturalWidth ? im : null;
    }

    /* ----------------------------------------------------------- sizing */
    function resize() {
        const w = stage.clientWidth, h = stage.clientHeight;
        // a margin around the field so glows fade out inside the canvas (no hard cut at its edge)
        cell = Math.max(10, Math.floor(Math.min(w / (cols + 1.8), h / (rows + 1.8))));
        pad = Math.round(cell * 0.9);
        dpr = Math.min(2, window.devicePixelRatio || 1);
        const cw = cell * cols + pad * 2, ch = cell * rows + pad * 2;
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
        dots = null;
    }

    function drawDots() {
        dots = document.createElement('canvas');
        dots.width = canvas.width; dots.height = canvas.height;
        const d = dots.getContext('2d');
        d.scale(dpr, dpr);
        d.translate(pad, pad);
        const W = cell * cols, H = cell * rows, r = Math.min(18, cell * 0.7);
        const field = new Path2D();                     // visible playfield with soft frame (field coordinates)
        field.roundRect(-cell * 0.3, -cell * 0.3, W + cell * 0.6, H + cell * 0.6, r);
        const bg = d.createLinearGradient(0, 0, W, H);
        bg.addColorStop(0, 'rgba(69, 240, 224, 0.035)'); bg.addColorStop(0.5, 'rgba(138, 108, 255, 0.03)'); bg.addColorStop(1, 'rgba(255, 79, 182, 0.035)');
        d.fillStyle = bg; d.fill(field);
        d.strokeStyle = 'rgba(160, 200, 255, 0.14)'; d.lineWidth = 1; d.stroke(field);
        fieldPath = field;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                d.fillStyle = (x + y) % 2 ? 'rgba(160, 190, 255, 0.07)' : 'rgba(160, 190, 255, 0.13)';
                d.beginPath(); d.arc((x + 0.5) * cell, (y + 0.5) * cell, Math.max(1, cell * 0.05), 0, Math.PI * 2); d.fill();
            }
        }
    }

    /* ------------------------------------------------------------ logic */
    function reset() {
        const portrait = stage.clientHeight > stage.clientWidth * 1.1;
        [cols, rows] = portrait ? PORTRAIT : LANDSCAPE;
        resize();
        const y = Math.floor(rows / 2);
        snake = [{ x: 8, y }, { x: 7, y }, { x: 6, y }, { x: 5, y }];
        prev = snake.map((s) => ({ ...s }));
        dir = { x: 1, y: 0 }; queue = [];
        score = 0; stepMs = START_STEP; acc = 0;
        el.haul.replaceChildren();
        placeFood();
        hud();
    }

    function placeFood() {
        const free = [];
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
            if (!snake.some((s) => s.x === x && s.y === y)) free.push({ x, y });
        }
        const spot = free[(Math.random() * free.length) | 0];
        const url = foodSource();
        if (url) img(url);
        food = { ...spot, url, born: performance.now(), hue: Math.random() };
    }

    function turn(x, y) {
        if (state === 'done') return;          // the "scan finished" card needs a deliberate choice
        if (state === 'ready' || state === 'over') start();
        if (state === 'paused') setState('playing');
        const lastDir = queue.length ? queue[queue.length - 1] : dir;
        if ((x === -lastDir.x && y === -lastDir.y) || (x === lastDir.x && y === lastDir.y)) return;
        if (queue.length < 3) queue.push({ x, y });
    }

    function step() {
        if (queue.length) dir = queue.shift();
        const old = snake.map((s) => ({ ...s }));
        const head = { x: (snake[0].x + dir.x + cols) % cols, y: (snake[0].y + dir.y + rows) % rows };
        const eats = food && head.x === food.x && head.y === food.y;
        const body = eats ? snake : snake.slice(0, -1);
        if (body.some((s) => s.x === head.x && s.y === head.y)) { gameOver(); return; }
        snake.unshift(head);
        if (!eats) snake.pop();
        prev = old;
        if (eats) eat();
    }

    function eat() {
        score++;
        if (score > best) { best = score; store.set('snakeBest', best); }
        stepMs = Math.max(MIN_STEP, stepMs - 2.6);
        const cx = (food.x + 0.5) * cell, cy = (food.y + 0.5) * cell;
        const c = mixColor(food.hue);
        for (let i = 0; i < 26; i++) {
            const a = Math.random() * Math.PI * 2, v = (0.6 + Math.random() * 2.4) * (cell / 12);
            particles.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 30 + Math.random() * 24, c: i % 3 ? c : [255, 255, 255], s: 1 + Math.random() * 2.2 });
        }
        pops.push({ x: cx, y: cy, life: 0 });
        flash = 1; flashC = [69, 240, 224]; flashA = 0.08;
        if (food.url) {
            const th = document.createElement('img');
            th.src = food.url; th.alt = '';
            el.haul.prepend(th);
            while (el.haul.children.length > 10) el.haul.lastElementChild.remove();
        }
        hud();
        placeFood();
    }

    function gameOver() {
        setState('over');
        flash = 1.6; flashC = [255, 79, 122]; flashA = 0.18;
        if (!reduce) panel.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-10px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 420 });
        const head = snake[0];
        for (let i = 0; i < 60; i++) {
            const a = Math.random() * Math.PI * 2, v = (1 + Math.random() * 4) * (cell / 12);
            particles.push({ x: (head.x + 0.5) * cell, y: (head.y + 0.5) * cell, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 40 + Math.random() * 30, c: mixColor(Math.random()), s: 1.5 + Math.random() * 2.5 });
        }
    }

    function start() {
        reset();
        setState('playing');
    }

    function setState(s) {
        state = s;
        const show = s !== 'playing';
        const done = s === 'done' && doneContent ? doneContent() : null;
        el.overlay.classList.toggle('is-on', show);
        el.overlay.classList.toggle('is-done', !!done);
        el.overlay.classList.toggle('is-err', !!done && done.tone === 'err');
        el.badge.hidden = !done;
        el.actions.hidden = !done;
        el.badge.innerHTML = `<svg><use href="#${done && done.tone === 'err' ? 'i-close' : 'i-check'}"/></svg>`;
        if (s === 'ready') { el.oTitle.textContent = t('gameReady'); el.oText.textContent = t('gameReadyHint'); }
        else if (s === 'paused') { el.oTitle.textContent = t('gamePaused'); el.oText.textContent = t('gamePausedHint'); }
        else if (s === 'over') { el.oTitle.textContent = t('gameOver'); el.oText.textContent = t('gameOverHint', { score: fmtNumber(score) }); }
        else if (done) {
            el.oTitle.textContent = done.title;
            el.oText.textContent = done.text;
            el.contText.textContent = resumeTo === 'playing' || resumeTo === 'paused' ? t('gameContinue') : t('gameNewRound');
            el.resultsText.textContent = t('gameToResults');
        }
        hud();
    }

    /* the scan (or whatever the game was waiting for) has finished: freeze the game and say so, loud and clear */
    function announce(getContent) {
        doneContent = getContent;
        if (state !== 'done') resumeTo = state;
        doneAt = performance.now();
        el.banner.hidden = true;
        setState('done');
        const tone = getContent().tone;
        flash = 1.5; flashC = tone === 'err' ? [255, 79, 122] : [92, 242, 166]; flashA = 0.16;
        if (tone !== 'err') {
            const W = cell * cols, H = cell * rows, now = performance.now();
            const n = reduce ? 1 : 6;
            for (let i = 0; i < n; i++) {
                bursts.push({ at: now + i * 190, x: W * (0.18 + Math.random() * 0.64), y: H * (0.15 + Math.random() * 0.55), c: [[92, 242, 166], ...HUES][i % 4] });
            }
            if (!reduce) {
                panel.classList.remove('is-cheering');
                void panel.offsetWidth;          // restart the CSS animation
                panel.classList.add('is-cheering');
                setTimeout(() => panel.classList.remove('is-cheering'), 1900);
            }
        }
    }

    function resume() {
        if (state !== 'done') return;
        const to = resumeTo;
        resumeTo = null;
        if (to === 'playing' || to === 'paused') setState('playing'); else start();
        stage.focus({ preventScroll: true });
    }

    function leaveDone() {             // closing the game keeps a running round paused
        if (state !== 'done') return;
        const to = resumeTo;
        resumeTo = null;
        setState(to === 'playing' || to === 'paused' ? 'paused' : (to || 'ready'));
    }

    function toResults() { close(); onResults && onResults(); }

    function hud() {
        el.score.textContent = fmtNumber(score);
        el.best.textContent = fmtNumber(best);
    }

    /* ---------------------------------------------------------- drawing */
    function lerp(a, b, k) {
        if (Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1) return b;   // wrapped around the edge
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }

    function render(now) {
        const k = state === 'playing' ? Math.min(1, acc / stepMs) : 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!dots) drawDots();
        ctx.drawImage(dots, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
        const W = cell * cols, H = cell * rows;

        // food: pulsing thumbnail orb
        if (food) {
            const cx = (food.x + 0.5) * cell, cy = (food.y + 0.5) * cell;
            const age = Math.min(1, (now - food.born) / 380);
            const pulse = 1 + Math.sin(now / 220) * 0.06;
            const r = cell * 0.46 * pulse * (0.4 + 0.6 * (1 - (1 - age) ** 3));
            const c = mixColor(food.hue);
            const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.4);
            glow.addColorStop(0, rgba(c, 0.45)); glow.addColorStop(1, rgba(c, 0));
            ctx.fillStyle = glow;
            ctx.beginPath(); ctx.arc(cx, cy, r * 2.4, 0, Math.PI * 2); ctx.fill();
            const im = img(food.url);
            ctx.save();
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
            if (im) {
                const s = Math.max((2 * r) / im.naturalWidth, (2 * r) / im.naturalHeight);
                const w = im.naturalWidth * s, h = im.naturalHeight * s;
                ctx.drawImage(im, cx - w / 2, cy - h / 2, w, h);
            } else {
                const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 1, cx, cy, r);
                g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, rgba(c, 1)); g.addColorStop(1, rgba(mixColor(food.hue + 0.4), 1));
                ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
            }
            ctx.restore();
            ctx.strokeStyle = rgba([255, 255, 255], 0.8);
            ctx.lineWidth = Math.max(1, cell * 0.06);
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        }

        // snake: glow pass, then body, then head
        const n = snake.length;
        const pts = snake.map((s, i) => lerp(prev[Math.min(i, prev.length - 1)] || s, s, k));
        ctx.globalCompositeOperation = 'lighter';
        for (let i = n - 1; i >= 0; i--) {
            const p = pts[i], c = mixColor(i / Math.max(1, n - 1));
            const cx = (p.x + 0.5) * cell, cy = (p.y + 0.5) * cell;
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 1.1);
            g.addColorStop(0, rgba(c, 0.22)); g.addColorStop(1, rgba(c, 0));
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(cx, cy, cell * 1.1, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        for (let i = n - 1; i >= 0; i--) {
            const p = pts[i], c = mixColor(i / Math.max(1, n - 1));
            const cx = (p.x + 0.5) * cell, cy = (p.y + 0.5) * cell;
            const r = cell * (i === 0 ? 0.47 : 0.42 - Math.min(0.12, i * 0.004));
            const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
            g.addColorStop(0, rgba([255, 255, 255], 0.95)); g.addColorStop(0.35, rgba(c, 1)); g.addColorStop(1, rgba(c.map((v) => v * 0.55), 1));
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        }
        if (n) {                      // eyes
            const p = pts[0];
            const cx = (p.x + 0.5) * cell, cy = (p.y + 0.5) * cell;
            const ox = dir.y !== 0 ? cell * 0.17 : 0, oy = dir.x !== 0 ? cell * 0.17 : 0;
            const fx = dir.x * cell * 0.14, fy = dir.y * cell * 0.14;
            ctx.fillStyle = '#05060b';
            for (const sgn of [-1, 1]) {
                ctx.beginPath(); ctx.arc(cx + fx + ox * sgn, cy + fy + oy * sgn, cell * 0.075, 0, Math.PI * 2); ctx.fill();
            }
        }

        // fireworks for "scan finished"
        for (let i = bursts.length - 1; i >= 0; i--) {
            const b = bursts[i];
            if (now < b.at) continue;
            bursts.splice(i, 1);
            const count = 46;
            for (let j = 0; j < count; j++) {
                const a = (j / count) * Math.PI * 2 + Math.random() * 0.1, v = (2.2 + Math.random() * 1.6) * (cell / 12);
                particles.push({ x: b.x, y: b.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 0.05 * (cell / 12), life: 0, max: 46 + Math.random() * 26, c: j % 4 ? b.c : [255, 255, 255], s: 1.2 + Math.random() * 1.8 });
            }
            pops.push({ x: b.x, y: b.y, life: 12, ring: true, c: b.c });
        }

        // particles + "+1"
        ctx.globalCompositeOperation = 'lighter';
        for (let i = particles.length - 1; i >= 0; i--) {
            const q = particles[i];
            q.life++; q.x += q.vx; q.y += q.vy; q.vx *= 0.94; q.vy *= 0.94; q.vy += q.g || 0;
            const a = 1 - q.life / q.max;
            if (a <= 0) { particles.splice(i, 1); continue; }
            ctx.fillStyle = rgba(q.c, a);
            ctx.beginPath(); ctx.arc(q.x, q.y, q.s, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        for (let i = pops.length - 1; i >= 0; i--) {
            const q = pops[i];
            q.life++;
            const a = 1 - q.life / 42;
            if (a <= 0) { pops.splice(i, 1); continue; }
            if (q.ring) {                  // expanding light ring of a firework
                ctx.strokeStyle = rgba(q.c, a * 0.7);
                ctx.lineWidth = Math.max(1, cell * 0.08);
                ctx.beginPath(); ctx.arc(q.x, q.y, (q.life - 10) * cell * 0.09, 0, Math.PI * 2); ctx.stroke();
                continue;
            }
            ctx.fillStyle = rgba([255, 255, 255], a);
            ctx.font = `700 ${Math.round(cell * 0.6)}px Unbounded, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('+1', q.x, q.y - cell * 0.6 - q.life * 0.6);
        }
        if (flash > 0) {
            ctx.fillStyle = rgba(flashC, flash * flashA);
            if (fieldPath) ctx.fill(fieldPath);   // flash only inside the rounded field, no hard canvas edge
            flash = Math.max(0, flash - (state === 'done' ? 0.03 : 0.06));
        }
    }

    function loop(now) {
        raf = 0;
        if (!isOpen) return;
        const dt = Math.min(100, now - (last || now));
        last = now;
        if (state === 'playing') {
            acc += dt;
            while (acc >= stepMs && state === 'playing') { acc -= stepMs; step(); }
        }
        render(now);
        raf = requestAnimationFrame(loop);
    }

    /* ----------------------------------------------------------- input */
    const KEYS = {
        ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
        w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    };
    window.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        e.stopPropagation();          // the app's own shortcuts (S, A, 1–3 …) pause while playing
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (state === 'done') {
            if (key === 'Escape') { e.preventDefault(); close(); return; }
            if (KEYS[key] || key === ' ') e.preventDefault();
            if (performance.now() - doneAt < 600) return;           // keys still pressed from playing don't dismiss the card
            if (key === ' ' || key === 'p') resume();
            else if (key === 'Enter' && !(e.target.closest && e.target.closest('button'))) { e.preventDefault(); toResults(); }
            return;
        }
        if (KEYS[key]) { e.preventDefault(); turn(...KEYS[key]); return; }
        if (key === ' ' || key === 'p') {
            e.preventDefault();
            if (state === 'playing') setState('paused');
            else if (state === 'paused') setState('playing');
            else start();
        } else if (key === 'Enter') {
            if (e.target.closest && e.target.closest('button')) return;
            e.preventDefault();
            if (state !== 'playing') { if (state === 'paused') setState('playing'); else start(); }
        } else if (key === 'Escape') {
            e.preventDefault();
            close();
        }
    }, true);

    stage.tabIndex = 0;
    let sx = 0, sy = 0, down = false;
    stage.addEventListener('pointerdown', (e) => { down = true; sx = e.clientX; sy = e.clientY; });
    stage.addEventListener('pointerup', (e) => {
        if (!down) return;
        down = false;
        if (state === 'done') return;          // only the two buttons act on the card
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) {       // tap
            if (state === 'ready' || state === 'over') start();
            else if (state === 'paused') setState('playing');
            return;
        }
        if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? 1 : -1, 0); else turn(0, dy > 0 ? 1 : -1);
    });
    stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    el.close.addEventListener('click', () => close());
    el.veil.addEventListener('click', () => close());
    el.bannerBtn.addEventListener('click', () => toResults());
    el.cont.addEventListener('click', (e) => { e.stopPropagation(); resume(); });
    el.results.addEventListener('click', (e) => { e.stopPropagation(); toResults(); });
    window.addEventListener('resize', () => { if (isOpen) resize(); });

    /* ------------------------------------------------------------- api */
    function open() {
        if (isOpen) return;
        isOpen = true;
        lastFocus = document.activeElement;
        root.hidden = false;
        requestAnimationFrame(() => root.classList.add('is-open'));
        resize();
        if (!snake.length) { reset(); setState('ready'); }
        else if (state === 'playing') setState('paused');
        el.hint.textContent = window.matchMedia('(pointer: coarse)').matches ? t('gameHintTouch') : t('gameHintKeys');
        last = 0;
        if (!raf) raf = requestAnimationFrame(loop);
        stage.focus({ preventScroll: true });
        onOpenChange && onOpenChange(true);
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        leaveDone();
        if (state === 'playing') setState('paused');
        root.classList.remove('is-open');
        setTimeout(() => { if (!isOpen) root.hidden = true; }, 320);
        cancelAnimationFrame(raf); raf = 0;
        lastFocus && lastFocus.focus && lastFocus.focus({ preventScroll: true });
        onOpenChange && onOpenChange(false);
    }

    function setStatus(text, mode) {          // mode: true / 'busy' (blinking dot) · 'done' (green) · falsy
        el.status.textContent = text;
        el.status.classList.toggle('is-busy', mode === true || mode === 'busy');
        el.status.classList.toggle('is-done', mode === 'done');
    }

    function notify(text, action) {
        el.bannerText.textContent = text;
        el.bannerBtn.textContent = action;
        el.banner.hidden = false;
        el.banner.animate([{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' });
    }

    function hideBanner() { el.banner.hidden = true; }

    document.addEventListener('av:lang', () => { setState(state); });
    // read-only peek for automated tests / debugging in the console
    root._snake = { get info() { return { state, resumeTo, score, best, head: snake[0], dir, food: food && { x: food.x, y: food.y }, length: snake.length }; } };
    hud();

    return { open, close, setStatus, notify, announce, hideBanner, get isOpen() { return isOpen; } };
}
