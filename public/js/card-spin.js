/**
 * card-spin.js – Shared-Element-Übergang mit 360°-Kartendrehung.
 * Ein Bild löst sich aus seiner Quelle (z. B. Galerie-Kachel), fliegt als Karte
 * in sein Ziel (z. B. Lightbox), dreht sich dabei in einem Zug um die Y-Achse
 * und setzt pixelgenau auf. Rückweg = gleiche Funktion mit vertauschten Rects.
 * Nur transform/opacity werden animiert (Compositor) – flüssig, kein Blur.
 */

export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const PERSPECTIVE = 'perspective(1600px)';
const PATH_EASING = 'cubic-bezier(.45, 0, .2, 1)';   // abheben, weich aufsetzen
const SPIN_EASING = 'cubic-bezier(.42, 0, .22, 1)';  // EINE Kurve: kein Halt bei 180°

/** Zielrechteck eines Bildes mit Naturmaß w×h, eingepasst (contain, nie vergrößert)
 *  in den Inhaltsbereich von container. Aus dem Container rechnen, nicht aus dem
 *  <img> – dessen Layout steht direkt nach dem Setzen von src noch nicht fest. */
export function fitRect(container, w, h) {
    const cs = getComputedStyle(container);
    const r = container.getBoundingClientRect();
    const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0;
    const bw = container.clientWidth - pl - pr;
    const bh = container.clientHeight - pt - pb;
    const k = Math.min(1, bw / (w || bw), bh / (h || bh));
    const width = (w || bw) * k, height = (h || bh) * k;
    return {
        left: r.left + container.clientLeft + pl + (bw - width) / 2,
        top: r.top + container.clientTop + pt + (bh - height) / 2,
        width, height,
    };
}

/** Kleines Rechteck in der Mitte (Start/Ziel, wenn es keine Quelle gibt). */
export function centerRect(rect, share = 0.14) {
    return {
        left: rect.left + rect.width * (1 - share) / 2,
        top: rect.top + rect.height * (1 - share) / 2,
        width: rect.width * share,
        height: rect.height * share,
    };
}

/** 24-px-Canvas, vom Browser weich hochskaliert = billige Unschärfe (Aura, Rückseite). */
export function paintSoft(canvas, src) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
        try {
            ctx.filter = 'blur(1.5px) saturate(1.5)';
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        } catch (e) { /* Cross-Origin o. ä.: Fläche bleibt dunkel */ }
    };
    img.src = src;
}

function buildCard(src, rect) {
    const card = document.createElement('div');
    card.className = 'cs-card';
    card.setAttribute('aria-hidden', 'true');
    Object.assign(card.style, {
        left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${rect.width}px`, height: `${rect.height}px`,
    });
    const spin = document.createElement('div');
    spin.className = 'cs-spin';
    const front = document.createElement('img');
    front.className = 'cs-face cs-front';
    front.src = src;
    front.alt = '';
    front.decoding = 'sync';
    const back = document.createElement('div');
    back.className = 'cs-face cs-back';
    const bg = document.createElement('canvas');
    bg.className = 'cs-back-bg';
    bg.width = 24;
    bg.height = 24;
    paintSoft(bg, src);
    const mark = document.createElement('span');
    mark.className = 'cs-mark';
    back.append(bg, mark);
    spin.append(front, back);
    card.append(spin);
    return card;
}

/** transform der Flug-Ebene (Größe = base), damit sie auf rect sitzt.
 *  Alle Keyframes: identische Funktionsliste, sonst Matrix-Interpolation. */
function placeOn(base, rect, { lift = 0, zoom = 1, rx = 0 } = {}) {
    const tx = rect.left + rect.width / 2 - (base.left + base.width / 2);
    const ty = rect.top + rect.height / 2 - (base.top + base.height / 2) - lift;
    const sx = (rect.width / base.width) * zoom;
    const sy = (rect.height / base.height) * zoom;
    return `${PERSPECTIVE} translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0px) `
        + `scale3d(${sx.toFixed(4)}, ${sy.toFixed(4)}, ${sx.toFixed(4)}) rotateX(${rx.toFixed(2)}deg)`;
}

const mix = (a, b, t) => ({
    left: a.left + (b.left - a.left) * t, top: a.top + (b.top - a.top) * t,
    width: a.width + (b.width - a.width) * t, height: a.height + (b.height - a.height) * t,
});

let active = null;

/** Laufende Karte sofort entfernen (z. B. beim Blättern während des Fluges). */
export function cancelCardSpin() {
    if (active) { active.remove(); active = null; }
}

/**
 * Fliegt eine Karte von `from` nach `to` (DOMRect-artige Objekte, Viewport-Koordinaten).
 * Die Karte hat die GRÖSSERE der beiden Größen (bei open: to, bei close: from) und wird
 * nur verkleinert – so bleibt das Bild scharf.
 *
 * options: host (Element für die Karte, default body), duration (ms), mode ('open'|'close'),
 *          fadeOut (bool, Karte verglimmt am Ende), spins (Umdrehungen, default 1)
 * Rückgabe: Promise, erfüllt nach dem Aufsetzen (auch bei reduced motion sofort).
 */
export function flyCard(src, from, to, options = {}) {
    const { host = document.body, mode = 'open', fadeOut = false, spins = 1 } = options;
    const duration = options.duration ?? (mode === 'open' ? 1050 : 720);
    cancelCardSpin();
    if (reduceMotion || !from || !to || !to.width || !from.width) return Promise.resolve();

    const base = mode === 'open' ? to : from;
    const card = buildCard(src, base);
    host.append(card);
    active = card;

    const dir = (to.left + to.width / 2) >= (from.left + from.width / 2) ? 1 : -1;
    const lift = Math.min(mode === 'open' ? 90 : 70, window.innerHeight * 0.09);
    const mid = mode === 'open'
        ? placeOn(base, mix(from, to, 0.6), { lift, zoom: 0.94, rx: 6 })
        : placeOn(base, mix(from, to, 0.4), { lift, zoom: 0.96, rx: 5 });

    const path = card.animate([
        { transform: placeOn(base, from) },
        { transform: mid, offset: mode === 'open' ? 0.5 : 0.45 },
        { transform: placeOn(base, to) },
    ], { duration, easing: PATH_EASING, fill: 'forwards' });

    // Drehung auf EIGENER Ebene, genau zwei Keyframes → durchgehend, kein Stocken.
    card.querySelector('.cs-spin').animate([
        { transform: 'rotateY(0deg)' },
        { transform: `rotateY(${360 * spins * dir}deg)` },
    ], { duration, easing: SPIN_EASING, fill: 'forwards' });

    if (fadeOut) {
        card.animate([{ opacity: 1 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }], { duration, fill: 'forwards' });
    }

    return new Promise((resolve) => {
        let done = false;
        const end = () => {
            if (done) return;
            done = true;
            clearTimeout(safety);
            if (active === card) active = null;
            card.remove();
            resolve();
        };
        path.finished.then(end, end);
        // Sicherheitsnetz, großzügig – auf schwachen Rechnern laufen Timer spät.
        const safety = setTimeout(end, duration + 1000);
    });
}

/**
 * Text „entschlüsseln“: erscheint Zeichen für Zeichen mit flimmernder Spur.
 * Gibt eine cancel-Funktion zurück. Der echte Text steht am Ende per textContent da.
 */
export function decodeText(node, text, { delay = 0, maxChars = 700, glyphs = '░▒▓<>/\\|{}[]=+*#%&$01' } = {}) {
    if (reduceMotion || !text) { node.textContent = text; return () => {}; }
    const limit = Math.min(text.length, maxChars);
    const duration = Math.min(1000, 320 + limit * 1.25);
    const start = performance.now() + delay;
    const done = document.createTextNode('');
    const noise = document.createElement('span');
    noise.className = 'cs-decode';
    node.replaceChildren(done, noise);
    node.setAttribute('aria-busy', 'true');
    let raf = 0;
    const finish = () => { cancelAnimationFrame(raf); node.textContent = text; node.removeAttribute('aria-busy'); };
    const step = (now) => {
        const t = Math.min(1, Math.max(0, (now - start) / duration));
        if (t >= 1) { finish(); return; }
        const n = Math.floor((1 - (1 - t) ** 2) * limit);
        done.data = text.slice(0, n);
        let s = '';
        for (let i = 0; i < Math.min(26, limit - n); i += 1) {
            const c = text[n + i];
            s += (c === ' ' || c === '\n') ? c : glyphs[(Math.random() * glyphs.length) | 0];
        }
        noise.textContent = s;
        raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return finish;
}

/** Aufsetz-Effekte neu auslösen (Lichtring, Halo, Lichtstreifen): Klasse an den Lightbox-Root. */
export function playLanding(root, ms = 1500) {
    root.classList.remove('cs-landed');
    void root.offsetWidth;
    root.classList.add('cs-landed', 'cs-shown');
    clearTimeout(root._csLand);
    root._csLand = setTimeout(() => root.classList.remove('cs-landed'), ms);
}
