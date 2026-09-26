/**
 * fx.js – small effects: custom cursor, magnetic buttons, particle bursts,
 * text scramble, count-up numbers, headline weight field, shooting stars,
 * konami code.
 */

export const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const finePointer = window.matchMedia('(pointer: fine)').matches;
const AURORA = ['#45f0e0', '#8a6cff', '#ff4fb6', '#9ff9f1', '#ffffff'];

/* ------------------------------------------------------------ particles */
let pCanvas, pCtx, particles = [], pRaf = 0, dpr = 1;

export function initParticles(canvas) {
    pCanvas = canvas;
    pCtx = canvas.getContext('2d');
    const size = () => {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = window.innerWidth * dpr; canvas.height = window.innerHeight * dpr;
        canvas.style.width = window.innerWidth + 'px'; canvas.style.height = window.innerHeight + 'px';
    };
    size();
    window.addEventListener('resize', size);
}

function tick() {
    pRaf = 0;
    const ctx = pCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, pCanvas.width, pCanvas.height);
    ctx.globalCompositeOperation = 'lighter';
    particles = particles.filter((p) => p.life < p.max);
    for (const p of particles) {
        p.life++;
        p.vx *= p.drag; p.vy = p.vy * p.drag + p.g;
        p.x += p.vx; p.y += p.vy;
        p.rot += p.vr;
        const k = 1 - p.life / p.max;
        ctx.globalAlpha = Math.max(0, k);
        ctx.fillStyle = p.c;
        ctx.strokeStyle = p.c;
        if (p.shape === 'spark') {
            ctx.lineWidth = p.s * 0.6;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 3, p.y - p.vy * 3); ctx.stroke();
        } else if (p.shape === 'shard') {
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
            ctx.fillRect(-p.s, -p.s * 0.35, p.s * 2, p.s * 0.7);
            ctx.restore();
        } else {
            ctx.shadowBlur = 12; ctx.shadowColor = p.c;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (0.4 + k * 0.6), 0, Math.PI * 2); ctx.fill();
            ctx.shadowBlur = 0;
        }
    }
    ctx.globalAlpha = 1;
    if (particles.length) pRaf = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, pCanvas.width, pCanvas.height);
}

export function burst(x, y, { count = 26, speed = 5, colors = AURORA, gravity = 0.12, shape = 'mix', spread = Math.PI * 2, angle = -Math.PI / 2, life = 60 } = {}) {
    if (!pCtx || reduce) return;
    for (let i = 0; i < count; i++) {
        const a = angle + (Math.random() - 0.5) * spread;
        const v = speed * (0.35 + Math.random() * 0.9);
        const sh = shape === 'mix' ? (Math.random() < 0.45 ? 'spark' : Math.random() < 0.5 ? 'dot' : 'shard') : shape;
        particles.push({
            x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: gravity, drag: 0.965,
            s: 1.5 + Math.random() * 3, c: colors[(Math.random() * colors.length) | 0],
            life: 0, max: life * (0.6 + Math.random() * 0.7), shape: sh, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        });
    }
    if (!pRaf) pRaf = requestAnimationFrame(tick);
}

export function burstAt(el, opts) {
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, opts);
}

/* --------------------------------------------------------------- cursor */
export function initCursor(dot, ring, labelFor) {
    if (!finePointer || reduce) { dot.remove(); ring.remove(); return; }
    document.body.classList.add('has-cursor');
    const label = ring.querySelector('span');
    let x = -100, y = -100, rx = -100, ry = -100, raf = 0, visible = false;
    const loop = () => {
        rx += (x - rx) * 0.2; ry += (y - ry) * 0.2;
        ring.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
        raf = Math.abs(x - rx) + Math.abs(y - ry) > 0.2 ? requestAnimationFrame(loop) : 0;
    };
    window.addEventListener('pointermove', (e) => {
        if (e.pointerType !== 'mouse') return;
        x = e.clientX; y = e.clientY;
        dot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (!visible) { visible = true; dot.style.opacity = ring.style.opacity = '1'; }
        if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    document.addEventListener('pointerleave', () => { visible = false; dot.style.opacity = ring.style.opacity = '0'; });
    document.addEventListener('pointerover', (e) => {
        const t = e.target.closest?.('[data-cursor], button, a, input, label, [role="tab"]');
        ring.classList.remove('is-hover', 'is-button', 'is-bare');
        dot.classList.remove('is-under');
        if (!t) return;
        if (t.dataset.cursor === 'bare') { ring.classList.add('is-bare'); return; }   // sliders: just the precise dot
        if (t.dataset.cursor) {
            const text = labelFor(t.dataset.cursor);
            if (text) { label.textContent = text; ring.classList.add('is-hover'); dot.classList.add('is-under'); return; }
        }
        if (t.tagName !== 'INPUT') ring.classList.add('is-button');
    });
    window.addEventListener('pointerdown', () => ring.classList.add('is-press'));
    window.addEventListener('pointerup', () => ring.classList.remove('is-press'));
}

/* ------------------------------------------------------------- magnetic */
export function initMagnetic() {
    if (!finePointer || reduce) return;
    let current = null;
    const release = (el) => {
        const cur = el.style.translate || '0px 0px';
        el.style.translate = '';
        el.animate([{ translate: cur }, { translate: '0px 0px' }], { duration: 650, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
    };
    document.addEventListener('pointermove', (e) => {
        const el = e.target.closest?.('[data-magnetic]');
        if (current && current !== el) { release(current); current = null; }
        if (!el || el.disabled) return;
        current = el;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const k = Math.min(1, 44 / Math.max(r.width, r.height));
        el.style.translate = `${(dx * 0.22 * (0.6 + k)).toFixed(1)}px ${(dy * 0.3 * (0.6 + k)).toFixed(1)}px`;
    }, { passive: true });
    document.addEventListener('pointerleave', () => { if (current) { release(current); current = null; } });
}

/* ------------------------------------------------------------- scramble */
const GLYPHS = '▓▒░<>/\\|{}[]=+*#%&$01ÆØ';
export function scramble(el, text, { duration = 650 } = {}) {
    if (el._scr) cancelAnimationFrame(el._scr);
    if (reduce || !text) { el.textContent = text; return; }
    const start = performance.now();
    const step = (now) => {
        const k = Math.min(1, (now - start) / duration);
        const n = Math.floor(text.length * (1 - (1 - k) ** 2));
        let out = text.slice(0, n);
        for (let i = n; i < text.length; i++) out += text[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
        el.textContent = out;
        if (k < 1) el._scr = requestAnimationFrame(step); else { el.textContent = text; el._scr = 0; }
    };
    el._scr = requestAnimationFrame(step);
}

/* -------------------------------------------------------------- countTo */
export function countTo(el, value, fmt = (v) => String(v)) {
    const from = el._v ?? 0;
    el._v = value;
    if (el._cr) cancelAnimationFrame(el._cr);
    if (reduce || from === value) { el.textContent = fmt(value); return; }
    const start = performance.now();
    const dur = Math.min(900, 300 + Math.abs(value - from) * 25);
    const step = (now) => {
        const k = Math.min(1, (now - start) / dur);
        const e = 1 - (1 - k) ** 3;
        el.textContent = fmt(Math.round(from + (value - from) * e));
        if (k < 1) el._cr = requestAnimationFrame(step);
    };
    el._cr = requestAnimationFrame(step);
}

/* ------------------------------------------------------- headline field */
export function renderHeadline(h1, lines) {
    let i = 0;
    h1.replaceChildren(...lines.map((line) => {
        const l = document.createElement('span');
        l.className = 'line';
        for (const word of line.split(/(\s+)/)) {
            if (/^\s+$/.test(word)) { l.append(document.createTextNode(' ')); continue; }
            const w = document.createElement('span');
            w.style.whiteSpace = 'nowrap';
            for (const ch of word) {
                const c = document.createElement('span');
                c.className = 'ch'; c.textContent = ch;
                c.style.setProperty('--i', String(i++));
                w.append(c);
            }
            l.append(w);
        }
        return l;
    }));
    h1.setAttribute('aria-label', lines.join(' '));
}

export function initHeadlineField(h1) {
    if (!finePointer || reduce) return;
    let raf = 0, px = -1e4, py = -1e4, active = false;
    const update = () => {
        raf = 0;
        for (const c of h1.querySelectorAll('.ch')) {
            const r = c.getBoundingClientRect();
            const d = Math.hypot(px - (r.left + r.width / 2), py - (r.top + r.height / 2));
            const k = active ? Math.max(0, 1 - d / 190) : 0;
            const e = k * k * (3 - 2 * k);
            c.style.setProperty('--w', String(Math.round(300 + 520 * e)));
            c.style.setProperty('--ty', `${(-7 * e).toFixed(1)}px`);
        }
    };
    window.addEventListener('pointermove', (e) => {
        const r = h1.getBoundingClientRect();
        active = e.clientY > r.top - 200 && e.clientY < r.bottom + 200;
        px = e.clientX; py = e.clientY;
        if (!raf) raf = requestAnimationFrame(update);
    }, { passive: true });
}

/* -------------------------------------------------------- shooting star */
export function initShootingStars() {
    if (reduce) return;
    const fire = () => {
        if (!document.hidden) {
            const s = document.createElement('div');
            s.className = 'shooting-star';
            const x = window.innerWidth * (0.25 + Math.random() * 0.7);
            const y = window.innerHeight * (0.04 + Math.random() * 0.3);
            const ang = 200 + Math.random() * 25;   // down-left
            const dist = 320 + Math.random() * 380;
            const rad = (ang * Math.PI) / 180;
            document.body.append(s);
            s.animate([
                { transform: `translate(${x}px, ${y}px) rotate(${ang}deg) scaleX(.2)`, opacity: 0 },
                { opacity: 1, offset: 0.2 },
                { transform: `translate(${x + Math.cos(rad) * dist}px, ${y - Math.sin(rad) * dist}px) rotate(${ang}deg) scaleX(1)`, opacity: 0 },
            ], { duration: 1100 + Math.random() * 500, easing: 'cubic-bezier(.2,.6,.3,1)' }).finished.then(() => s.remove(), () => s.remove());
        }
        setTimeout(fire, 7000 + Math.random() * 14000);
    };
    setTimeout(fire, 4000);
}

/* ---------------------------------------------------------------- konami */
export function onKonami(cb) {
    const seq = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let i = 0;
    window.addEventListener('keydown', (e) => {
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        i = k === seq[i] ? i + 1 : (k === seq[0] ? 1 : 0);
        if (i === seq.length) { i = 0; cb(); }
    });
}

/* -------------------------------------------------------------- flyTo */
export function flyTo(img, from, to, { delay = 0, duration = 760 } = {}) {
    if (reduce) return Promise.resolve();
    const el = document.createElement('img');
    el.className = 'flyer';
    el.src = img;
    el.alt = '';
    Object.assign(el.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.append(el);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const s = Math.max(0.08, to.width / from.width);
    const rot = (Math.random() - 0.5) * 50;
    const anim = el.animate([
        { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 120}px) scale(${0.55 + s * 0.2}) rotate(${rot}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${rot * 2}deg)`, opacity: 0.2 },
    ], { duration, delay, easing: 'cubic-bezier(.5, 0, .25, 1)', fill: 'both' });
    return anim.finished.then(() => el.remove(), () => el.remove());
}
