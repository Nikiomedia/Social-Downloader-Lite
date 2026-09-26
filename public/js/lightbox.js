/**
 * lightbox.js – Card-Spin-Lightbox for images and reels.
 * The tile's thumbnail flies out as a card, spins 360° once and lands exactly
 * on the frame (card-spin.js). Full resolution / video is swapped in only
 * after landing.
 */
import { flyCard, fitRect, centerRect, decodeText, playLanding, paintSoft, cancelCardSpin, reduceMotion } from './card-spin.js';
import { t, fmtDate, fmtNumber } from './i18n.js';

const $ = (id) => document.getElementById(id);

export function createLightbox({ getList, getTile, mediaUrl, onDownload, aurora }) {
    const lb = $('lightbox');
    const stage = $('lbStage');
    const frame = $('lbFrame');
    const img = $('lbImg');
    const video = $('lbVideo');
    const aura = $('lbAura');
    const vui = $('lbVideoUi');
    const loading = $('lbLoading');
    const el = {
        counter: $('lbCounter'), type: $('lbType'), title: $('lbTitle'), caption: $('lbCaption'),
        facts: $('lbFacts'), download: $('lbDownload'), fb: $('lbFb'), copy: $('lbCopy'),
        prev: $('lbPrev'), next: $('lbNext'), close: $('lbClose'), first: $('lbFirst'), last: $('lbLast'), edgeTag: $('lbEdgeTag'),
        play: $('lbPlay'), mute: $('lbMute'), progress: $('lbProgress'), time: $('lbTime'),
    };

    let list = [];
    let index = -1;
    let current = null;
    let currentTile = null;
    let isOpen = false;
    let bgTimer = 0;
    let loadTimer = 0;
    let stopDecode = () => {};
    let lastFocus = null;
    let flightSrc = '';

    /* ------------------------------------------------ sound: mute + volume
       Both are remembered in the browser (also after reload).
       "Sound off" stays until the sound is turned on again (button, M, or moving the slider). */
    const MUTE_KEY = 'av.muted';
    const VOL_KEY = 'av.volume';
    const volWrap = $('lbVol');
    const volInput = $('lbVolume');
    const volTip = $('lbVolTip');
    // iPhone/iPad ignore video.volume (hardware buttons only) → hide the slider there
    const canSetVolume = (() => { try { const v = document.createElement('video'); v.volume = 0.5; return Math.abs(v.volume - 0.5) < 0.01; } catch { return false; } })();
    volWrap.classList.toggle('no-volume', !canSetVolume);

    let userMuted = false;
    let userVolume = 1;
    try {
        userMuted = localStorage.getItem(MUTE_KEY) === '1';
        const v = parseFloat(localStorage.getItem(VOL_KEY));
        if (v > 0 && v <= 1) userVolume = v;
    } catch { /* storage blocked */ }

    function setUserMuted(m) {
        userMuted = m;
        try { m ? localStorage.setItem(MUTE_KEY, '1') : localStorage.removeItem(MUTE_KEY); } catch { /* ignore */ }
    }
    function saveVolume(v) {
        userVolume = v;
        try { localStorage.setItem(VOL_KEY, v.toFixed(2)); } catch { /* ignore */ }
    }
    const silent = () => video.muted || video.volume < 0.005;

    function toggleMute() {
        if (silent()) {
            video.muted = false;
            if (video.volume < 0.005) { video.volume = userVolume; }
            setUserMuted(false);
        } else {
            video.muted = true;
            setUserMuted(true);
        }
        flashVolume();
    }

    // volume the interaction started with: dragging down to 0 means "mute", and turning the
    // sound on again later comes back at that level instead of at the last 1 % on the way down
    let grabVol = null, grabTimer = 0;
    function grab(sticky) {
        if (grabVol === null) grabVol = silent() ? userVolume : video.volume;
        clearTimeout(grabTimer);
        if (!sticky) grabTimer = setTimeout(() => { grabVol = null; }, 1200);
    }
    function setVolume(v) {
        v = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
        if (v === 0) {
            const back = grabVol && grabVol > 0.04 ? grabVol : (userVolume > 0.04 ? userVolume : 0.6);
            video.volume = back;
            saveVolume(back);
            video.muted = true;
            setUserMuted(true);
        } else {
            video.volume = v;
            saveVolume(v);
            if (video.muted) { video.muted = false; setUserMuted(false); }
        }
        flashVolume();
    }
    function nudgeVolume(d) {
        grab(false);
        if (silent()) {                 // louder while muted = sound back on at the remembered level
            if (d > 0) setVolume(userVolume); else flashVolume();
            return;
        }
        setVolume(video.volume + d);
    }

    let volTimer = 0;
    function flashVolume() {           // show the slider + percentage for a moment (also when the controls are faded out)
        volWrap.classList.add('is-changing');
        vui.classList.add('is-active');
        clearTimeout(volTimer);
        volTimer = setTimeout(() => { volWrap.classList.remove('is-changing'); vui.classList.remove('is-active'); }, 1100);
    }

    function syncVolumeUi() {
        const shown = silent() ? 0 : video.volume;
        const pct = Math.round(shown * 100);
        volInput.value = String(pct);
        volInput.style.setProperty('--vol', String(shown));
        volTip.style.setProperty('--vol', String(shown));
        volTip.textContent = t('volPct', { n: pct });
        volInput.setAttribute('aria-valuetext', t('volPct', { n: pct }));
        volWrap.classList.toggle('is-max', pct >= 100);
    }

    let dragPointer = '';
    volInput.addEventListener('pointerdown', (e) => { e.stopPropagation(); dragPointer = e.pointerType; grab(true); volWrap.classList.add('is-dragging'); });
    window.addEventListener('pointerup', () => {
        if (!volWrap.classList.contains('is-dragging')) return;
        volWrap.classList.remove('is-dragging');
        grab(false);
        // after a mouse drag, give the arrow keys back to the lightbox (← → = previous / next)
        if (dragPointer === 'mouse') volInput.blur();
    });
    // keyboard on the focused slider: 5 % steps instead of the native 1 %
    const SLIDER_KEYS = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05, PageUp: 0.1, PageDown: -0.1 };
    volInput.addEventListener('keydown', (e) => {
        if (SLIDER_KEYS[e.key] !== undefined) { e.preventDefault(); nudgeVolume(SLIDER_KEYS[e.key]); }
        else if (e.key === 'Home') { e.preventDefault(); grab(false); setVolume(0); }
        else if (e.key === 'End') { e.preventDefault(); grab(false); setVolume(1); }
    });
    volInput.addEventListener('input', () => setVolume(Number(volInput.value) / 100));
    // small frames (portrait reels, phones): progress bar gets its own row above the buttons
    if ('ResizeObserver' in window) new ResizeObserver(([en]) => vui.classList.toggle('is-narrow', en.contentRect.width < 360)).observe(vui);
    volInput.addEventListener('click', (e) => e.stopPropagation());
    volWrap.addEventListener('wheel', (e) => {       // scroll over the speaker = louder / quieter
        e.preventDefault();
        nudgeVolume(e.deltaY < 0 ? 0.05 : -0.05);
    }, { passive: false });

    const thumbOf = (tile) => tile?.querySelector('.tile-open img') || null;

    function sizeFrame(item) {
        const to = fitRect(stage, item.width || 1080, item.height || 1080);
        frame.style.width = `${to.width}px`;
        frame.style.height = `${to.height}px`;
        return to;
    }

    function stopVideo() {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.hidden = true;
        vui.hidden = true;
    }

    /* ------------------------------------------------ navigation (no wrap-around) */
    function updateNav() {
        const pad = (n) => String(n).padStart(2, '0');
        el.counter.innerHTML = `<b>${pad(index + 1)}</b> / ${pad(list.length)}`;
        const atStart = index <= 0, atEnd = index >= list.length - 1;
        // dimmed via aria-disabled instead of the disabled attribute: a click on the dimmed button
        // still lands on it (shows "end of list") and never falls through to the backdrop (= close)
        for (const [b, off] of [[el.prev, atStart], [el.first, atStart], [el.next, atEnd], [el.last, atEnd]]) {
            b.setAttribute('aria-disabled', String(off));
            b.classList.toggle('is-off', off);
        }
        el.prev.title = `${t('lbPrev')} (←)`;
        el.next.title = `${t('lbNext')} (→)`;
        el.first.title = `${t('lbFirst')} (${t('keyHome')})`;
        el.last.title = `${t('lbLast')} (${t('keyEnd')})`;
    }

    // the list can grow while the lightbox is open (scan still running, HD links arriving)
    function syncList() {
        if (!isOpen || !current) return;
        const fresh = getList();
        const i = fresh.findIndex((x) => x.id === current.id);
        if (i >= 0) { list = fresh; index = i; }
        updateNav();
    }

    let edgeTimer = 0;
    function bump(dir) {               // already at the start / end: short rubber-band, no wrap-around
        el.edgeTag.textContent = dir < 0 ? t('lbAtStart') : t('lbAtEnd');
        el.edgeTag.classList.add('is-on');
        el.counter.classList.remove('is-bump'); void el.counter.offsetWidth;
        el.counter.classList.add('is-bump');
        clearTimeout(edgeTimer);
        edgeTimer = setTimeout(() => { el.edgeTag.classList.remove('is-on'); el.counter.classList.remove('is-bump'); }, 1300);
        if (!reduceMotion && frame.animate) {
            frame.animate({ translate: ['0 0', `${dir * 22}px 0`, `${dir * -7}px 0`, `${dir * 2}px 0`, '0 0'] },
                { duration: 480, easing: 'cubic-bezier(.3, .7, .4, 1)' });
        }
    }

    function fillPanel(item, animateCaption = true) {
        updateNav();
        const reel = item.type === 'reel';
        el.type.textContent = reel ? t('lbReel') : t('lbImage');
        el.type.classList.toggle('reel', reel);
        const title = reel ? (item.views ? `${t('lbReel')} · ${item.views}` : t('lbReel')) : (item.alt || t('lbUntitled'));
        el.title.textContent = title;
        const cap = item.caption || '';
        stopDecode();
        el.caption.classList.toggle('is-empty', !cap);
        if (!cap) el.caption.textContent = t('lbNoCaption');
        else if (animateCaption) stopDecode = decodeText(el.caption, cap, { delay: 520 });
        else el.caption.textContent = cap;
        const facts = [
            [t('lbSize'), item.width && item.height ? `${item.width} × ${item.height}` : t('unknown')],
            [t('lbDate'), item.time ? fmtDate(item.time) : '—'],
            reel ? [t('lbViews'), item.views || '—'] : [t('lbQuality'), item.status === 'ready' ? 'Original' : t('pending')],
            reel ? [t('lbQuality'), item.quality || (item.status === 'ready' ? 'HD' : t('pending'))] : [t('lbId'), item.fbid],
        ];
        if (reel) facts.push([t('lbId'), item.fbid]);
        el.facts.replaceChildren(...facts.map(([k, v]) => {
            const d = document.createElement('div');
            const dt = document.createElement('dt'); dt.textContent = k;
            const dd = document.createElement('dd'); dd.textContent = v;
            d.append(dt, dd);
            return d;
        }));
        el.fb.href = item.href || 'https://www.facebook.com/';
        el.download.dataset.id = item.id;
        el.download.classList.remove('is-done');
    }

    async function swapFull(item, startAt = 0) {
        const src = mediaUrl(item);
        clearTimeout(loadTimer);
        loadTimer = setTimeout(() => { if (current === item) loading.hidden = false; }, 260);
        if (item.type === 'reel') {
            video.poster = item.thumb;
            video.src = src;
            if (startAt > 0.2) {       // continue where the hover preview in the tile was
                video.addEventListener('loadedmetadata', () => {
                    if (current === item && video.duration) video.currentTime = Math.min(startAt, video.duration - 0.1);
                }, { once: true });
            }
            video.volume = userVolume;
            video.muted = userMuted;
            video.hidden = false;
            vui.hidden = false;
            const done = () => { clearTimeout(loadTimer); loading.hidden = true; };
            video.addEventListener('loadeddata', done, { once: true });
            video.addEventListener('error', () => {      // codec/network problem → keep the poster image
                done();
                if (current === item) { video.hidden = true; vui.hidden = true; }
            }, { once: true });
            try { await video.play(); } catch {
                video.muted = true;                        // browser blocks autoplay with sound – not saved as a choice
                try { await video.play(); } catch { /* user can press play */ }
            }
            syncVideoUi();
            return;
        }
        const pre = new Image();
        pre.src = src;
        try { await pre.decode(); } catch { /* keep thumbnail */ }
        clearTimeout(loadTimer);
        if (current !== item) return;
        loading.hidden = true;
        if (pre.naturalWidth) img.src = src;
    }

    function syncVideoUi() {
        const paused = video.paused;
        el.play.innerHTML = `<svg><use href="#${paused ? 'i-play' : 'i-pause'}"/></svg>`;
        el.play.setAttribute('aria-label', paused ? t('play') : t('pause'));
        const off = silent();
        const icon = off ? 'i-mute' : video.volume < 0.5 ? 'i-volume-low' : 'i-volume';
        if (el.mute.dataset.icon !== icon) {       // don't rebuild the icon on every slider step
            el.mute.dataset.icon = icon;
            el.mute.innerHTML = `<svg><use href="#${icon}"/></svg>`;
        }
        el.mute.setAttribute('aria-label', off ? t('unmute') : t('mute'));
        el.mute.title = `${off ? t('unmute') : t('mute')} (M)`;
        el.mute.classList.toggle('is-muted', off);
        vui.classList.toggle('is-paused', paused);
        syncVolumeUi();
    }

    const fmtTime = (sec) => { const s = Math.max(0, Math.floor(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    video.addEventListener('timeupdate', () => {
        const d = video.duration || 0;
        vui.style.setProperty('--vp', d ? String(video.currentTime / d) : '0');
        el.time.textContent = fmtTime(video.currentTime);
    });
    video.addEventListener('play', syncVideoUi);
    video.addEventListener('pause', syncVideoUi);
    video.addEventListener('volumechange', syncVideoUi);
    el.play.addEventListener('click', (e) => { e.stopPropagation(); video.paused ? video.play() : video.pause(); });
    el.mute.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
    /* progress bar: click to jump, or hold and drag to scrub; the bubble shows the time under the pointer */
    const scrubTip = $('lbScrubTip');
    let scrubbing = false;
    const fracAt = (clientX) => {
        const r = el.progress.getBoundingClientRect();
        return r.width ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
    };
    function hoverAt(clientX) {
        const f = fracAt(clientX);
        el.progress.style.setProperty('--hp', String(f));
        scrubTip.textContent = fmtTime(f * (video.duration || 0));
        return f;
    }
    function seekTo(f) {
        if (!video.duration) return;
        video.currentTime = Math.min(video.duration - 0.05, f * video.duration);
        vui.style.setProperty('--vp', String(f));
        el.time.textContent = fmtTime(video.currentTime);
    }
    el.progress.addEventListener('pointerdown', (e) => {
        e.stopPropagation();                        // no swipe to the next reel while scrubbing
        if (!video.duration || e.button > 0) return;
        scrubbing = true;
        el.progress.setPointerCapture?.(e.pointerId);
        el.progress.classList.add('is-scrubbing');
        seekTo(hoverAt(e.clientX));
    });
    el.progress.addEventListener('pointermove', (e) => {
        const f = hoverAt(e.clientX);
        if (scrubbing) seekTo(f);
    });
    const endScrub = (e) => {
        if (!scrubbing) return;
        scrubbing = false;
        el.progress.releasePointerCapture?.(e.pointerId);
        el.progress.classList.remove('is-scrubbing');
    };
    el.progress.addEventListener('pointerup', endScrub);
    el.progress.addEventListener('pointercancel', endScrub);
    el.progress.addEventListener('click', (e) => e.stopPropagation());
    video.addEventListener('click', () => { video.paused ? video.play() : video.pause(); });

    function hideSource(tile) { thumbOf(tile)?.classList.add('cs-source-hidden'); }
    function showSource(tile) { thumbOf(tile)?.classList.remove('cs-source-hidden'); }

    async function open(item, tileEl, { startAt = 0 } = {}) {
        cancelCardSpin();
        if (isOpen && current) { showSource(currentTile); }
        list = getList();
        index = Math.max(0, list.findIndex((x) => x.id === item.id));
        current = item;
        currentTile = tileEl || getTile(item.id);
        lastFocus = document.activeElement;
        isOpen = true;

        lb.hidden = false;
        lb.classList.remove('is-closing', 'cs-shown');
        document.documentElement.classList.add('lb-lock');
        requestAnimationFrame(() => lb.classList.add('is-open'));

        stopVideo();
        loading.hidden = true;
        fillPanel(item);
        const to = sizeFrame(item);
        const thumb = thumbOf(currentTile);
        const cardSrc = (thumb && thumb.complete && thumb.naturalWidth && thumb.currentSrc) || item.thumb;
        flightSrc = cardSrc;
        img.src = cardSrc;
        paintSoft(aura, item.thumb);

        const tr = thumb ? thumb.getBoundingClientRect() : null;
        const from = tr && tr.width ? tr : centerRect(to);
        frame.style.visibility = 'hidden';
        hideSource(currentTile);
        clearTimeout(bgTimer);
        bgTimer = setTimeout(() => aurora.setPaused(true), 340);   // veil covers → pause the WebGL sky
        el.close.focus({ preventScroll: true });

        await flyCard(cardSrc, from, to, { host: lb, mode: 'open' });
        if (current !== item || !isOpen) return;
        frame.style.visibility = '';
        playLanding(lb);
        swapFull(item, startAt);
    }

    async function close() {
        if (!isOpen) return;
        isOpen = false;
        cancelCardSpin();
        stopDecode();
        clearTimeout(bgTimer);
        clearTimeout(loadTimer);
        aurora.setPaused(false);
        loading.hidden = true;
        const item = current;
        const tile = currentTile;
        const from = frame.getBoundingClientRect();
        const thumb = thumbOf(tile);
        const r = thumb?.getBoundingClientRect();
        const visible = r && r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
        stopVideo();
        frame.style.visibility = 'hidden';
        lb.classList.remove('cs-shown', 'is-open', 'cs-landed');
        lb.classList.add('is-closing');
        const backSrc = (thumb && thumb.complete && thumb.naturalWidth && thumb.currentSrc) || flightSrc || item.thumb;
        await flyCard(backSrc, from, visible ? r : centerRect(from, 0.12), { host: document.body, mode: 'close', fadeOut: !visible });
        if (isOpen) return;   // re-opened meanwhile
        lb.hidden = true;
        lb.classList.remove('is-closing');
        frame.style.visibility = '';
        showSource(tile);
        document.documentElement.classList.remove('lb-lock');
        const focusTarget = tile?.querySelector('.tile-open') || lastFocus;
        focusTarget?.focus?.({ preventScroll: true });
        current = null;
    }

    function step(dir) {
        if (!isOpen) return;
        syncList();
        const to = index + dir;
        if (to < 0 || to >= list.length) { bump(dir); return; }
        goTo(to, dir);
    }

    function jump(where) {             // 'first' | 'last'
        if (!isOpen) return;
        syncList();
        const to = where === 'first' ? 0 : list.length - 1;
        if (to === index) { bump(where === 'first' ? -1 : 1); return; }
        goTo(to, to > index ? 1 : -1);
    }

    function goTo(to, dir) {
        cancelCardSpin();
        stopVideo();
        showSource(currentTile);
        index = to;
        const item = list[index];
        current = item;
        currentTile = getTile(item.id);
        if (currentTile) {
            currentTile.scrollIntoView({ block: 'center', behavior: 'instant' });
            hideSource(currentTile);
        }
        fillPanel(item);
        sizeFrame(item);
        const t2 = thumbOf(currentTile);
        flightSrc = (t2 && t2.complete && t2.naturalWidth && t2.currentSrc) || item.thumb;
        img.src = flightSrc;
        paintSoft(aura, item.thumb);
        frame.style.visibility = '';
        lb.classList.add('cs-shown');
        lb.style.setProperty('--cs-dir', String(dir));
        lb.classList.remove('cs-stepping'); void lb.offsetWidth;
        lb.classList.add('cs-stepping');
        setTimeout(() => lb.classList.remove('cs-stepping'), 620);
        swapFull(item);
    }

    /* item data changed (e.g. HD link resolved) → refresh panel without re-animating */
    function refresh(item) {
        if (!isOpen || !current || current.id !== item.id) return;
        current = item;
        list[index] = item;
        fillPanel(item, false);
    }

    // controls
    el.close.addEventListener('click', close);
    $('lbVeil').addEventListener('click', close);
    el.prev.addEventListener('click', () => step(-1));
    el.next.addEventListener('click', () => step(1));
    el.first.addEventListener('click', () => jump('first'));
    el.last.addEventListener('click', () => jump('last'));
    document.addEventListener('av:items', syncList);
    el.download.addEventListener('click', () => current && onDownload(current, el.download));
    el.copy.addEventListener('click', async () => {
        if (!current) return;
        const value = current.fbid;   // copy from data, never from the animated text
        try { await navigator.clipboard.writeText(value); } catch { /* ignore */ }
        const label = el.copy.querySelector('span');
        label.textContent = t('copied');
        setTimeout(() => { label.textContent = t('lbCopyId'); }, 1400);
    });
    stage.addEventListener('click', (e) => { if (e.target === stage) close(); });

    window.addEventListener('keydown', (e) => {
        if (!isOpen) return;
        const onSlider = e.target === volInput;       // arrows on the focused slider change the volume natively
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (onSlider && /^Arrow|^Page|^Home$|^End$/.test(e.key)) { /* handled by the slider itself */ }
        else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && current?.type === 'reel' && canSetVolume) { e.preventDefault(); nudgeVolume(e.key === 'ArrowUp' ? 0.05 : -0.05); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        else if (e.key === 'Home') { e.preventDefault(); jump('first'); }
        else if (e.key === 'End') { e.preventDefault(); jump('last'); }
        else if (e.key === ' ' && current?.type === 'reel' && e.target.tagName !== 'BUTTON') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
        else if (e.key.toLowerCase() === 'm' && current?.type === 'reel' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); toggleMute(); }
        else if (e.key === 'Tab') {       // focus trap
            const f = [...lb.querySelectorAll('button:not([hidden]), a[href], input')].filter((x) => x.offsetParent !== null);
            if (!f.length) return;
            const i = f.indexOf(document.activeElement);
            if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
            else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
    });

    // tilt + glare
    if (!reduceMotion) {
        stage.addEventListener('pointermove', (e) => {
            if (e.pointerType !== 'mouse') return;
            const r = frame.getBoundingClientRect();
            const nx = (e.clientX - r.left) / r.width - 0.5;
            const ny = (e.clientY - r.top) / r.height - 0.5;
            frame.style.setProperty('--ty', `${(nx * 8).toFixed(2)}deg`);
            frame.style.setProperty('--tx', `${(-ny * 8).toFixed(2)}deg`);
            frame.style.setProperty('--mx', `${((nx + 0.5) * 100).toFixed(1)}%`);
            frame.style.setProperty('--my', `${((ny + 0.5) * 100).toFixed(1)}%`);
        });
        stage.addEventListener('pointerleave', () => { frame.style.setProperty('--tx', '0deg'); frame.style.setProperty('--ty', '0deg'); });
    }

    // swipe
    let sx = 0, sy = 0, swiping = false;
    stage.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { swiping = true; sx = e.clientX; sy = e.clientY; } });
    stage.addEventListener('pointerup', (e) => {
        if (!swiping) return;
        swiping = false;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 50 && Math.abs(dx) > 1.4 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
    });

    window.addEventListener('resize', () => { if (isOpen && current) sizeFrame(current); });
    document.addEventListener('av:lang', () => { syncVolumeUi(); if (isOpen && current) fillPanel(current, false); });
    syncVolumeUi();

    return { open, close, step, refresh, get isOpen() { return isOpen; }, get current() { return current; } };
}
