'use strict';
/*
 * MPS Kings: servidor do site (sem dependências, só Node 18+).
 * - Entrada: aceite dos termos + nick do Roblox e nick do Discord (não precisa de login externo)
 * - Perfil: o Roblox é consultado pela API pública (confirma que o usuário existe e traz ID e foto)
 * - Support: tickets em formato de conversa; membros veem os próprios, a equipe (com senha) vê todos
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const TERMS_VERSION = 1;
const MAX_USERS = 50000;

/* ---------- armazenamento (arquivo JSON, gravação atômica) ---------- */
function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let db = { users: {}, tickets: {}, messages: {} };
  try {
    db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let queue = Promise.resolve();
  function save() {
    queue = queue
      .then(() => {
        const tmp = file + '.tmp';
        return fs.promises.writeFile(tmp, JSON.stringify(db)).then(() => fs.promises.rename(tmp, file));
      })
      .catch((e) => console.error('Falha ao salvar os dados:', e));
    return queue;
  }
  return { db, save };
}

function createHandler(opts = {}) {
  const env = opts.env || process.env;
  const doFetch = opts.fetch || globalThis.fetch;
  const SECRET = env.SESSION_SECRET;
  if (!SECRET || SECRET.length < 16) throw new Error('Defina SESSION_SECRET com pelo menos 16 caracteres.');
  const BASE_URL = (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const STAFF_PASSWORD = String(env.STAFF_PASSWORD || '').trim();
  const DISCORD_ID = String(env.DISCORD_CLIENT_ID || '1559004196303278140').trim();
  const DISCORD_SECRET = String(env.DISCORD_CLIENT_SECRET || '').trim();
  const DISCORD_GUILD = String(env.DISCORD_GUILD_ID || '1531329234105139331').trim();
  const DISCORD_BOT = String(env.DISCORD_BOT_TOKEN || '').trim(); // opcional: só para ler nome e cor dos cargos
  const DISCORD_ON = !!DISCORD_SECRET;
  const DISCORD_REDIRECT = BASE_URL + '/auth/discord/callback';
  const store = createStore(env.DATA_DIR || path.join(__dirname, 'data'));
  const db = store.db;
  const SECURE = BASE_URL.startsWith('https://');
  const SESSION_DAYS = 365;

  const CSP = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com', "img-src 'self' data: https://*.rbxcdn.com https://cdn.discordapp.com",
    "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; ');

  /* ---------- utilidades ---------- */
  const now = () => Date.now();
  const clean = (s, max) => String(s == null ? '' : s).replace(/\u0000/g, '').trim().slice(0, max);
  const b64 = (buf) => Buffer.from(buf).toString('base64url');
  const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
  const oneLine = (s) => s.replace(/\s+/g, ' ').slice(0, 120);

  function readSession(req) {
    const raw = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('mps='));
    if (!raw) return {};
    const val = raw.slice(4);
    const dot = val.lastIndexOf('.');
    if (dot < 0) return {};
    const payload = val.slice(0, dot), sig = val.slice(dot + 1);
    const good = sign(payload);
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return {};
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!s || typeof s !== 'object' || now() - (s.iat || 0) > SESSION_DAYS * 86400000) return {};
      return s;
    } catch (e) { return {}; }
  }
  function stateCookie(val) {
    const parts = ['Path=/auth/discord', 'HttpOnly', 'SameSite=Lax'];
    if (SECURE) parts.push('Secure');
    return 'mpsst=' + (val || '') + '; ' + parts.join('; ') + '; Max-Age=' + (val ? 600 : 0);
  }
  function sessionCookie(obj) {
    const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (SECURE) parts.push('Secure');
    if (!obj) return 'mps=; ' + parts.join('; ') + '; Max-Age=0';
    const payload = b64(JSON.stringify(Object.assign({}, obj, { iat: now() })));
    return 'mps=' + payload + '.' + sign(payload) + '; ' + parts.join('; ') + '; Max-Age=' + SESSION_DAYS * 86400;
  }

  const baseHeaders = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': CSP, 'Cache-Control': 'no-store',
  };
  function send(res, status, body, extra) {
    const isObj = typeof body === 'object' && body !== null;
    res.writeHead(status, Object.assign({}, baseHeaders, isObj ? { 'Content-Type': 'application/json; charset=utf-8' } : { 'Content-Type': 'text/plain; charset=utf-8' }, extra));
    res.end(isObj ? JSON.stringify(body) : String(body == null ? '' : body));
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] || '');
      if (!type.toLowerCase().startsWith('application/json')) return reject({ status: 415, error: 'json_required' });
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 20000) { reject({ status: 413, error: 'too_large' }); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (e) { reject({ status: 400, error: 'bad_json' }); }
      });
      req.on('error', () => reject({ status: 400, error: 'bad_request' }));
    });
  }
  function clientIp(req) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return (xf.length ? xf[xf.length - 1] : req.socket.remoteAddress) || 'desconhecido';
  }

  /* limite de ações por chave (pessoa ou IP) */
  const hits = new Map();
  function limited(key, max, windowMs) {
    const t = now();
    if (hits.size > 20000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > 3600000) hits.delete(k);
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    const over = list.length >= max;
    if (!over) list.push(t);
    hits.set(key, list);
    return over;
  }

  /* ---------- Roblox (API pública, sem login) ---------- */
  async function robloxAvatar(id) {
    const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`;
    const r = await doFetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j && j.data && j.data[0];
    if (d && d.state === 'Completed' && typeof d.imageUrl === 'string' && /^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//i.test(d.imageUrl)) return d.imageUrl;
    return null;
  }
  async function robloxLookup(nick) {
    const r = await doFetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ usernames: [nick], excludeBannedUsers: false }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error('roblox_http_' + r.status);
    const j = await r.json();
    const u = j && j.data && j.data[0];
    if (!u || !u.id) return null;
    let avatar = null;
    try { avatar = await robloxAvatar(u.id); } catch (e) { /* sem foto por enquanto */ }
    return { id: String(u.id), name: String(u.name || nick), avatar };
  }

  /* ---------- validação do nick do Roblox ---------- */
  const ROBLOX_RE = /^[A-Za-z0-9_]{3,20}$/;
  function readRoblox(body) {
    const robloxNick = clean(body.robloxNick, 40);
    if (!robloxNick) return { error: 'missing_fields' };
    if (!ROBLOX_RE.test(robloxNick)) return { error: 'invalid_roblox' };
    return { robloxNick };
  }

  /* ---------- cargos do servidor (precisa do token do bot, que tem de estar no servidor) ---------- */
  let rolesCache = { at: 0, tried: 0, map: null };
  async function loadRoles() {
    if (!DISCORD_BOT) return;
    const t = now();
    if (rolesCache.map && t - rolesCache.at < 600000) return;
    if (t - rolesCache.tried < 60000) return;
    rolesCache.tried = t;
    try {
      const r = await doFetch('https://discord.com/api/guilds/' + encodeURIComponent(DISCORD_GUILD) + '/roles', { headers: { Authorization: 'Bot ' + DISCORD_BOT }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const arr = await r.json(), map = {};
      for (const x of Array.isArray(arr) ? arr : []) if (x && /^\d{5,25}$/.test(String(x.id))) map[x.id] = { name: clean(x.name, 60), color: Number(x.color) || 0, position: Number(x.position) || 0 };
      rolesCache = { at: t, tried: t, map };
    } catch (e) { console.error('Discord cargos:', e.message); }
  }
  function rolesView(u) {
    const ids = Array.isArray(u.discordRoleIds) ? u.discordRoleIds : [];
    if (!ids.length) return { roles: [], rolesUnavailable: false };
    if (!rolesCache.map) return { roles: [], rolesUnavailable: true };
    const roles = ids.map((id) => rolesCache.map[id] && Object.assign({ id }, rolesCache.map[id])).filter(Boolean)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, color: r.color ? '#' + r.color.toString(16).padStart(6, '0') : null }));
    return { roles, rolesUnavailable: false };
  }

  /* ---------- usuários ---------- */
  function publicUser(u) {
    return {
      id: u.id, isAdmin: !!u.isStaff,
      name: u.isStaff ? 'Equipe' : (u.discordId ? (u.discordServerNick || u.discordNick) : u.robloxName),
      robloxName: u.robloxName || null, robloxId: u.robloxId || null,
      avatar: u.robloxAvatar || null, discordNick: u.discordNick || null,
      discordAvatar: u.discordAvatar || null, discordLinked: !!u.discordId,
      serverNick: u.discordServerNick || null, ...(u.discordId ? rolesView(u) : { roles: [], rolesUnavailable: false }),
    };
  }
  function author(uid) {
    const u = db.users[uid];
    if (!u) return { id: uid, name: 'Membro', avatar: null, robloxName: null, robloxId: null, discordNick: null };
    return {
      id: u.id, name: u.isStaff ? 'Equipe' : (u.discordId ? (u.discordServerNick || u.discordNick) : u.robloxName), avatar: u.discordAvatar || u.robloxAvatar || null,
      robloxName: u.robloxName || null, robloxId: u.robloxId || null, discordNick: u.discordNick || null,
    };
  }

  /* ---------- tickets: auxiliares ---------- */
  const canSee = (ctx, t) => ctx.isAdmin || t.uid === ctx.user.id;
  function ticketView(t, ctx) {
    return {
      id: t.id, subject: t.subject, status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt,
      lastText: t.lastText, lastFrom: t.lastFrom, unread: ctx.isAdmin ? !!t.unreadAdmin : !!t.unreadUser,
      discordNick: t.discordNick || null, robloxNick: t.robloxNick || null,
      author: author(t.uid),
    };
  }

  /* ---------- rotas ---------- */
  const routes = [];
  const route = (method, pattern, opts2, fn) => {
    if (typeof opts2 === 'function') { fn = opts2; opts2 = {}; }
    routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]+)') + '$'), login: !!opts2.login, json: !!opts2.json, fn });
  };

  route('GET', '/api/me', async (ctx) => {
    await loadRoles();
    const u = ctx.session.uid ? db.users[ctx.session.uid] : null;
    if (!u) return send(ctx.res, 200, { user: null, discordLogin: DISCORD_ON });
    if (u.robloxId && (!u.robloxAt || now() - u.robloxAt > 6 * 3600 * 1000)) {
      try {
        const a = await robloxAvatar(u.robloxId);
        if (a) u.robloxAvatar = a;
        u.robloxAt = now();
        await store.save();
      } catch (e) { /* mantém a foto antiga */ }
    }
    send(ctx.res, 200, { user: publicUser(u), discordLogin: DISCORD_ON });
  });

  route('POST', '/api/profile', { login: true, json: true }, async (ctx) => {
    if (ctx.isAdmin) return send(ctx.res, 403, { error: 'staff_has_no_profile' });
    const nicks = readRoblox(ctx.body);
    if (nicks.error) return send(ctx.res, 400, { error: nicks.error });
    if (limited('act:' + ctx.user.id, 20, 60000)) return send(ctx.res, 429, { error: 'rate_limited' });
    let found;
    try { found = await robloxLookup(nicks.robloxNick); } catch (e) {
      console.error('Roblox indisponível:', e.message);
      return send(ctx.res, 502, { error: 'roblox_unavailable' });
    }
    if (!found) return send(ctx.res, 404, { error: 'roblox_not_found' });
    Object.assign(ctx.user, { robloxId: found.id, robloxName: found.name, robloxAvatar: found.avatar, robloxAt: now() });
    await store.save();
    send(ctx.res, 200, { user: publicUser(ctx.user) });
  });

  route('POST', '/api/staff', { json: true }, async (ctx) => {
    if (!STAFF_PASSWORD) return send(ctx.res, 503, { error: 'staff_disabled' });
    if (limited('staff:' + clientIp(ctx.req), 8, 600000)) return send(ctx.res, 429, { error: 'rate_limited' });
    const input = clean(ctx.body.password, 200).toUpperCase();
    if (!crypto.timingSafeEqual(sha(input), sha(STAFF_PASSWORD.toUpperCase()))) return send(ctx.res, 401, { error: 'wrong_password' });
    let u = ctx.session.uid ? db.users[ctx.session.uid] : null;
    if (!u || !u.isStaff) {
      const id = 's' + crypto.randomBytes(8).toString('hex');
      u = db.users[id] = { id, isStaff: true, createdAt: now() };
      await store.save();
    }
    send(ctx.res, 200, { user: publicUser(u) }, { 'Set-Cookie': sessionCookie({ uid: u.id }) });
  });

  /* ---------- login com Discord (OAuth2, escopo identify) ---------- */
  const fail = (res, why) => send(res, 302, '', { Location: '/?discord=erro&why=' + encodeURIComponent(String(why || 'erro').replace(/[^a-z0-9_]/gi, '').slice(0, 20)), 'Set-Cookie': stateCookie('') });
  route('GET', '/auth/discord', (ctx) => {
    if (!DISCORD_ON) return send(ctx.res, 302, '', { Location: '/?discord=off' });
    if (ctx.query.get('terms') !== '1') return send(ctx.res, 302, '', { Location: '/' });
    if (limited('dstart:' + clientIp(ctx.req), 30, 600000)) return send(ctx.res, 429, 'Muitas tentativas');
    const state = crypto.randomBytes(16).toString('hex');
    const q = new URLSearchParams({ client_id: DISCORD_ID, response_type: 'code', redirect_uri: DISCORD_REDIRECT, scope: 'identify guilds.members.read', state });
    send(ctx.res, 302, '', { Location: 'https://discord.com/oauth2/authorize?' + q, 'Set-Cookie': stateCookie(state + '.' + sign('st' + state)) });
  });
  route('GET', '/auth/discord/callback', async (ctx) => {
    const res = ctx.res;
    if (!DISCORD_ON) return fail(res, 'sem_segredo');
    if (limited('dcb:' + clientIp(ctx.req), 30, 600000)) return send(res, 429, 'Muitas tentativas');
    const raw = String(ctx.req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('mpsst='));
    const [st, sg] = raw ? raw.slice(6).split('.') : [];
    const code = ctx.query.get('code');
    if (!st || !sg || !code || ctx.query.get('state') !== st || sg !== sign('st' + st)) return fail(res, ctx.query.get('error') ? 'negado' : 'state');
    let du, serverNick = null, roleIds = [];
    try {
      const tr = await doFetch('https://discord.com/api/oauth2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: DISCORD_ID, client_secret: DISCORD_SECRET, grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT }).toString(),
        signal: AbortSignal.timeout(8000),
      });
      if (!tr.ok) throw new Error('token_' + tr.status);
      const tok = await tr.json();
      const ur = await doFetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tok.access_token }, signal: AbortSignal.timeout(8000) });
      if (!ur.ok) throw new Error('user_' + ur.status);
      du = await ur.json();
      /* apelido da pessoa no servidor (se ela estiver nele); falhar aqui não impede o login */
      try {
        const mr = await doFetch('https://discord.com/api/users/@me/guilds/' + encodeURIComponent(DISCORD_GUILD) + '/member', { headers: { Authorization: 'Bearer ' + tok.access_token }, signal: AbortSignal.timeout(8000) });
        if (mr.ok) { const m = await mr.json(); serverNick = m && typeof m.nick === 'string' ? clean(m.nick, 40) || null : null; roleIds = Array.isArray(m && m.roles) ? m.roles.map(String).filter((x) => /^\d{5,25}$/.test(x)).slice(0, 100) : []; if (!serverNick) console.log('Discord membro: sem apelido definido no servidor'); }
        else console.error('Discord membro: HTTP ' + mr.status + ' (scope concedido: ' + String(tok.scope || '?') + ')');
      } catch (e) { /* segue sem o apelido */ }
    } catch (e) { console.error('Discord:', e.message); return fail(res, String(e.message).replace(/[^a-z0-9_]/gi, '_')); }
    if (!du || !/^\d{5,25}$/.test(String(du.id)) || typeof du.username !== 'string') return fail(res, 'dados');
    const nick = clean(du.username, 40), id = String(du.id);
    const avatar = typeof du.avatar === 'string' && /^[a-f0-9_]{8,64}$/i.test(du.avatar) ? `https://cdn.discordapp.com/avatars/${id}/${du.avatar}.png?size=128` : null;
    const known = Object.values(db.users).find((x) => x.discordId === id);
    if (known) {
      Object.assign(known, { discordNick: nick, discordAvatar: avatar, discordServerNick: serverNick, discordRoleIds: roleIds });
      await store.save();
      return send(res, 302, '', { Location: '/', 'Set-Cookie': [sessionCookie({ uid: known.id }), stateCookie('')] });
    }
    if (Object.keys(db.users).length >= MAX_USERS) return fail(res, 'lotado');
    const uid = 'u' + crypto.randomBytes(8).toString('hex'), at = now();
    db.users[uid] = { id: uid, discordId: id, discordNick: nick, discordServerNick: serverNick, discordRoleIds: roleIds, discordAvatar: avatar, isStaff: false, termsVersion: TERMS_VERSION, termsAcceptedAt: at, createdAt: at };
    await store.save();
    send(res, 302, '', { Location: '/', 'Set-Cookie': [sessionCookie({ uid }), stateCookie('')] });
  });

  route('POST', '/api/logout', { json: true }, (ctx) => send(ctx.res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(null) }));

  route('GET', '/api/tickets', { login: true }, (ctx) => {
    const list = Object.values(db.tickets).filter((t) => canSee(ctx, t))
      .sort((a, b) => b.updatedAt - a.updatedAt).map((t) => ticketView(t, ctx));
    send(ctx.res, 200, { tickets: list });
  });

  route('POST', '/api/tickets', { login: true, json: true }, async (ctx) => {
    if (ctx.isAdmin) return send(ctx.res, 403, { error: 'staff_cannot_open' });
    const subject = clean(ctx.body.subject, 80), text = clean(ctx.body.text, 2000);
    if (!subject || !text) return send(ctx.res, 400, { error: 'missing_fields' });
    if (limited('act:' + ctx.user.id, 20, 60000)) return send(ctx.res, 429, { error: 'rate_limited' });
    const openMine = Object.values(db.tickets).filter((t) => t.uid === ctx.user.id && t.status === 'open').length;
    if (openMine >= 10) return send(ctx.res, 400, { error: 'too_many_open' });
    const id = crypto.randomBytes(5).toString('hex'), at = now();
    db.tickets[id] = {
      id, uid: ctx.user.id, subject, discordNick: ctx.user.discordNick, robloxNick: ctx.user.robloxName,
      status: 'open', createdAt: at, updatedAt: at, lastText: oneLine(text), lastFrom: 'user', unreadAdmin: true, unreadUser: false,
    };
    db.messages[id] = [{ id: crypto.randomBytes(4).toString('hex'), uid: ctx.user.id, from: 'user', text, at }];
    await store.save();
    send(ctx.res, 201, { ticket: ticketView(db.tickets[id], ctx) });
  });

  route('GET', '/api/tickets/:id', { login: true }, async (ctx) => {
    const t = db.tickets[ctx.params.id];
    if (!t || !canSee(ctx, t)) return send(ctx.res, 404, { error: 'not_found' });
    const flag = ctx.isAdmin ? 'unreadAdmin' : 'unreadUser';
    if (t[flag]) { t[flag] = false; await store.save(); }
    const messages = (db.messages[t.id] || []).map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at, mine: m.uid === ctx.user.id, author: author(m.uid) }));
    send(ctx.res, 200, { ticket: ticketView(t, ctx), messages });
  });

  route('POST', '/api/tickets/:id/messages', { login: true, json: true }, async (ctx) => {
    const t = db.tickets[ctx.params.id];
    if (!t || !canSee(ctx, t)) return send(ctx.res, 404, { error: 'not_found' });
    const text = clean(ctx.body.text, 2000);
    if (!text) return send(ctx.res, 400, { error: 'missing_fields' });
    if (limited('act:' + ctx.user.id, 20, 60000)) return send(ctx.res, 429, { error: 'rate_limited' });
    const list = db.messages[t.id] || (db.messages[t.id] = []);
    if (list.length >= 1000) return send(ctx.res, 400, { error: 'ticket_full' });
    const from = ctx.isAdmin ? 'admin' : 'user', at = now();
    list.push({ id: crypto.randomBytes(4).toString('hex'), uid: ctx.user.id, from, text, at });
    Object.assign(t, { status: 'open', updatedAt: at, lastText: oneLine(text), lastFrom: from, unreadAdmin: from === 'user', unreadUser: from === 'admin' });
    await store.save();
    send(ctx.res, 201, { ok: true });
  });

  route('POST', '/api/tickets/:id/status', { login: true, json: true }, async (ctx) => {
    const t = db.tickets[ctx.params.id];
    if (!t || !canSee(ctx, t)) return send(ctx.res, 404, { error: 'not_found' });
    const status = ctx.body.status;
    if (status !== 'open' && status !== 'closed') return send(ctx.res, 400, { error: 'invalid_status' });
    t.status = status;
    await store.save();
    send(ctx.res, 200, { ticket: ticketView(t, ctx) });
  });

  /* ---------- arquivos do site ---------- */
  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch (e) { return send(res, 404, 'Não encontrado'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Não encontrado');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Não encontrado');
      const ext = path.extname(file).toLowerCase();
      const cache = ext === '.png' || ext === '.jpg' ? 'public, max-age=3600' : 'no-cache';
      res.writeHead(200, Object.assign({}, baseHeaders, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache }));
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  /* ---------- despacho ---------- */
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, BASE_URL);
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const ctx = { req, res, query: url.searchParams, params: m.groups || {}, session: readSession(req), body: {} };
        if (r.login) {
          const u = ctx.session.uid ? db.users[ctx.session.uid] : null;
          if (!u) return send(res, 401, { error: 'not_logged_in' });
          ctx.user = u; ctx.isAdmin = !!u.isStaff;
        }
        if (r.json) ctx.body = await readJson(req);
        if (!ctx.body || typeof ctx.body !== 'object') ctx.body = {};
        return await r.fn(ctx);
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found' });
      if (method !== 'GET') return send(res, 405, 'Método não permitido');
      serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e && e.status) return send(res, e.status, { error: e.error });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'server_error' });
    }
  };
}

module.exports = { createHandler };

if (require.main === module) {
  /* lê o arquivo .env (se existir) para quem roda no próprio computador; na hospedagem use as variáveis do painel */
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch (e) { /* sem .env */ }
  const port = Number(process.env.PORT) || 3000;
  http.createServer(createHandler()).listen(port, () => console.log('MPS Kings no ar na porta ' + port));
}
