'use strict';
/**
 * demo.js – offline demo profile. Lets you try every feature (tabs, lightbox,
 * downloads, ZIP) without a Facebook login. Files live in public/demo.
 */
const fs = require('fs');
const path = require('path');

const DEMO_DIR = path.join(__dirname, '..', 'public', 'demo');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function data() {
    return JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'demo.json'), 'utf8'));
}

function isDemo(input) {
    return /^\s*demo\s*$/i.test(String(input || ''));
}

async function scan({ signal, emit }) {
    const d = data();
    emit('phase', { phase: 'images' });
    await sleep(500);
    emit('profile', d.profile);
    const tile = (x) => ({ id: x.id, href: 'https://www.facebook.com/', thumb: '/demo/' + x.thumb, alt: x.alt || '', views: x.views || '', type: x.type, demo: x });
    // one by one with small pauses, so the demo shows what a real scan feels like
    for (let i = 0; i < d.images.length && !signal.aborted; i++) {
        await sleep(260 + Math.random() * 220);
        emit('items', [tile(d.images[i])]);
    }
    if (signal.aborted) return;
    await sleep(500);
    emit('phase', { phase: 'reels' });
    for (let i = 0; i < d.reels.length && !signal.aborted; i++) {
        await sleep(320 + Math.random() * 260);
        emit('items', [tile(d.reels[i])]);
    }
    await sleep(400);
}

async function resolve(item) {
    await sleep(120 + Math.random() * 260);
    const x = item.demo;
    return {
        url: 'demo:' + x.file,
        file: path.join(DEMO_DIR, x.file),
        width: x.width, height: x.height,
        time: x.time || 0, caption: x.caption || '', alt: x.alt || '',
        quality: x.quality || '',
    };
}

module.exports = { isDemo, scan, resolve, DEMO_DIR };
