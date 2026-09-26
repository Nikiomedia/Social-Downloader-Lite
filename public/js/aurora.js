/**
 * aurora.js – animated WebGL sky: aurora curtains, twinkling stars, a glow
 * that follows the pointer, click ripples and a hidden "hyperdrive" mode.
 * Rendered at half resolution (the aurora is soft anyway) → cheap on the GPU.
 */

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uRipple;
uniform float uWarp;
uniform float uScroll;
uniform float uGlow;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
}

vec3 band(vec2 p, float fi, vec3 c, vec3 c2, float t) {
    float x = p.x * (0.85 + fi * 0.22) + fi * 3.1;
    float center = 0.74 - fi * 0.13
        + 0.065 * sin(x * 1.6 + t * 1.7 + fi * 1.3)
        + 0.12 * (fbm(vec2(x * 0.7 + t * 0.6, fi * 4.0 + t * 0.2)) - 0.5)
        + uScroll * 0.18;
    float d = p.y - center;
    float above = exp(-max(d, 0.0) * max(d, 0.0) / (0.018 + fi * 0.006));
    float below = exp(-min(d, 0.0) * min(d, 0.0) / (0.0016 + fi * 0.0008));
    float curtain = above * below;
    float rays = 0.45 + 0.55 * noise(vec2(x * 13.0, t * 2.2 + fi * 10.0));
    rays *= 0.65 + 0.35 * noise(vec2(x * 42.0 + t * 0.8, fi));
    vec3 col = mix(c, c2, 0.5 + 0.5 * sin(x * 0.8 + t * 0.9 + fi));
    float edge = exp(-d * d / 0.0004) * 0.35;   // bright lower rim
    return col * (curtain * rays + edge * rays) ;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    vec2 p = vec2(uv.x * aspect, uv.y);
    float t = uTime * (0.055 + uWarp * 0.45);

    // click ripple
    vec2 rp = vec2(uRipple.x * aspect, uRipple.y);
    float rt = max(uTime - uRipple.z, 0.0);
    float rd = length(p - rp);
    float ring = uRipple.w * exp(-rt * 1.4) * smoothstep(0.07, 0.0, abs(rd - rt * 0.6));
    p += normalize(p - rp + 1e-4) * ring * 0.035;

    // pointer bends the curtains a little
    vec2 m = vec2(uMouse.x * aspect, uMouse.y);
    float md = length(p - m);
    p.y += 0.035 * exp(-md * md * 5.0) * uGlow;

    vec3 col = vec3(0.010, 0.012, 0.026);
    col += vec3(0.016, 0.022, 0.055) * smoothstep(0.0, 1.0, uv.y);

    col += band(p, 0.0, uC1, uC2, t) * 0.74;
    col += band(p, 1.0, uC2, uC3, t) * 0.52;
    col += band(p, 2.0, uC3, uC1, t) * 0.34;

    // pointer glow + ripple light
    col += mix(uC1, uC2, 0.5) * 0.085 * exp(-md * md * 9.0) * uGlow;
    col += mix(uC1, uC3, 0.4) * ring * 0.6;

    // stars (twinkle, fewer near the horizon glow)
    vec2 g = gl_FragCoord.xy / 13.0;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash(id);
    vec2 off = (vec2(hash(id + 1.3), hash(id + 2.7)) - 0.5) * 0.7;
    float tw = 0.55 + 0.45 * sin(uTime * (0.8 + h * 3.0) + h * 40.0);
    float star = step(0.935, h) * smoothstep(0.16, 0.0, length(f - off)) * tw;
    col += vec3(0.78, 0.88, 1.0) * star * (0.35 + 0.65 * uv.y);

    // hyperdrive streaks
    if (uWarp > 0.001) {
        vec2 c = uv - vec2(0.5, 0.55);
        c.x *= aspect;
        float a = atan(c.y, c.x);
        float r = length(c);
        float lane = hash(vec2(floor(a * 90.0), 3.0));
        float streak = step(0.8, lane) * smoothstep(0.0, 0.25, fract(r * 1.4 - uTime * (1.5 + lane * 2.0)));
        streak *= smoothstep(0.05, 0.6, r) * (1.0 - smoothstep(0.85, 1.0, fract(r * 1.4 - uTime * (1.5 + lane * 2.0))));
        col += mix(uC1, uC3, lane) * streak * uWarp * 0.9;
    }

    // vignette + grain
    vec2 v = uv - vec2(0.5, 0.58);
    col *= 1.0 - 0.6 * dot(v, v) * 1.6;
    col += (hash(gl_FragCoord.xy + fract(uTime * 7.0) * 91.0) - 0.5) * 0.018;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

export const PALETTES = {
    aurora: { name: 'Aurora', c: [[0.27, 0.94, 0.88], [0.54, 0.42, 1.0], [1.0, 0.31, 0.71]] },
    borealis: { name: 'Borealis', c: [[0.30, 1.0, 0.55], [0.20, 0.75, 0.95], [0.62, 0.35, 1.0]] },
    solar: { name: 'Solar Flare', c: [[1.0, 0.72, 0.32], [1.0, 0.36, 0.42], [0.62, 0.32, 1.0]] },
    abyss: { name: 'Abyss', c: [[0.18, 0.62, 1.0], [0.20, 0.95, 0.85], [0.35, 0.30, 0.95]] },
    silver: { name: 'Moonlight', c: [[0.82, 0.88, 1.0], [0.52, 0.58, 0.78], [0.70, 0.62, 0.92]] },
};

export function createAurora(canvas) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    const api = { ok: false, setPaused() {}, ripple() {}, hyper() {}, setPalette() {}, palette: 'aurora' };
    if (!gl) { canvas.remove(); return api; }

    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    };
    let prog;
    try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
        console.warn('[aurora] shader failed, using CSS fallback', e);
        canvas.remove();
        return api;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = {};
    ['uRes', 'uTime', 'uMouse', 'uC1', 'uC2', 'uC3', 'uRipple', 'uWarp', 'uScroll', 'uGlow'].forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });

    // Adaptive quality: weak GPUs get a smaller buffer, very weak ones a slow "still" mode.
    const SCALES = [0.5, 0.36, 0.25];
    let level = 0, lowPower = false, lastDraw = 0;
    let scale = SCALES[0];
    const resize = () => {
        const w = Math.max(2, Math.round(window.innerWidth * scale));
        const h = Math.max(2, Math.round(window.innerHeight * scale));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w; canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
        if (reduce) draw(performance.now());
    };

    let colors = PALETTES.aurora.c.map((c) => c.slice());
    let target = PALETTES.aurora.c;
    const mouse = { x: 0.5, y: 0.7, tx: 0.5, ty: 0.7, glow: 0, tglow: 0 };
    let ripple = [0.5, 0.5, -100, 0];
    let warp = 0, warpTarget = 0, warpUntil = 0;
    let paused = false;
    let raf = 0;
    const t0 = performance.now();

    function draw(now) {
        const time = (now - t0) / 1000;
        mouse.x += (mouse.tx - mouse.x) * 0.06;
        mouse.y += (mouse.ty - mouse.y) * 0.06;
        mouse.glow += (mouse.tglow - mouse.glow) * 0.05;
        if (now > warpUntil) warpTarget = 0;
        warp += (warpTarget - warp) * 0.04;
        for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) colors[i][k] += (target[i][k] - colors[i][k]) * 0.03;
        const scroll = Math.min(1, window.scrollY / 1600);
        gl.uniform2f(U.uRes, canvas.width, canvas.height);
        gl.uniform1f(U.uTime, time);
        gl.uniform2f(U.uMouse, mouse.x, mouse.y);
        gl.uniform3fv(U.uC1, colors[0]); gl.uniform3fv(U.uC2, colors[1]); gl.uniform3fv(U.uC3, colors[2]);
        gl.uniform4f(U.uRipple, ripple[0], ripple[1], ripple[2], ripple[3]);
        gl.uniform1f(U.uWarp, warp);
        gl.uniform1f(U.uScroll, scroll);
        gl.uniform1f(U.uGlow, mouse.glow);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    let last = 0, acc = 0, frames = 0, bad = 0;
    const loop = (now) => {
        raf = 0;
        if (paused || document.hidden) { last = 0; return; }
        if (last && now - t0 > 2500) {
            const dt = now - last;
            if (dt < 400) { acc += dt; frames++; }
            if (acc >= 1000 && frames >= 8) {
                const avg = acc / frames;
                acc = 0; frames = 0;
                bad = avg > 30 ? bad + 1 : 0;
                if (bad >= 2) {
                    bad = 0;
                    level++;
                    if (level < SCALES.length) { scale = SCALES[level]; resize(); } else lowPower = true;
                }
            }
        }
        last = now;
        if (!lowPower || now - lastDraw > 240) { draw(now); lastDraw = now; }
        raf = requestAnimationFrame(loop);
    };
    const start = () => { if (!raf && !paused && !reduce) raf = requestAnimationFrame(loop); };

    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', start);
    window.addEventListener('pointermove', (e) => {
        mouse.tx = e.clientX / window.innerWidth;
        mouse.ty = 1 - e.clientY / window.innerHeight;
        mouse.tglow = 1;
    }, { passive: true });
    document.addEventListener('pointerleave', () => { mouse.tglow = 0; });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; });

    resize();
    if (reduce) draw(performance.now()); else start();

    Object.assign(api, {
        ok: true,
        setPaused(v) { paused = !!v; if (!paused) start(); },
        ripple(x, y, strength = 1) {
            ripple = [x / window.innerWidth, 1 - y / window.innerHeight, (performance.now() - t0) / 1000, strength];
            if (reduce) draw(performance.now());
        },
        hyper(ms = 4200) { warpTarget = 1; warpUntil = performance.now() + ms; },
        setPalette(name) {
            const p = PALETTES[name];
            if (!p) return;
            api.palette = name;
            target = p.c;
            if (reduce) { colors = p.c.map((c) => c.slice()); draw(performance.now()); }
        },
    });
    return api;
}
