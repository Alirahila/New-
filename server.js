'use strict';
/*
  My Doas App server (no npm dependencies, Node 18+).
  Payment: a single configurable checkout LINK, not an API integration.
  "Pay by card" just opens CHECKOUT_URL — a hosted payment page you create
  yourself with whichever provider you sign up with (Stripe Payment Links,
  PayPal.me, Razorpay Payment Pages, Gumroad, etc. — anything that gives you
  a plain URL from its dashboard, no code and no API key required here).

  Because there's no API key for any provider, this server has no way to
  ask anyone "did this payment actually succeed?" — a plain link gives no
  callback. So after paying, the buyer taps "I've paid — Unlock" here and
  gets in immediately (self-reported, not verified). Every tap is logged
  so you can reconcile against your payment provider's dashboard afterwards
  — see /admin.

  Environment variables (set these in Render > Environment):
    CHECKOUT_URL   the payment link you created with your provider of choice
    PRICE_LABEL    optional, default "$16/year" — just display text, shown on the button
    TOKEN_SECRET   any long random string; signs the unlock tokens (recommended)
    PLAN_DAYS      optional, default 365
    ADMIN_SECRET   any long passphrase, protects /admin (the claims log)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PLAN_DAYS = Number(process.env.PLAN_DAYS || 365);
const TOKEN_SECRET = (process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex'));
const CHECKOUT_URL = (process.env.CHECKOUT_URL || '').trim();
const PRICE_LABEL = (process.env.PRICE_LABEL || '$16/year').trim();
const ADMIN_SECRET = (process.env.ADMIN_SECRET || '').trim();

const PUBLIC_DIR = path.join(__dirname, 'public');
const DOAS_FILE = path.join(__dirname, 'data', 'doas.json');
const CLAIMS_FILE = path.join(__dirname, 'data', 'claims.json');

/* ---------- tokens: stateless, signed ---------- */
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function readToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(parts[0]).digest();
  let given;
  try { given = Buffer.from(parts[1], 'base64url'); } catch (e) { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let p;
  try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return p;
}

/* ---------- helpers ---------- */
const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function bearer(req) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function adminAuthed(req) {
  if (!ADMIN_SECRET) return false;
  const given = Buffer.from(bearer(req));
  const expected = Buffer.from(ADMIN_SECRET);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
function loadClaims() {
  try { return JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8')); } catch (e) { return []; }
}
function addClaim(entry) {
  const arr = loadClaims(); arr.push(entry);
  const trimmed = arr.slice(-500);
  try { fs.mkdirSync(path.dirname(CLAIMS_FILE), { recursive: true }); fs.writeFileSync(CLAIMS_FILE, JSON.stringify(trimmed)); } catch (e) { console.error('claims write failed', e.message); }
}

async function handleApi(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { checkoutReady: !!CHECKOUT_URL, checkoutUrl: CHECKOUT_URL, priceLabel: PRICE_LABEL });
  }

  if (req.method === 'POST' && url.pathname === '/api/claim') {
    if (!CHECKOUT_URL) return send(res, 503, { error: 'Payments are not set up yet.' });
    if (limited(ip, 8)) return send(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
    let body;
    try { body = await readBody(req, 2048); } catch (e) { return send(res, 400, { error: 'Invalid request.' }); }
    const note = String(body.note || '').slice(0, 200);
    const exp = Date.now() + PLAN_DAYS * 86400000;
    const token = signToken({ src: 'link', exp });
    addClaim({ ts: Date.now(), note, ip: ip ? ip.replace(/\.\d+$/, '.xxx') : '' });
    console.log('[payment] self-reported claim, note:', note || '(none)');
    return send(res, 200, { token, exp });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/claims') {
    if (!ADMIN_SECRET) return send(res, 503, { error: 'Admin is not set up (no ADMIN_SECRET configured).' });
    if (!adminAuthed(req)) return send(res, 401, { error: 'Wrong admin passphrase.' });
    return send(res, 200, { claims: loadClaims().slice(-100).reverse() });
  }

  if (req.method === 'GET' && url.pathname === '/api/doas') {
    const p = readToken(bearer(req));
    if (!p) return send(res, 401, { error: 'Subscription required.' });
    try {
      const doas = JSON.parse(fs.readFileSync(DOAS_FILE, 'utf8'));
      return send(res, 200, { doas, exp: p.exp });
    } catch (e) {
      console.error('doas file error', e.message);
      return send(res, 500, { error: 'Could not load doas.' });
    }
  }

  return send(res, 404, { error: 'Not found.' });
}

/* ---------- static files ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(idx);
      });
    }
    const ext = path.extname(file).toLowerCase();
    const noCache = ext === '.html' || path.basename(file) === 'sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(buf);
  });
}

/* ---------- admin page: view self-reported claims ---------- */
const ADMIN_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>My Doas App — claims log</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;background:#26262a;color:#f4ebd8;font:16px/1.5 Georgia,serif;padding:28px 18px 60px}
.wrap{max-width:420px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
p.sub{color:#bfb7a6;margin:0 0 24px;font-size:15px}
label{display:block;font-size:14px;color:#bfb7a6;margin:16px 0 6px}
input{width:100%;box-sizing:border-box;height:46px;border-radius:10px;border:1px solid rgba(244,235,216,.2);background:#303035;color:#f4ebd8;padding:0 12px;font:inherit}
button{width:100%;height:48px;margin-top:20px;border:0;border-radius:24px;background:#f2a3c0;color:#2a1f25;font-weight:600;font-size:17px}
button:disabled{opacity:.5}
.msg{margin-top:14px;font-size:14px;color:#ff9b9b}
a{color:#f2a3c0}
</style></head><body><div class="wrap">
<h1>Payment claims log</h1>
<p class="sub">Every "I've paid — Unlock" tap, newest first. Nothing here is verified — check each one against your payment provider's dashboard.</p>
<label for="pw">Admin passphrase</label>
<input id="pw" type="password" autocomplete="off">
<button id="load">Load claims</button>
<div class="msg" id="msg"></div>
<div id="list" style="margin-top:16px;font-size:14.5px"></div>
</div>
<script>
document.getElementById('load').onclick = async function(){
  var btn=this, msg=document.getElementById('msg'), list=document.getElementById('list');
  msg.textContent='';btn.disabled=true;list.textContent='Loading…';
  try{
    var r = await fetch('/api/admin/claims',{headers:{Authorization:'Bearer '+document.getElementById('pw').value}});
    var d = await r.json();
    if(!r.ok) throw new Error(d.error||'Could not load claims.');
    if(!d.claims.length){ list.textContent='No claims yet.'; }
    else{
      list.innerHTML = d.claims.map(function(c){
        var when = new Date(c.ts).toLocaleString();
        return '<div style="padding:10px 0;border-top:1px solid rgba(244,235,216,.15)"><b>'+when+'</b><br>'+
          (c.note ? c.note.replace(/</g,'&lt;') : '<span style="color:#8b8578">(no note)</span>') +
          (c.ip ? '<br><span style="color:#8b8578">from '+c.ip+'</span>' : '') + '</div>';
      }).join('');
    }
  }catch(e){ list.textContent=''; msg.textContent = e.message; }
  btn.disabled=false;
};
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/admin') {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      return res.end(ADMIN_PAGE);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
  }
});

server.listen(PORT, () => {
  console.log('My Doas App on port ' + PORT + ' | checkout link configured: ' + !!CHECKOUT_URL);
});
