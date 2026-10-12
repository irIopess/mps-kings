'use strict';
/* Teste de fumaça: sobe o servidor com o Roblox simulado e percorre o fluxo inteiro. */
const http = require('http');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { createHandler } = require('../server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-'));
const robloxUsers = { anaplays: { id: 1234, name: 'AnaPlays' }, biafc: { id: 5678, name: 'BiaFC' }, newana: { id: 9999, name: 'NewAna' } };
const fakeFetch = async (url, init = {}) => {
  const u = String(url);
  const json = (obj, ok = true, status = 200) => ({ ok, status, json: async () => obj });
  if (u === 'https://users.roblox.com/v1/usernames/users') {
    const n = JSON.parse(init.body).usernames[0].toLowerCase();
    return json({ data: robloxUsers[n] ? [robloxUsers[n]] : [] });
  }
  if (u.startsWith('https://thumbnails.roblox.com/v1/users/avatar-headshot')) {
    const id = new URL(u).searchParams.get('userIds');
    return json({ data: [{ targetId: Number(id), state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/' + id + '/150/150/AvatarHeadshot/Png/noFilter' }] });
  }
  if (u === 'https://discord.com/api/oauth2/token') {
    const p = new URLSearchParams(init.body);
    assert.strictEqual(p.get('client_secret'), 'segredo'); assert.strictEqual(p.get('redirect_uri'), 'http://localhost/auth/discord/callback');
    return json({ access_token: 'tok-' + p.get('code') });
  }
  if (u === 'https://discord.com/api/users/@me') {
    const c = String(init.headers.Authorization).replace('Bearer tok-', '');
    const d = discordUsers[c];
    return d ? json(d) : json({}, false, 401);
  }
  throw new Error('fetch inesperado: ' + u);
};
const discordUsers = {
  ana: { id: '111111111111111111', username: 'ana_dc', avatar: 'abcdef0123456789' },
  bia: { id: '222222222222222222', username: 'bia_dc', avatar: null },
};
const env = { SESSION_SECRET: 'x'.repeat(32), BASE_URL: 'http://localhost', STAFF_PASSWORD: 'EREMITA', DISCORD_CLIENT_SECRET: 'segredo', DATA_DIR: dir };

function client(port) {
  let cookie = '';
  async function req(method, p, body, headers = {}) {
    const h = Object.assign({}, headers);
    if (cookie) h.cookie = cookie;
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const r = await fetch('http://127.0.0.1:' + port + p, {
      method, headers: h, redirect: 'manual',
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data };
  }
  return { req, setCookie: (c) => { cookie = c; } };
}
async function discordLogin(port, c, code) {
  const go = await fetch('http://127.0.0.1:' + port + '/auth/discord?terms=1', { redirect: 'manual' });
  const state = new URL(go.headers.get('location')).searchParams.get('state');
  const st = go.headers.getSetCookie()[0].split(';')[0];
  const cb = await fetch('http://127.0.0.1:' + port + '/auth/discord/callback?code=' + code + '&state=' + state, { redirect: 'manual', headers: { cookie: st } });
  const mps = cb.headers.getSetCookie().find((x) => x.startsWith('mps='));
  if (mps) c.setCookie(mps.split(';')[0]);
  return { go, state, st, cb, location: cb.headers.get('location') };
}

(async () => {
  const server = http.createServer(createHandler({ env, fetch: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ana = client(port), bia = client(port), staff = client(port), anon = client(port);
  let n = 0;
  const ok = (name) => console.log('ok ' + ++n + ' - ' + name);

  assert.strictEqual((await anon.req('GET', '/api/me')).data.user, null);
  assert.strictEqual((await anon.req('GET', '/api/me')).data.discordLogin, true); ok('visitante sem entrada e login com Discord ligado');
  assert.strictEqual((await anon.req('GET', '/api/tickets')).status, 401); ok('tickets exigem entrada');
  assert.strictEqual((await anon.req('POST', '/api/register', { terms: true, robloxNick: 'x', discordNick: 'y' })).status, 404); ok('não existe cadastro manual: só o Discord cria conta');

  const first = await discordLogin(port, ana, 'ana');
  const loc = new URL(first.go.headers.get('location'));
  assert.strictEqual(loc.origin + loc.pathname, 'https://discord.com/oauth2/authorize');
  assert.strictEqual(loc.searchParams.get('client_id'), '1559004196303278140'); assert.strictEqual(loc.searchParams.get('scope'), 'identify');
  assert.strictEqual(loc.searchParams.get('redirect_uri'), 'http://localhost/auth/discord/callback'); ok('botão manda para o Discord com o client_id e o redirect do site');
  assert.strictEqual((await fetch('http://127.0.0.1:' + port + '/auth/discord', { redirect: 'manual' })).headers.get('location'), '/'); ok('sem concordar com os termos não inicia o login');
  const cb = (qs, ck) => fetch('http://127.0.0.1:' + port + '/auth/discord/callback?' + qs, { redirect: 'manual', headers: ck ? { cookie: ck } : {} });
  assert.strictEqual((await cb('code=ana&state=' + first.state)).headers.get('location'), '/?discord=erro');
  assert.strictEqual((await cb('code=ana&state=outro', first.st)).headers.get('location'), '/?discord=erro');
  assert.strictEqual((await cb('code=invalido&state=' + first.state, first.st)).headers.get('location'), '/?discord=erro'); ok('retorno sem state certo ou com código inválido é recusado');

  assert.strictEqual(first.location, '/');
  let me = (await ana.req('GET', '/api/me')).data.user;
  assert.strictEqual(me.name, 'ana_dc'); assert.strictEqual(me.discordNick, 'ana_dc'); assert.strictEqual(me.discordLinked, true); assert.strictEqual(me.isAdmin, false); assert.strictEqual(me.robloxName, null);
  assert.match(me.discordAvatar, /^https:\/\/cdn\.discordapp\.com\/avatars\/111111111111111111\/abcdef/); ok('conectar já cria a conta com nome e foto do Discord, sem pedir nicks');

  const forged = client(port); forged.setCookie('mps=' + Buffer.from(JSON.stringify({ uid: me.id, iat: Date.now() })).toString('base64url') + '.assinaturafalsa');
  assert.strictEqual((await forged.req('GET', '/api/me')).data.user, null); ok('cookie adulterado é ignorado');
  assert.strictEqual((await ana.req('POST', '/api/tickets', '{"subject":"x"}', { 'content-type': 'text/plain' })).status, 415); ok('POST sem JSON é recusado');

  assert.strictEqual((await ana.req('POST', '/api/tickets', { subject: '', text: 'oi' })).status, 400);
  const created = await ana.req('POST', '/api/tickets', { subject: 'Inscrição no campeonato', text: 'Oi, preciso de ajuda' });
  assert.strictEqual(created.status, 201); const tid = created.data.ticket.id;
  let list = (await ana.req('GET', '/api/tickets')).data.tickets;
  assert.strictEqual(list.length, 1); assert.strictEqual(list[0].unread, false); assert.strictEqual(list[0].discordNick, 'ana_dc'); assert.strictEqual(list[0].robloxNick, null); ok('membro só com Discord abre ticket');

  await discordLogin(port, bia, 'bia');
  assert.strictEqual((await bia.req('GET', '/api/tickets')).data.tickets.length, 0);
  assert.strictEqual((await bia.req('GET', '/api/tickets/' + tid)).status, 404);
  assert.strictEqual((await bia.req('POST', '/api/tickets/' + tid + '/messages', { text: 'intruso' })).status, 404);
  assert.strictEqual((await bia.req('POST', '/api/tickets/' + tid + '/status', { status: 'closed' })).status, 404);
  assert.strictEqual((await bia.req('POST', '/api/staff', { password: 'errada' })).status, 401); ok('outro membro não vê nem mexe, e senha errada não vira equipe');

  const again = await discordLogin(port, client(port), 'ana'); assert.strictEqual(again.location, '/');
  const back = client(port); await discordLogin(port, back, 'ana');
  assert.strictEqual((await back.req('GET', '/api/me')).data.user.id, me.id);
  assert.strictEqual((await back.req('GET', '/api/tickets')).data.tickets.length, 1); ok('quem volta com o Discord, de outro aparelho, recupera a conta e os tickets');

  const noPw = http.createServer(createHandler({ env: Object.assign({}, env, { STAFF_PASSWORD: '', DISCORD_CLIENT_SECRET: '', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mps-')) }), fetch: fakeFetch }));
  await new Promise((r) => noPw.listen(0, '127.0.0.1', r));
  const npc = client(noPw.address().port);
  assert.strictEqual((await npc.req('POST', '/api/staff', { password: '' })).status, 503);
  assert.strictEqual((await npc.req('GET', '/api/me')).data.discordLogin, false);
  noPw.close(); ok('sem as variáveis, Staff e login com Discord ficam desligados');

  const st = await staff.req('POST', '/api/staff', { password: 'eremita' });
  assert.strictEqual(st.status, 200); assert.strictEqual(st.data.user.isAdmin, true); assert.strictEqual(st.data.user.name, 'Equipe');
  assert.strictEqual((await staff.req('GET', '/api/me')).data.user.isAdmin, true); ok('senha EREMITA entra como equipe (sem diferenciar maiúsculas)');
  list = (await staff.req('GET', '/api/tickets')).data.tickets;
  assert.strictEqual(list.length, 1); assert.strictEqual(list[0].unread, true); assert.strictEqual(list[0].author.discordNick, 'ana_dc'); assert.ok(list[0].author.avatar); ok('equipe vê o ticket com o Discord de quem abriu');
  let det = (await staff.req('GET', '/api/tickets/' + tid)).data;
  assert.strictEqual(det.messages.length, 1); assert.strictEqual(det.messages[0].mine, false);
  assert.strictEqual((await staff.req('GET', '/api/tickets')).data.tickets[0].unread, false); ok('abrir marca como lido');
  assert.strictEqual((await staff.req('POST', '/api/tickets', { subject: 'x', text: 'y' })).status, 403); ok('equipe não abre ticket');

  assert.strictEqual((await staff.req('POST', '/api/tickets/' + tid + '/messages', { text: 'Claro, me conta mais' })).status, 201);
  list = (await ana.req('GET', '/api/tickets')).data.tickets;
  assert.strictEqual(list[0].unread, true); assert.strictEqual(list[0].lastFrom, 'admin');
  det = (await ana.req('GET', '/api/tickets/' + tid)).data;
  assert.strictEqual(det.messages.length, 2); assert.strictEqual(det.messages[1].from, 'admin'); assert.strictEqual(det.messages[1].author.name, 'Equipe'); assert.strictEqual(det.messages[0].mine, true); ok('equipe responde e o membro vê');

  assert.strictEqual((await staff.req('POST', '/api/tickets/' + tid + '/status', { status: 'closed' })).data.ticket.status, 'closed');
  assert.strictEqual((await ana.req('POST', '/api/tickets/' + tid + '/messages', { text: 'Ainda preciso' })).status, 201);
  assert.strictEqual((await ana.req('GET', '/api/tickets/' + tid)).data.ticket.status, 'open'); ok('fechar e reabrir ao responder');

  assert.strictEqual((await ana.req('POST', '/api/profile', { robloxNick: 'x' })).data.error, 'invalid_roblox');
  assert.strictEqual((await ana.req('POST', '/api/profile', { robloxNick: 'NinguemExiste' })).status, 404);
  const up = await ana.req('POST', '/api/profile', { robloxNick: 'anaplays' });
  assert.strictEqual(up.status, 200); assert.strictEqual(up.data.user.robloxId, '1234'); assert.strictEqual(up.data.user.robloxName, 'AnaPlays'); assert.strictEqual(up.data.user.name, 'ana_dc');
  assert.match(up.data.user.avatar, /^https:\/\/tr\.rbxcdn\.com\/1234\//);
  assert.strictEqual((await ana.req('GET', '/api/tickets')).data.tickets[0].robloxNick, null);
  assert.strictEqual((await staff.req('POST', '/api/profile', { robloxNick: 'NewAna' })).status, 403); ok('Roblox é opcional: entra no perfil, com ID e foto; ticket antigo guarda os dados da época');
  const t2 = await ana.req('POST', '/api/tickets', { subject: 'Outro', text: 'Agora com Roblox' });
  const l2 = (await staff.req('GET', '/api/tickets')).data.tickets.find((t) => t.id === t2.data.ticket.id);
  assert.strictEqual(l2.robloxNick, 'AnaPlays'); assert.strictEqual(l2.author.robloxId, '1234'); ok('equipe vê nick e ID do Roblox quando a pessoa informou');

  const html = await anon.req('GET', '/');
  assert.strictEqual(html.status, 200); assert.match(html.data, /MPS Kings/); assert.match(html.data, /Conectar com Discord/); assert.ok(!/Pr[ée]via/.test(html.data));
  assert.strictEqual((await fetch('http://127.0.0.1:' + port + '/hero.jpg')).status, 200);
  assert.strictEqual((await fetch('http://127.0.0.1:' + port + '/logo.png')).status, 200);
  const trav = await new Promise((resolve) => http.get({ port, host: '127.0.0.1', path: '/..%2fserver.js' }, (r) => { r.resume(); resolve(r.statusCode); }));
  assert.strictEqual(trav, 404); ok('site estático e bloqueio de caminhos fora de public');

  await ana.req('POST', '/api/logout', {});
  assert.strictEqual((await ana.req('GET', '/api/me')).data.user, null); ok('logout');

  const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  const saved = JSON.parse(raw);
  const anaRec = Object.values(saved.users).find((u) => u.discordId === '111111111111111111');
  assert.ok(anaRec.termsAcceptedAt > 0); assert.strictEqual(anaRec.termsVersion, 1);
  assert.ok(!/EREMITA/i.test(raw) && !/segredo/.test(raw) && !/tok-/.test(raw)); ok('aceite dos termos gravado; senha, segredo e token não vão para o arquivo');

  let last = 0;
  for (let i = 0; i < 10 && last !== 429; i++) last = (await anon.req('POST', '/api/staff', { password: 'chute' + i })).status;
  assert.strictEqual(last, 429); ok('muitas tentativas de senha são bloqueadas');

  server.close();
  console.log('\nTodos os ' + n + ' testes passaram.');
})().catch((e) => { console.error('\nFALHOU:', e); process.exit(1); });
