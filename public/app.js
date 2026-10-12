(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var S = {
    me: null, ready: false, seenRows: {}, seenMsgs: {}, ann: [], annUnread: 0, annAt: 0, annMarkFrom: null, annSeen: {},
    tickets: [], ticketsSig: '', loaded: false, loadedOnce: false, filter: 'open',
    selected: null, composing: false, cur: null, msgs: [], sig: '', threadKey: '',
    sending: false, editProfile: false
  };

  /* ---------- helpers ---------- */
  function put(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { put(el, x); }); return; }
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) put(e, arguments[i]);
    return e;
  }
  var tFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
  var dFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  function fmt(ts) {
    if (!ts) return '';
    var d = new Date(ts), n = new Date();
    return d.toDateString() === n.toDateString() ? tFmt.format(d) : dFmt.format(d);
  }
  function shortId(id) { return '#' + String(id).slice(-4).toUpperCase(); }
  function letterAvatar(ch) {
    ch = String(ch || '?').charAt(0).toUpperCase();
    if (!/[A-Z0-9_]/.test(ch)) ch = '?';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#2b2b30"/><text x="64" y="86" font-family="Arial,sans-serif" font-size="64" font-weight="700" text-anchor="middle" fill="#f5f5f6">' + ch + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }
  var toastTimer;
  function toast(msg) {
    var el = $('#toast'); el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }
  function api(url, o) {
    o = o || {};
    var init = { method: o.method || 'GET', credentials: 'same-origin', headers: {} };
    if (o.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.body); }
    return fetch(url, init).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) {
          var code = (j && j.error) || ('http_' + r.status);
          var e = new Error(code); e.code = code; e.status = r.status;
          if (code === 'not_logged_in' && S.me) authLost();
          throw e;
        }
        return j;
      });
    });
  }
  function errText(e) {
    switch (e && e.code) {
      case 'not_logged_in': return 'Sua sessão expirou. Entre de novo.';
      case 'terms_required': return 'Concorde com os termos para continuar.';
      case 'rate_limited': return 'Muitas tentativas em pouco tempo. Espere um pouco e tente de novo.';
      case 'too_many_open': return 'Você já tem 10 tickets abertos. Feche algum antes de abrir outro.';
      case 'missing_fields': return 'Preencha todos os campos.';
      case 'invalid_roblox': return 'O nick do Roblox deve ter de 3 a 20 letras, números ou _.';
      case 'invalid_discord': return 'O nick do Discord deve ter de 2 a 32 caracteres: letras, números, _ ou ponto.';
      case 'roblox_not_found': return 'Não achei esse usuário no Roblox. Confira o nick (o nome de usuário, não o de exibição).';
      case 'roblox_unavailable': return 'O Roblox não respondeu agora. Tente de novo em instantes.';
      case 'wrong_password': return 'Senha incorreta.';
      case 'staff_only': return 'Só a Staff pode fazer isso.';
      case 'ticket_closed': return 'Este ticket está fechado. Só a Staff pode responder nele.';
      case 'invalid_theme': return 'Essa cor não existe.';
      case 'staff_disabled': return 'O acesso da Staff não está configurado neste servidor.';
      case 'full': return 'O site está lotado no momento. Tente mais tarde.';
      default: return 'Algo deu errado. Tente de novo.';
    }
  }
  function resetData() {
    S.tickets = []; S.ticketsSig = ''; S.loaded = false; S.loadedOnce = false;
    S.selected = null; S.composing = false; S.cur = null; S.msgs = []; S.sig = ''; S.editProfile = false; S.seenRows = {}; S.seenMsgs = {}; S.ann = []; S.annUnread = 0; S.annAt = 0; S.annMarkFrom = null; S.annSeen = {};
  }
  function authLost() {
    S.me = null; resetData();
    renderAll();
  }

  /* ---------- pílula que desliza entre as abas ---------- */
  var pill = null;
  function movePill() {
    var nav = document.querySelector('.nav'), cur = nav && nav.querySelector('a[aria-current="page"]');
    if (!nav) return;
    if (!pill) { pill = document.createElement('span'); pill.className = 'nav-pill'; pill.setAttribute('aria-hidden', 'true'); nav.prepend(pill); }
    pill.style.opacity = cur ? '' : '0';
    if (!cur || !cur.offsetWidth) return;
    pill.style.width = cur.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + cur.offsetLeft + 'px)';
    if (!pill.classList.contains('ready')) requestAnimationFrame(function () { requestAnimationFrame(function () { pill.classList.add('ready'); }); });
  }
  window.addEventListener('resize', movePill);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(movePill);

  /* ---------- telas ---------- */
  var VIEWS = ['home', 'profile', 'support', 'announcements', 'setup'];
  var current = 'home', lastShown = '';
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function show(v) {
    if (VIEWS.indexOf(v) < 0) v = 'home';
    if (v === 'setup' && !(S.me && S.me.isAdmin)) v = 'home';
    current = v;
    var guest = S.ready && !S.me;
    document.body.classList.toggle('guest', guest);
    if (S.ready) {
      var key = guest ? 'login' : v;
      if (key !== lastShown) {
        lastShown = key;
        var el = $('#view-' + key);
        el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter');
      }
    }
    $('#view-login').hidden = !guest;
    VIEWS.forEach(function (n) {
      $('#view-' + n).hidden = guest || !S.ready || n !== v;
      var a = $('#nav-' + n);
      if (!a) return;
      if (n === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (guest || !S.ready) return;
    movePill();
    if (v !== 'announcements') S.annMarkFrom = null;
    if (v === 'profile') renderProfile();
    if (v === 'announcements' || v === 'setup') { renderAnn(); loadAnn(true); }
    if (v === 'support') { renderSupport(); loadTickets(); }
  }
  document.addEventListener('click', function (ev) {
    var a = ev.target.closest && ev.target.closest('[data-go]');
    if (!a) return;
    ev.preventDefault();
    var v = a.getAttribute('data-go');
    show(v);
    try { history.replaceState(null, '', '#' + v); } catch (e) {}
    window.scrollTo(0, 0);
  });
  window.addEventListener('hashchange', function () { show(initialView()); });
  function initialView() {
    var x = (location.hash || '').replace('#', '');
    return VIEWS.indexOf(x) >= 0 ? x : 'home';
  }
  /* ---------- dados ---------- */
  function findTicket(id) {
    for (var i = 0; i < S.tickets.length; i++) if (S.tickets[i].id === id) return S.tickets[i];
    return null;
  }
  function counts() {
    var o = 0, c = 0, u = 0;
    S.tickets.forEach(function (t) { if (t.status === 'open') o++; else c++; if (t.unread) u++; });
    return { open: o, closed: c, unread: u };
  }
  function loadTickets() {
    if (!S.me) return Promise.resolve();
    loadAnn(false);
    return api('/api/tickets').then(function (res) {
      var sig = JSON.stringify(res.tickets);
      S.loaded = true;
      if (sig !== S.ticketsSig) { S.ticketsSig = sig; S.tickets = res.tickets; renderTicketsUI(); }
      else if (!S.loadedOnce) renderTicketsUI();
      S.loadedOnce = true;
    }).catch(function () {});
  }
  function loadThread() {
    var id = S.selected;
    if (!id || !S.me) return Promise.resolve();
    return api('/api/tickets/' + id).then(function (res) {
      if (S.selected !== id) return;
      var last = res.messages[res.messages.length - 1];
      var sig = res.messages.length + ':' + (last ? last.id : '') + ':' + res.ticket.status;
      S.cur = res.ticket;
      if (sig !== S.sig) { S.sig = sig; S.msgs = res.messages; renderSupport(); }
    }).catch(function (e) {
      if (e && e.status === 404 && S.selected === id) { closePane(); toast('Esse ticket não existe mais.'); }
    });
  }
  function openTicket(id) {
    S.selected = id; S.composing = false; S.msgs = []; S.sig = ''; S.cur = null;
    renderSupport(); loadThread();
  }
  function closePane() {
    S.selected = null; S.composing = false; S.msgs = []; S.sig = ''; S.cur = null;
    renderSupport();
  }

  /* ---------- renderização ---------- */
  function renderAll() { renderChrome(); show(current); }
  function renderTicketsUI() { renderChrome(); if (current === 'support') renderSupport(); }
  function meAvatar(me) { return me.discordAvatar || me.avatar || letterAvatar(me.isAdmin ? 'S' : me.name); }

  function renderChrome() {
    var me = S.me;
    $('#btn-staff').hidden = !me || me.isAdmin;
    $('#btn-setup').hidden = !(me && me.isAdmin);
    var ab = $('#nav-ann-badge'); ab.hidden = !(me && S.annUnread > 0 && current !== 'announcements');
    movePill();
    $('#me-user').hidden = !me;
    if (me) {
      $('#me-img').src = meAvatar(me);
      $('#me-name').textContent = me.isAdmin ? 'Staff' : (me.discordNick || me.name);
      $('#me-tag').hidden = !me.isAdmin;
    }
    var ha = $('#hero-avatar');
    ha.hidden = !(me && !me.isAdmin);
    if (me && !me.isAdmin) ha.src = meAvatar(me);
    $('#hero-name').textContent = me ? (me.isAdmin ? 'Staff' : me.name) : 'Visitante';
    $('#hero-eyebrow').textContent = me ? 'Welcome back' : 'Welcome';
    var n = counts();
    $('#nav-badge').hidden = !(me && n.unread > 0);
    var title = $('#home-sup-title'), sub = $('#home-sup-sub');
    if (me && me.isAdmin) {
      title.textContent = n.open + (n.open === 1 ? ' ticket aberto' : ' tickets abertos');
      sub.textContent = n.unread ? n.unread + (n.unread === 1 ? ' conversa com mensagem nova.' : ' conversas com mensagem nova.') : 'Responda as conversas dos membros aqui.';
    } else if (n.unread) { title.textContent = 'Resposta nova'; sub.textContent = 'A Staff respondeu um dos seus tickets.'; }
    else { title.textContent = 'Tickets'; sub.textContent = 'Abra um ticket e converse com a Staff.'; }
  }

  function nickField(id, label, value, placeholder, max) {
    return h('div', { class: 'field' },
      h('label', { for: id, text: label }),
      h('input', { id: id, maxlength: String(max), placeholder: placeholder, value: value || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }));
  }

  function rolesBlock(me) {
    var box = h('div', { class: 'prow' }, h('span', { class: 'plabel', text: 'Cargos no servidor' }));
    if (me.roles && me.roles.length) {
      var list = h('div', { class: 'roles' });
      me.roles.forEach(function (r, i) {
        var dot = h('span', { class: 'rdot' });
        dot.style.backgroundColor = r.color || '#99aab5';
        var chip = h('span', { class: 'role' }, dot, h('span', { text: r.name }));
        chip.style.setProperty('--i', String(Math.min(i, 10)));
        list.append(chip);
      });
      box.append(list);
    } else {
      box.append(h('p', { class: 'pid', text: me.rolesUnavailable ? 'Cargos indisponíveis no momento.' : 'Nenhum cargo no servidor.' }));
    }
    return box;
  }

  /* ---------- anúncios ---------- */
  function annCard(a, opts) {
    var isNew = opts.markFrom != null && a.at > opts.markFrom;
    var top = h('div', { class: 'ann-top' }, h('h3', { text: a.title }), isNew ? h('span', { class: 'new-pill', text: 'Novo' }) : null);
    var card = h('article', { class: 'ann' + (isNew ? ' is-new' : '') }, top,
      h('p', { text: a.text }), h('time', { text: 'Staff · ' + fmt(a.at) }));
    if (opts.del) card.append(h('button', { class: 'btn small del', type: 'button', text: 'Excluir', onclick: function () {
      api('/api/announcements/' + a.id + '/delete', { method: 'POST', body: {} }).then(function () { toast('Anúncio apagado.'); return loadAnn(true); })
        .catch(function (e) { toast(errText(e)); });
    } }));
    if (!S.annSeen[a.id]) { S.annSeen[a.id] = 1; card.classList.add('fresh'); }
    return card;
  }
  function renderAnn() {
    if (!S.me) return;
    var box = $('#ann-list'), sbox = $('#setup-list');
    box.replaceChildren(); sbox.replaceChildren();
    var empty = function () { return h('div', { class: 'ann-empty', text: S.annAt ? 'Nenhum anúncio por enquanto.' : 'Carregando…' }); };
    if (!S.ann.length) { box.append(empty()); sbox.append(empty()); return; }
    S.ann.forEach(function (a) {
      box.append(annCard(a, { markFrom: S.annMarkFrom }));
      sbox.append(annCard(a, { del: true }));
    });
  }
  function loadAnn(force) {
    if (!S.me) return Promise.resolve();
    if (!force && Date.now() - S.annAt < 14000) return Promise.resolve();
    S.annAt = Date.now();
    return api('/api/announcements').then(function (res) {
      var sig = JSON.stringify(res.announcements), changed = sig !== S.annSig;
      if (current === 'announcements' && S.annMarkFrom == null) S.annMarkFrom = res.seenAt || 0;
      S.annSig = sig; S.ann = res.announcements; S.annUnread = res.unread;
      if (current === 'announcements') {
        if (res.unread > 0) api('/api/announcements/seen', { method: 'POST', body: {} }).then(function () { S.annUnread = 0; renderChrome(); }).catch(function () {});
      }
      if (changed || current === 'announcements') { if (current === 'announcements' || current === 'setup') renderAnn(); }
      renderChrome();
    }).catch(function () {});
  }

  /* ---------- cores do site ---------- */
  var THEMES = [['padrao', 'Padrão', '#f5f5f6'], ['azul', 'Azul', '#6b9bff'], ['roxo', 'Roxo', '#b07bff'], ['verde', 'Verde', '#3ddc84'], ['vermelho', 'Vermelho', '#ff6464'], ['dourado', 'Dourado', '#f5b942']];
  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'padrao'; }
  function applyTheme(name, save) {
    if (!THEMES.some(function (t) { return t[0] === name; })) name = 'padrao';
    if (name === 'padrao') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', name);
    if (save) { try { localStorage.setItem('mps-theme', name); } catch (e) {} }
  }
  function themeBlock() {
    var box = h('div', { class: 'theme-box' }, h('h2', { text: 'Cores do site' }), h('p', { text: 'Escolha as cores da interface. Só muda para você.' }));
    var wrap = h('div', { class: 'swatches' });
    THEMES.forEach(function (t) {
      var dot = h('i'); dot.style.backgroundColor = t[2];
      wrap.append(h('button', { class: 'sw', type: 'button', 'aria-pressed': String(currentTheme() === t[0]), onclick: function () {
        applyTheme(t[0], true);
        wrap.querySelectorAll('.sw').forEach(function (b) { b.setAttribute('aria-pressed', String(b === this)); }, this);
        api('/api/theme', { method: 'POST', body: { theme: t[0] } }).catch(function () {});
      } }, dot, t[1]));
    });
    box.append(wrap);
    return box;
  }

  function renderProfile() {
    var box = $('#profile-box'); box.replaceChildren();
    if (!S.ready || !S.me) return;
    var me = S.me;
    if (me.isAdmin) {
      box.append(h('div', { class: 'gate' }, h('p', { text: 'Conta da Staff. Você vê e responde os tickets de todos os membros.' })), themeBlock());
      return;
    }
    var pic = me.discordAvatar || me.avatar;
    var photo = pic
      ? h('img', { class: 'rb-photo', src: pic, alt: 'Foto de ' + me.name, width: '168', height: '168', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'rb-photo empty-photo', text: 'Foto indisponível no momento' });
    var info;
    if (S.editProfile) {
      var errEl = h('p', { class: 'phint', role: 'alert' });
      var save = h('button', { class: 'btn primary', type: 'submit', text: 'Salvar' });
      info = h('form', { class: 'editform', novalidate: true, onsubmit: function (ev) {
        ev.preventDefault();
        var rb = $('#edit-roblox').value.trim(), dcEl = $('#edit-discord'), dc = dcEl ? dcEl.value.trim() : '';
        if (!rb || (dcEl && !dc)) { errEl.textContent = errText({ code: 'missing_fields' }); return; }
        save.disabled = true; errEl.textContent = '';
        api('/api/profile', { method: 'POST', body: { robloxNick: rb, discordNick: dc } }).then(function (res) {
          S.me = res.user; S.editProfile = false; renderAll(); toast('Perfil atualizado.');
        }).catch(function (e) { errEl.textContent = errText(e); save.disabled = false; });
      } },
        nickField('edit-roblox', 'Nick do Roblox', me.robloxName, 'Seu usuário do Roblox', 20),
        me.discordLinked ? null : nickField('edit-discord', 'Nick do Discord', me.discordNick, 'Seu usuário do Discord', 40),
        errEl,
        h('div', { class: 'actions' }, save,
          h('button', { class: 'btn', type: 'button', text: 'Cancelar', onclick: function () { S.editProfile = false; renderProfile(); } })));
    } else {
      info = h('div', null,
        h('div', { class: 'prow' }, h('span', { class: 'plabel', text: 'Discord' }),
          h('p', { class: 'pvalue', text: me.discordNick })),
        me.discordLinked ? h('div', { class: 'prow' }, h('span', { class: 'plabel', text: 'Roblox Account' }),
          h('p', { class: 'pvalue', text: me.serverNick || 'Sem apelido no servidor' })) : null,
        me.discordLinked ? rolesBlock(me) : null);
    }
    box.append(h('div', { class: 'profile-card' }, photo, info), themeBlock());
  }

  function renderSupport() {
    if (!S.me) return;
    var grid = $('#grid');
    $('#btn-new').hidden = S.me.isAdmin;
    $('#sup-sub').textContent = S.me.isAdmin ? 'Painel da Staff. Todas as conversas dos membros.' : 'Suas conversas com a Staff.';

    var n = counts();
    $('#ct-open').textContent = n.open; $('#ct-closed').textContent = n.closed;
    document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-f') === S.filter)); });
    renderList();

    var t = S.selected ? (findTicket(S.selected) || (S.cur && S.cur.id === S.selected ? S.cur : null)) : null;
    var showThread = !!t && !S.composing, showNew = S.composing;
    grid.classList.toggle('in-thread', showThread || showNew);
    $('#pane-new').hidden = !showNew;
    $('#pane-thread').hidden = !showThread;
    var empty = $('#pane-empty');
    empty.hidden = showThread || showNew;
    if (!empty.hidden) {
      empty.replaceChildren();
      if (!S.loaded) empty.append(h('strong', { text: 'Carregando' }), 'Buscando os tickets.');
      else if (!S.tickets.length) empty.append(
        h('strong', { text: S.me.isAdmin ? 'Nenhum ticket ainda' : 'Nenhum ticket aberto' }),
        S.me.isAdmin ? 'Quando um membro abrir um ticket, a conversa aparece aqui.' : 'Use Novo ticket para falar com a Staff.');
      else empty.append(h('strong', { text: 'Escolha uma conversa' }), 'Selecione um ticket na lista para ver as mensagens.');
    }
    if (showThread) { renderThreadHead(t); renderMsgs(t); }
  }

  function renderList() {
    var ul = $('#list'); ul.replaceChildren();
    var rows = S.tickets.filter(function (t) { return t.status === S.filter; });
    if (!rows.length) {
      ul.append(h('li', { class: 'empty' },
        h('strong', { text: S.loaded ? (S.filter === 'open' ? 'Nada em aberto' : 'Nada fechado') : 'Carregando' }),
        S.loaded ? 'Nenhum ticket nesta lista.' : 'Buscando os tickets.'));
      return;
    }
    var freshN = 0;
    rows.forEach(function (t) {
      var sel = S.selected === t.id;
      if (!S.seenRows[t.id]) S.seenRows[t.id] = Date.now();
      var age = Date.now() - S.seenRows[t.id], isNew = age < 900;
      var rowLi = null;
      var who = S.me.isAdmin ? (t.author.name || 'Membro') : (t.lastFrom === 'admin' ? 'Staff' : 'Você');
      ul.append(rowLi = h('li', null,
        h('button', { class: 'row', type: 'button', 'aria-current': sel ? 'true' : null, onclick: function () { openTicket(t.id); } },
          h('span', { class: 'row-top' },
            h('span', { class: 'row-subject', text: t.subject }),
            t.unread ? h('span', { class: 'dot', title: 'Mensagem nova' }) : null),
          h('span', { class: 'row-last', text: t.lastText || ' ' }),
          h('span', { class: 'row-meta' },
            h('span', { class: 'who', text: shortId(t.id) + ' · ' + who }),
            h('time', { text: fmt(t.updatedAt) })))));
      if (isNew) { var rb = rowLi.firstChild; rb.classList.add('fresh'); rb.style.setProperty('--i', String(Math.min(freshN++, 8))); rb.style.setProperty('--el', age + 'ms'); }
    });
  }

  function renderThreadHead(t) {
    $('#th-subject').textContent = t.subject;
    $('#th-sub').textContent = shortId(t.id) + ' · aberto em ' + fmt(t.createdAt) + (S.me.isAdmin ? ' · ' + (t.author.name || 'Membro') : '');
    var ids = $('#th-ids'), a = t.author;
    ids.hidden = !S.me.isAdmin;
    if (S.me.isAdmin) {
      var rbNick = t.robloxNick || a.robloxName || a.serverNick;
      var sameRb = a.robloxId && a.robloxName && rbNick && rbNick.toLowerCase() === String(a.robloxName).toLowerCase();
      ids.textContent = 'Roblox ' + (rbNick || 'não informado') + (sameRb ? ' · ID ' + a.robloxId : '') +
        '  |  Discord ' + (t.discordNick || a.discordNick || 'não informado');
    }
    var pill = $('#th-pill'); pill.textContent = t.status === 'open' ? 'Aberto' : 'Fechado';
    pill.className = 'pill ' + t.status;
    $('#th-toggle').textContent = t.status === 'open' ? 'Fechar ticket' : 'Reabrir';
    var locked = t.status === 'closed' && !S.me.isAdmin;
    $('#th-toggle').hidden = locked;
    $('#msg-input').disabled = locked; $('#msg-send').disabled = locked || !!S.sending;
    $('#msg-input').placeholder = locked ? 'Ticket fechado. Só a Staff pode responder.' : (t.status === 'closed' ? 'Responder reabre o ticket' : 'Escreva uma mensagem');
    $('#closed-note').hidden = t.status !== 'closed';
  }

  function renderMsgs(t) {
    var box = $('#msgs');
    var near = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    box.replaceChildren();
    if (S.threadKey !== t.id) S.seenMsgs = {};
    var firstLoad = S.threadKey !== t.id, freshM = 0, total = S.msgs.length;
    S.msgs.forEach(function (m, idx) {
      var by = m.mine ? 'Você' : (m.from === 'admin' ? 'Staff' : ((m.author && (m.author.discordNick || m.author.name)) || 'Membro'));
      if (!S.seenMsgs[m.id]) S.seenMsgs[m.id] = (firstLoad && idx < total - 8) ? 1 : Date.now();
      var ageM = Date.now() - S.seenMsgs[m.id], isNewM = ageM < 900;
      var mEl = h('div', { class: 'm' + (m.mine ? ' mine' : '') },
        h('div', { class: 'who-msg', text: by }),
        h('div', { class: 'bubble', text: String(m.text || '') }),
        h('div', { class: 'by', text: fmt(m.at) }));
      if (isNewM && (!firstLoad || idx >= total - 8)) { mEl.classList.add('fresh'); mEl.style.setProperty('--i', String(firstLoad ? freshM++ : 0)); mEl.style.setProperty('--el', ageM + 'ms'); }
      box.append(mEl);
    });
    if (near || S.threadKey !== t.id) box.scrollTop = box.scrollHeight;
    S.threadKey = t.id;
  }

  /* ---------- senha da Staff ---------- */
  function openStaff() {
    var dlg = $('#staff-dialog');
    $('#staff-pass').value = ''; $('#staff-err').textContent = '';
    if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
    $('#staff-pass').focus();
  }
  function closeStaff() {
    var dlg = $('#staff-dialog');
    if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
  }

  /* ---------- ações ---------- */
  function bind() {
    $('#btn-agree').addEventListener('click', function () {
      if (S.discordLogin) { location.href = '/auth/discord?terms=1'; return; }
      if (window.mpsDemoDiscord) {
        $('#btn-agree').disabled = true;
        try { window.open('https://discord.com/oauth2/authorize?client_id=1559004196303278140&response_type=code&redirect_uri=https%3A%2F%2Fdiscord.gg%2FmrJNh7rZJC&scope=identify', '_blank', 'noopener'); } catch (e) {}
        window.mpsDemoDiscord().then(function (res) {
          resetData(); S.me = res.user; current = 'home';
          try { history.replaceState(null, '', '#home'); } catch (e) {}
          renderAll(); window.scrollTo(0, 0); loadTickets();
        }).then(function () { $('#btn-agree').disabled = false; });
        return;
      }
      toast('O login com Discord ainda não está disponível.');
    });
    $('#btn-staff').addEventListener('click', openStaff);
    $('#btn-staff-entry').addEventListener('click', openStaff);
    $('#staff-cancel').addEventListener('click', closeStaff);
    $('#staff-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (S.sending) return;
      var pass = $('#staff-pass').value, err = $('#staff-err');
      if (!pass.trim()) { err.textContent = 'Digite a senha.'; return; }
      S.sending = true; $('#staff-send').disabled = true; err.textContent = '';
      api('/api/staff', { method: 'POST', body: { password: pass } }).then(function (res) {
        resetData(); S.me = res.user; current = 'home';
        try { history.replaceState(null, '', '#home'); } catch (e) {}
        closeStaff(); renderAll(); window.scrollTo(0, 0); loadTickets(); toast('Você entrou como Staff.');
      }).catch(function (e) { err.textContent = errText(e); $('#staff-pass').select(); })
        .then(function () { S.sending = false; $('#staff-send').disabled = false; });
    });

    $('#btn-new').addEventListener('click', function () {
      S.composing = true; S.selected = null; S.cur = null; S.msgs = []; S.sig = '';
      renderSupport(); $('#new-subject').focus();
    });
    ['#new-cancel', '#new-back'].forEach(function (s) { $(s).addEventListener('click', closePane); });
    $('#th-back').addEventListener('click', closePane);
    document.querySelectorAll('.tab').forEach(function (b) {
      b.addEventListener('click', function () { S.filter = b.getAttribute('data-f'); renderSupport(); });
    });

    $('#pane-new').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (S.sending) return;
      var subject = $('#new-subject').value.trim(), text = $('#new-text').value.trim();
      if (!subject || !text) { toast('Preencha o assunto e a mensagem.'); return; }
      S.sending = true; $('#new-send').disabled = true;
      api('/api/tickets', { method: 'POST', body: { subject: subject, text: text } }).then(function (res) {
        $('#new-subject').value = ''; $('#new-text').value = '';
        S.filter = 'open';
        S.tickets = [res.ticket].concat(S.tickets.filter(function (t) { return t.id !== res.ticket.id; }));
        S.ticketsSig = '';
        openTicket(res.ticket.id);
        loadTickets();
      }).catch(function (e) { toast(errText(e)); })
        .then(function () { S.sending = false; $('#new-send').disabled = false; });
    });

    var input = $('#msg-input');
    function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('#composer').requestSubmit(); }
    });
    $('#composer').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var id = S.selected, text = input.value.trim();
      if (!id || !text || S.sending) return;
      S.sending = true; $('#msg-send').disabled = true;
      api('/api/tickets/' + id + '/messages', { method: 'POST', body: { text: text } }).then(function () {
        input.value = ''; autosize();
        return Promise.all([loadThread(), loadTickets()]);
      }).catch(function (e) { toast(errText(e)); })
        .then(function () { S.sending = false; $('#msg-send').disabled = false; input.focus(); });
    });
    $('#th-toggle').addEventListener('click', function () {
      var t = findTicket(S.selected) || S.cur; if (!t) return;
      api('/api/tickets/' + t.id + '/status', { method: 'POST', body: { status: t.status === 'open' ? 'closed' : 'open' } })
        .then(function () { return Promise.all([loadThread(), loadTickets()]); })
        .catch(function (e) { toast(errText(e)); });
    });
    $('#ann-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (S.sending) return;
      var t = $('#ann-title').value.trim(), x = $('#ann-text').value.trim(), err = $('#ann-err');
      if (!t || !x) { err.textContent = errText({ code: 'missing_fields' }); return; }
      S.sending = true; $('#ann-send').disabled = true; err.textContent = '';
      api('/api/announcements', { method: 'POST', body: { title: t, text: x } }).then(function () {
        $('#ann-title').value = ''; $('#ann-text').value = ''; toast('Anúncio publicado.'); return loadAnn(true);
      }).catch(function (e) { err.textContent = errText(e); })
        .then(function () { S.sending = false; $('#ann-send').disabled = false; });
    });
    $('#btn-logout').addEventListener('click', function () {
      api('/api/logout', { method: 'POST', body: {} }).catch(function () {}).then(function () {
        current = 'home'; authLost();
        try { history.replaceState(null, '', '#home'); } catch (e) {}
      });
    });
  }

  /* ---------- início ---------- */
  function boot() {
    try { applyTheme(localStorage.getItem('mps-theme') || 'padrao', false); } catch (e) {}
    bind();
    show(initialView());
    var q = location.search;
    if (q) { try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {} }
    api('/api/me').then(function (res) {
      S.me = res.user; S.ready = true; S.discordLogin = !!res.discordLogin;
      if (S.me && S.me.theme) applyTheme(S.me.theme, true);
      if (/discord=erro/.test(q)) { var w = /why=([a-z0-9_]+)/i.exec(q); toast('Não consegui entrar com o Discord. Tente de novo.' + (w ? ' (' + w[1] + ')' : '')); }
      renderAll();
      if (S.me) loadTickets();
    }).catch(function () { S.ready = true; renderAll(); });
    setInterval(function () {
      if (!S.me || document.hidden) return;
      loadTickets();
      if (S.selected && current === 'support') loadThread();
    }, 3000);
  }
  boot();
})();
