'use strict';
// ============================================================
// CANOE ARENA — DOM UI: lobby, HUD, shop, scoreboard, end screens
// ============================================================
import * as prof from './profile.js';
import { isMuted, SND } from './audio.js';

const $ = (id) => document.getElementById(id);

// mirrors server defs.js PHYS.shopDisabled — the shop and all purchased
// upgrades are OFF (user: "disable all shop features and any upgrades
// purchased through the shop"); the B key and the shop button are inert.
const SHOP_DISABLED = true;

export function initUI(actions) {
  const UI = {
    myId: -1, cls: 'razorfin', mode: 'ffa', map: 'lagoon', diff: 'med', tab: 'play',
    lobbyPlayers: [], hostId: -1, botTarget: 6, phase: 'lobby', sbBtn: false,
  };
  const el = {
    connecting: $('connecting'), menu: $('menu'), hud: $('hud'), shop: $('shop'),
    veil: $('veil'),
    scoreboard: $('scoreboard'), countdown: $('countdown'), death: $('death'),
    end: $('end'), toasts: $('toasts'), spectateBar: $('spectateBar'),
    connMsg: $('connMsg'), inpName: $('inpName'), lvlNum: $('lvlNum'), xpfill: $('xpfill'),
    classCards: $('classCards'), modeBtns: $('modeBtns'), mapBtns: $('mapBtns'),
    playerList: $('playerList'), btnStart: $('btnStart'), hostHint: $('hostHint'),
    botCount: $('botCount'), botMinus: $('botMinus'), botPlus: $('botPlus'),
    cosmWrap: $('cosmWrap'),
    hpFill: $('hpFill'), hpText: $('hpText'), shFill: $('shFill'), credits: $('credits'),
    scoreVal: $('scoreVal'), killsVal: $('killsVal'), wlevelVal: $('wlevelVal'), fireLine: $('fireLine'),
    abilityBtn: $('abilityBtn'), abilityName: $('abilityName'),
    abilityCdOverlay: $('abilityCdOverlay'), abilityCdText: $('abilityCdText'),
    btnBoost: $('btnBoost'), // was MISSING — the boost cd block gated on it never ran
    boostCdOverlay: $('boostCdOverlay'), boostCdText: $('boostCdText'),
    btnMuteT: $('btnMuteT'), btnShopT: $('btnShopT'), btnScoresT: $('btnScoresT'), lobbyCol: $('lobbyCol'),
    menuTabs: $('menuTabs'), tabPlay: $('tab-play'), tabStyle: $('tab-style'), lobbyEmpty: $('lobbyEmpty'),
    modeName: $('modeName'), timer: $('timer'), scoreCap: $('scoreCap'), leaderLine: $('leaderLine'),
    killfeed: $('killfeed'), crosshair: $('crosshair'), hitmarker: $('hitmarker'), msgs: $('msgs'),
    upgPopup: $('upgPopup'), diffBtns: $('diffBtns'),
  ctl: $('ctl'),
  zoneBanner: $('zoneBanner'), classListImgs: {},
    shopCreds: $('shopCreds'), shopBody: $('shopBody'), btnShopClose: $('btnShopClose'),
    pause: $('pause'), btnResume: $('btnResume'), btnQuit: $('btnQuit'), btnMute: $('btnMute'),
    sbTable: $('sbTable'), countTxt: $('countTxt'), countSub: $('countSub'),
    deathTxt: $('deathTxt'), endTitle: $('endTitle'), endResults: $('endResults'),
    xpGain: $('xpGain'), unlockBox: $('unlockBox'), btnAgain: $('btnAgain'),
    specName: $('specName'),
    // title view → lobby view (online-prep title screen)
    titleView: $('titleView'), btnCreate: $('btnCreate'), btnJoin: $('btnJoin'),
    btnPractice: $('btnPractice'), btnShopTitle: $('btnShopTitle'),
    hostPanel: $('hostPanel'), hostPanelHead: $('hostPanelHead'), hostPanelBody: $('hostPanelBody'),
    botsOnYes: $('botsOnYes'), botsOnNo: $('botsOnNo'), botsRow: $('botsRow'),
    practiceBanner: $('practiceBanner'),
    chatPanel: $('chatPanel'), chatHead: $('chatHead'), chatBody: $('chatBody'),
    chatMsgs: $('chatMsgs'), chatInput: $('chatInput'), chatSend: $('chatSend'),
    btnStyle: $('btnStyle'), btnMenu: $('btnMenu'), btnLogout: $('btnLogout'),
    previewPop: $('previewPop'), previewCv: $('previewCv'), previewName: $('previewName'),
    statDmg: $('statDmg'), statSpd: $('statSpd'), statCanoe: $('statCanoe'),
    // login screen
    login: $('login'), loginUser: $('loginUser'), loginPass: $('loginPass'), loginErr: $('loginErr'), btnLogin: $('btnLogin'),
    // style & cosmetics overlay (over the lobby window)
    cosmOverlay: $('cosmOverlay'), cosmCv: $('cosmCv'), cosmPreviewHint: $('cosmPreviewHint'),
    btnCosmApply: $('btnCosmApply'), btnCosmCancel: $('btnCosmCancel'),
  };

  // ---------- lobby ----------
  function refreshProfile() {
    const p = prof.getProfile();
    const lv = prof.levelFromXp(p.xp);
    el.lvlNum.textContent = lv.level;
    el.xpfill.style.width = (lv.into / lv.need * 100) + '%';
    if (document.activeElement !== el.inpName) el.inpName.value = p.name;
  }

  function buildClassCards(defs) {
    el.classCards.innerHTML = '';
    for (const c of Object.values(defs.CLASSES)) {
      const card = document.createElement('div');
      card.className = 'classcard' + (c.id === UI.cls ? ' sel' : '');
      // CARD-SHAPED PICTURE of the weapon + the canoe's name — no swatches,
      // no icons, no color blocking (user: "card shaped picture of the weapon")
      let gunImg = '';
      try { if (actions.weaponImage) gunImg = `<img class="cc-card" src="${actions.weaponImage(c)}" alt="${c.name}">`; } catch (e) { }
      card.innerHTML = `${gunImg}<span class="cc-name">${c.name}</span>`;
      card.onclick = () => { UI.cls = c.id; actions.selectClass(c.id); buildClassCards(defs); SND.select ? SND.select() : SND.click(); };
      // hover → short VIDEO CLIP of the canoe firing its gun (live loop)
      let clipRAF = null, clipDef = null;
      card.onmouseenter = () => {
        if (!actions.clipFrame || !el.previewPop) return;
        clipDef = c;
        const r = card.getBoundingClientRect();
        el.previewPop.style.left = Math.min(window.innerWidth - 292, r.right + 14) + 'px';
        el.previewPop.style.top = Math.max(8, r.top) + 'px';
        el.previewName.textContent = c.name + ' — ' + (c.w1 ? c.w1.name : 'cannon');
        // quick-look stats: base weapon damage / projectile speed / canoe speed
        const t0tier = c.w1 && c.w1.tiers ? c.w1.tiers[0] : null;
        if (el.statDmg) el.statDmg.textContent = t0tier ? String(t0tier.dmg || 0) : '—';
        if (el.statSpd) el.statSpd.textContent = t0tier ? String(t0tier.spd || 0) : '—';
        if (el.statCanoe) el.statCanoe.textContent = c.speed ? String(c.speed) : '—';
        el.previewPop.classList.remove('hidden');
        const t0 = performance.now();
        const loop = () => {
          if (clipDef !== c) return;
          try { actions.clipFrame(c, (performance.now() - t0) / 1000, el.previewCv); } catch (e) { }
          clipRAF = requestAnimationFrame(loop);
        };
        clipRAF = requestAnimationFrame(loop);
      };
      card.onmouseleave = () => {
        clipDef = null;
        if (clipRAF) cancelAnimationFrame(clipRAF);
        clipRAF = null;
        if (el.previewPop) el.previewPop.classList.add('hidden');
      };
      el.classCards.appendChild(card);
    }
  }

  function buildModeBtns(defs) {
    el.modeBtns.innerHTML = '';
    for (const m of Object.values(defs.MODES)) {
      const b = document.createElement('button');
      b.className = 'btn modebtn' + (m.id === UI.mode ? ' on' : '');
      b.textContent = m.name; // no icons in window text blocks
      b.title = m.desc || m.name; // hover tooltip explains the game mode
      b.onclick = () => { UI.mode = m.id; actions.setMode(m.id); buildModeBtns(defs); };
      el.modeBtns.appendChild(b);
    }
  }

  function buildMapBtns(defs) {
    el.mapBtns.innerHTML = '';
    for (const mp of Object.values(defs.MAPS)) {
      const b = document.createElement('button');
      b.className = 'btn modebtn' + (mp.id === UI.map ? ' on' : '');
      b.textContent = mp.name; // no icons in window text blocks
      b.onclick = () => { UI.map = mp.id; actions.setMap(mp.id); buildMapBtns(defs); };
      el.mapBtns.appendChild(b);
    }
  }

  // BOT DIFFICULTY — low/med/high decides how well the bots aim and pursue
  const DIFF_LABELS = { low: '🐣 LOW', med: '⚔️ MEDIUM', high: '🎯 HIGH' };
  function buildDiffBtns() {
    el.diffBtns.innerHTML = '';
    for (const d of ['low', 'med', 'high']) {
      const b = document.createElement('button');
      b.className = 'btn modebtn' + (d === UI.diff ? ' on' : '');
      b.textContent = DIFF_LABELS[d];
      b.onclick = () => { UI.diff = d; actions.setDiff(d); buildDiffBtns(); };
      el.diffBtns.appendChild(b);
    }
  }

  function cosSection(title, list, kind, selKey, isPaint, selId) {
    let html = `<div class="sec-title">${title}</div><div class="cosrow">`;
    for (const it of list) {
      const unlocked = prof.isUnlocked(it);
      const sel = selId === it.id;
      // figureheads show their PICTURE; flags and trails show the icon ON the
      // base color — matching the in-game assets (flag = colored cloth +
      // design; trail = icon pixels + tinted wake). Paints stay color tiles.
      let inner = '', style = '';
      if (isPaint) { style = `background:${it.color};`; }
      else if (kind === 'flag' || kind === 'trail') {
        style = it.color ? `background:${it.color};` : '';
        inner = it.icon;
      }
      else { inner = it.icon || (it.name || '?').charAt(0).toUpperCase(); }
      html += `<div class="cositem ${isPaint ? 'paint' : ''} ${sel ? 'sel' : ''} ${unlocked ? '' : 'locked'}"
        title="${it.name}${unlocked ? '' : ' — level ' + it.lvl}" style="${style}"
        data-k="${selKey}" data-id="${it.id}" data-unlocked="${unlocked ? 1 : 0}">${inner}</div>`;
    }
    html += '</div>';
    return html;
  }

  // ---- STYLE & COSMETICS OVERLAY ----
  // staged = the working selection (committed on APPLY, discarded on CANCEL);
  // hovered = what the preview canvas shows (hover previews, click pins).
  const cosmState = { open: false, staged: null, hovered: null };
  let cosmRAF = null;

  function cosmPreviewShow() {
    if (!actions.cosmeticPreview || !el.cosmCv) return;
    const defs = actions.getDefs();
    const clsDef = defs && defs.CLASSES[UI.cls];
    if (!clsDef) return;
    try { actions.cosmeticPreview(clsDef, cosmState.hovered || cosmState.staged, el.cosmCv); } catch (e) { }
  }

  // the preview spins CONSTANTLY while the overlay is open (the rotation is
  // wall-clock driven in the renderer, so hover changes only swap the
  // cosmetics — the spin never restarts or stalls)
  function cosmStartLoop() {
    if (cosmRAF) return;
    const tick = () => {
      if (!cosmState.open) { cosmRAF = null; return; }
      cosmPreviewShow();
      cosmRAF = requestAnimationFrame(tick);
    };
    cosmRAF = requestAnimationFrame(tick);
  }
  function cosmStopLoop() {
    if (cosmRAF) { cancelAnimationFrame(cosmRAF); cosmRAF = null; }
  }

  function buildCosmetics() {
    if (!el.cosmWrap) return;
    const sel = cosmState.staged || prof.getProfile().sel;
    let html = '';
    html += cosSection('HULL PAINT', prof.PAINTS, 'paint', 'paint', true, sel.paint);
    html += cosSection('FIGUREHEAD', prof.FIGUREHEADS, 'fh', 'figurehead', false, sel.figurehead);
    html += cosSection('FLAG', prof.FLAGS, 'flag', 'flag', false, sel.flag);
    html += cosSection('WAKE TRAIL', prof.TRAILS, 'trail', 'trail', false, sel.trail);
    el.cosmWrap.innerHTML = html;
    el.cosmWrap.querySelectorAll('.cositem').forEach(c => {
      const k = c.dataset.k, id = c.dataset.id;
      c.onmouseenter = () => {
        if (!c.dataset.unlocked) return;
        cosmState.hovered = { ...(cosmState.staged || prof.getProfile().sel), [k]: id };
        cosmPreviewShow();
      };
      c.onmouseleave = () => {
        cosmState.hovered = null;
        if (cosmState.open) cosmPreviewShow();
      };
      c.onclick = () => {
        if (!c.dataset.unlocked) { toast(`🔒 Unlocks at level ${c.title.split('level ')[1] || '?'}`); return; }
        cosmState.staged = { ...(cosmState.staged || prof.getProfile().sel), [k]: id };
        cosmState.hovered = { ...cosmState.staged };
        buildCosmetics(); // move the .sel highlight
        cosmPreviewShow();
      };
    });
  }

  function openCosmetics() {
    if (!el.cosmOverlay) return;
    cosmState.open = true;
    cosmState.staged = { ...prof.getProfile().sel };
    cosmState.hovered = null;
    buildCosmetics();
    cosmPreviewShow();
    el.cosmOverlay.classList.remove('hidden');
    cosmStartLoop(); // constant slow spin while the overlay is open
    if (SND.click) SND.click();
  }
  function closeCosmetics() {
    if (!el.cosmOverlay) return;
    cosmState.open = false;
    cosmState.staged = null;
    cosmState.hovered = null;
    cosmStopLoop();
    el.cosmOverlay.classList.add('hidden');
  }
  function applyCosmetics() {
    const staged = cosmState.staged;
    closeCosmetics();
    if (!staged) return;
    for (const k of ['paint', 'figurehead', 'flag', 'trail']) {
      if (staged[k] && staged[k] !== prof.getProfile().sel[k]) prof.setCosmetic(k, staged[k]);
    }
    actions.cosmeticChanged();
    if (SND.buy) SND.buy();
  }

  function renderLobby(lobby) {
    UI.lobbyPlayers = lobby.players;
    UI.hostId = lobby.host;
    UI.botTarget = lobby.bots;
    UI.mode = lobby.mode; UI.map = lobby.map; UI.diff = lobby.diff || 'med';
    el.playerList.innerHTML = '';
    for (const p of lobby.players) {
      const defs = actions.getDefs();
      const cls = defs && defs.CLASSES[p.c];
      const row = document.createElement('div');
      row.className = 'prow' + (p.i === UI.myId ? ' me' : '');
      row.innerHTML = `
        <span class="dot" style="background:${cls ? cls.paint : '#888'}"></span>
        <span class="pname">${p.n} ${p.i === UI.hostId ? '<span class="hoststar">★</span>' : ''}</span>
        <span class="pclass">${cls ? cls.name : ''}</span>
        ${p.b ? '<span class="pbot">BOT</span>' : ''}`;
      el.playerList.appendChild(row);
    }
    el.botCount.textContent = UI.botTarget;
    // host-only settings panel + practice banner + Add-Bots state
    const isHost = UI.myId === lobby.host;
    if (el.hostPanel) el.hostPanel.classList.toggle('hidden', !isHost);
    el.hostHint.classList.toggle('hidden', isHost);
    if (el.practiceBanner) el.practiceBanner.classList.toggle('hidden', !lobby.practice);
    const botsOn = lobby.botsOn !== false;
    if (el.botsOnYes) { el.botsOnYes.classList.toggle('on', botsOn); el.botsOnNo.classList.toggle('on', !botsOn); }
    if (el.botsRow) el.botsRow.style.display = botsOn ? '' : 'none';
    if (lobby.chat) renderChatHistory(lobby.chat);
    updateLaunchButton(lobby.phase);
  }

  // ---- lobby chat (lobby-scoped; history arrives with the lobby message) ----
  let chatLen = -1, chatLast = '';
  function renderChatHistory(entries) {
    if (!el.chatMsgs) return;
    if (entries.length === chatLen && (entries.length === 0 || entries[entries.length - 1].m === chatLast)) return;
    chatLen = entries.length;
    chatLast = entries.length ? entries[entries.length - 1].m : '';
    el.chatMsgs.innerHTML = '';
    for (const e of entries) appendChat(e.n, e.m, false);
  }
  function appendChat(n, m, self) {
    if (!el.chatMsgs) return;
    const d = document.createElement('div');
    d.className = 'chat-msg' + (self ? ' me' : '');
    d.innerHTML = `<b>${n}:</b> ${m}`;
    el.chatMsgs.appendChild(d);
    el.chatMsgs.scrollTop = el.chatMsgs.scrollHeight;
  }

  // Launch button is phase-aware: JOIN LOBBY -> (joined) START MATCH / WAITING.
  // NOT joined = always JOIN LOBBY, even while a match runs in the background
  // (return-to-title → rejoin must work without a reload).
  function updateLaunchButton(phase) {
    const joined = UI.myId > 0;
    const isHost = joined && UI.myId === UI.hostId;
    if (!joined) {
      // the TITLE VIEW owns entry now (CREATE / JOIN / PRACTICE buttons);
      // the launch button only exists inside the lobby view
      el.btnStart.classList.add('hidden');
      el.hostHint.classList.add('hidden');
      return;
    }
    if (phase === 'countdown') {
      el.btnStart.classList.add('hidden');
      el.hostHint.classList.add('hidden');
      return;
    }
    if (phase === 'play') {
      // the host can force a FRESH match from a running game
      // (return-to-title → rejoin → start new, no reload needed)
      if (isHost) {
        el.btnStart.classList.remove('hidden');
        el.btnStart.textContent = '🔄 START NEW MATCH';
        el.btnStart.className = 'btn start';
        el.btnStart.onclick = () => actions.startMatch();
        el.hostHint.classList.add('hidden');
      } else {
        el.btnStart.classList.add('hidden');
        el.hostHint.classList.add('hidden');
      }
      return;
    }
    el.btnStart.classList.remove('hidden');
    if (isHost) {
      el.btnStart.textContent = `⚓ START MATCH (${UI.lobbyPlayers.length} crew)`;
      el.btnStart.className = 'btn start';
      el.btnStart.onclick = () => actions.startMatch();
      el.hostHint.classList.add('hidden');
    } else {
      el.btnStart.textContent = '⏳ WAITING FOR HOST…';
      el.btnStart.className = 'btn start off';
      el.btnStart.onclick = null;
      el.hostHint.classList.remove('hidden');
    }
  }

  function showMenu(defs) {
    el.connecting.classList.add('hidden');
    el.menu.classList.remove('hidden');
    el.hud.classList.add('hidden');
    el.shop.classList.add('hidden');
    el.end.classList.add('hidden');
    el.death.classList.add('hidden');
    el.countdown.classList.add('hidden');
    refreshProfile();
    buildClassCards(defs);
    buildModeBtns(defs);
    buildMapBtns(defs);
    buildDiffBtns();
    buildCosmetics();
  }

  // ---------- login screen (persistent profiles) ----------
  function showLogin() {
    if (!el.login) return;
    el.login.classList.remove('hidden');
    if (el.loginErr) el.loginErr.textContent = '';
    if (el.loginUser) setTimeout(() => el.loginUser.focus(), 50);
  }
  function hideLogin() {
    if (!el.login) return;
    el.login.classList.add('hidden');
    if (el.loginPass) el.loginPass.value = '';
  }

  // ---------- left panel combat row (replaces the old tip sheet) ----------
  // FIRE / SPECIAL / BOOST live together as one combat unit; the key labels
  // switch with the active device.
  function renderControlTips(dev) {
    if (el.btnFire) el.btnFire.querySelector('.k').textContent = dev === 'gamepad' ? 'RT' : 'LMB';
    if (el.abilityBtn) el.abilityBtn.querySelector('.k').textContent = dev === 'gamepad' ? 'LB' : 'RMB';
    if (el.btnBoost) el.btnBoost.querySelector('.k').textContent = dev === 'gamepad' ? 'RB' : 'SHIFT';
    try {
      const d = actions.getDefs();
      const ab = d && d.CLASSES && d.CLASSES[UI.cls] && d.CLASSES[UI.cls].ability;
      if (ab && el.abilityName) el.abilityName.textContent = ab.name;
    } catch { }
  }

  // ---------- HUD ----------
  function setZoneBanner(v) { /* banner notifications removed — killfeed only */ }
  function setHudVisible(v) { el.hud.classList.toggle('hidden', !v); }

  // ---------- tabbed menu navigation (PLAY / LOBBY / STYLE) ----------
  const TABS = ['play', 'lobby', 'style'];
  function switchTab(name) {
    UI.tab = name;
    if (el.menuTabs) el.menuTabs.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    if (el.tabPlay) el.tabPlay.classList.toggle('hidden', name !== 'play');
    if (el.lobbyCol) el.lobbyCol.classList.toggle('hidden', name !== 'lobby');
    if (el.tabStyle) el.tabStyle.classList.toggle('hidden', name !== 'style');
    // the LOBBY tab is only meaningful once joined — show its empty state
    if (el.lobbyEmpty) el.lobbyEmpty.classList.toggle('hidden', UI.myId > 0);
  }
  // the CANOE/CREW lobby column appears only after joining a lobby — and the
  // menu jumps to it so the player picks their canoe right away
  function setLobbyVisible(v) {
    if (v) switchTab('lobby');
    else if (UI.tab === 'lobby') switchTab('play');
  }
  function showPause() { el.pause.classList.remove('hidden'); }
  function hidePause() { el.pause.classList.add('hidden'); }

  // ---------- gamepad menu driver (lobby + pause) ----------
  const gpMenu = { row: 0, prev: { up: 0, down: 0, left: 0, right: 0, a: 0 } };
  const gpBtn = (gp, i) => gp && gp.buttons[i] ? (gp.buttons[i].pressed || gp.buttons[i].value > 0.5) : false;
  function gamepadMenuTick(gp, defs) {
    if (!gp) return;
    const p = gpMenu.prev;
    const up = gpBtn(gp, 12), down = gpBtn(gp, 13), left = gpBtn(gp, 14), right = gpBtn(gp, 15), a = gpBtn(gp, 0);
    const eUp = up && !p.up, eDown = down && !p.down, eLeft = left && !p.left, eRight = right && !p.right, eA = a && !p.a;
    Object.assign(p, { up, down, left, right, a });
    const pauseOpen = !el.pause.classList.contains('hidden');
    if (pauseOpen) {
      const btns = [el.btnResume, el.btnQuit, el.btnMute];
      if (eUp) gpMenu.row = (gpMenu.row + btns.length - 1) % btns.length;
      if (eDown) gpMenu.row = (gpMenu.row + 1) % btns.length;
      if (eA) btns[gpMenu.row].click();
      return;
    }
    if (el.menu.classList.contains('hidden')) return;
    // tab row + per-tab rows: PLAY [tab, mode, map, bots, diff, launch] ·
    // LOBBY [tab, canoe, launch] · STYLE [tab, cosmetics, launch]
    const rows = UI.tab === 'play' ? 6 : 3;
    if (eUp) gpMenu.row = (gpMenu.row + rows - 1) % rows;
    if (eDown) gpMenu.row = (gpMenu.row + 1) % rows;
    const clsIds = Object.keys(defs.CLASSES), modeIds = Object.keys(defs.MODES), mapIds = Object.keys(defs.MAPS);
    if (gpMenu.row === 0 && (eLeft || eRight)) {
      switchTab(TABS[(TABS.indexOf(UI.tab) + (eRight ? 1 : -1) + TABS.length) % TABS.length]);
    } else if (UI.tab === 'play') {
      if (gpMenu.row === 1 && (eLeft || eRight)) {
        UI.mode = modeIds[(modeIds.indexOf(UI.mode) + (eRight ? 1 : -1) + modeIds.length) % modeIds.length];
        actions.setMode(UI.mode); buildModeBtns(defs);
      } else if (gpMenu.row === 2 && (eLeft || eRight)) {
        UI.map = mapIds[(mapIds.indexOf(UI.map) + (eRight ? 1 : -1) + mapIds.length) % mapIds.length];
        actions.setMap(UI.map); buildMapBtns(defs);
      } else if (gpMenu.row === 3 && eRight) actions.setBots(Math.min(8, UI.botTarget + 1));
      else if (gpMenu.row === 3 && eLeft) actions.setBots(Math.max(2, UI.botTarget - 1));
      else if (gpMenu.row === 4 && (eLeft || eRight)) {
        const diffs = ['low', 'med', 'high'];
        UI.diff = diffs[(diffs.indexOf(UI.diff) + (eRight ? 1 : -1) + diffs.length) % diffs.length];
        actions.setDiff(UI.diff); buildDiffBtns();
      }
      if (eA && gpMenu.row === 5) el.btnStart.click();
    } else if (UI.tab === 'lobby') {
      if (gpMenu.row === 1 && (eLeft || eRight)) {
        UI.cls = clsIds[(clsIds.indexOf(UI.cls) + (eRight ? 1 : -1) + clsIds.length) % clsIds.length];
        actions.selectClass(UI.cls); buildClassCards(defs);
      }
      if (eA && gpMenu.row === 2) el.btnStart.click();
    } else {
      // STYLE tab: cycle the hull paint
      if (gpMenu.row === 1 && (eLeft || eRight)) {
        const p = prof.getProfile();
        const paints = prof.PAINTS.filter(x => prof.isUnlocked(x));
        if (paints.length) {
          const cur = paints.findIndex(x => x.id === p.sel.paint);
          const next = paints[(cur + (eRight ? 1 : -1) + paints.length) % paints.length];
          prof.setCosmetic('paint', next.id);
          actions.cosmeticChanged();
        }
      }
      if (eA && gpMenu.row === 2) el.btnStart.click();
    }
    const hlMap = UI.tab === 'play'
      ? [el.titleView, el.modeBtns, el.mapBtns, el.botMinus.parentElement, el.diffBtns, el.btnStart]
      : UI.tab === 'lobby'
        ? [el.titleView, el.classCards, el.btnStart]
        : [el.titleView, el.cosmWrap, el.btnStart];
    const hl = hlMap[gpMenu.row];
    el.classCards.parentElement.querySelectorAll('.gpFocus').forEach(x => x.classList.remove('gpFocus'));
    if (hl) hl.classList.add('gpFocus');
  }

  // HUD write cache: updateHud runs every frame — write to the DOM only when
  // a value actually changed. The cooldown conic-gradient sweep legitimately
  // changes every frame while cooling; quantize it to 0.1 steps (~10 writes/s)
  // so it animates smoothly without rebuilding the gradient 60×/s.
  const _last = {};
  function _setTxt(key, el, val) {
    const v = String(val);
    if (_last[key] === v) return;
    _last[key] = v;
    el.textContent = v;
  }
  function _setAttr(key, el, attr, val) {
    const v = String(val);
    if (_last[key] === v) return;
    _last[key] = v;
    el.setAttribute(attr, v);
  }
  function _setStyle(key, el, prop, val) {
    if (_last[key] === val) return;
    _last[key] = val;
    el.style[prop] = val;
  }
  function _toggle(key, el, cls, on) {
    if (_last[key] === on) return;
    _last[key] = on;
    el.classList.toggle(cls, on);
  }

  function updateHud(own, snap, defs) {
    if (!own || !snap) return;
    const pct = Math.max(0, own.hp / own.maxHp);
    _setStyle('hpw', el.hpFill, 'width', (pct * 100) + '%');
    _toggle('hplow', el.hpFill, 'low', pct < 0.3);
    _setTxt('hpt', el.hpText, `${Math.ceil(own.hp)} / ${own.maxHp}`);
    // shield — a blue OVERLAY BAR on top of the health bar (width = shield pct)
    if (el.shFill) {
      const shPct = Math.max(0, Math.min(1, (own.sh || 0) / 60)); // PHYS.shieldMax
      _setStyle('shw', el.shFill, 'width', (shPct * 100) + '%');
    }
    if (el.credits) _setTxt('cr', el.credits, '💰 ' + own.credits);
    const cls = defs.CLASSES[own.cls];
    // left panel: SCORE + KILLS + weapon LEVEL (no weapon names, no icons)
    if (el.scoreVal) _setTxt('sc', el.scoreVal, own.score || 0);
    if (el.killsVal) _setTxt('kl', el.killsVal, own.kills || 0);
    if (el.wlevelVal) _setTxt('wl', el.wlevelVal, `Level ${own.u1 || 0}`);
    // special ability (RMB / FIRE2) — WoW-style cooldown: sweeping dark
    // overlay + countdown; the ability name rides in the button tooltip
    if (el.abilityBtn) {
      const cd = own.abilityCd || 0;
      const total = cls.ability.cd || 1;
      _setAttr('abttl', el.abilityBtn, 'title', `${cls.ability.name} — ${cls.ability.charges ? cls.ability.charges + ' charges, ' : ''}${cls.ability.cd}s special`);
      _toggle('abcd', el.abilityBtn, 'cd', cd > 0);
      if (el.abilityCdOverlay) {
        const frac = cd > 0 ? Math.max(0, Math.min(1, cd / total)) : 0;
        const fracQ = Math.round(frac * 10) / 10;
        _setStyle('abco', el.abilityCdOverlay, 'background', cd > 0
          ? `conic-gradient(rgba(0,0,0,.78) ${(1 - fracQ) * 360}deg, transparent ${(1 - fracQ) * 360}deg)`
          : 'transparent');
      }
      // ready state shows the charge count (MINE LAYER), cooling shows the
      // countdown — the charge badge lives in the same corner slot
      _setTxt('abct', el.abilityCdText, cd > 0 ? Math.ceil(cd) : (cls.ability.charges && own.ch > 0 ? String(own.ch) : ''));
    }
    // boost — same WoW-style cooldown sweep + countdown as the special
    if (el.btnBoost) {
      const bcd = own.boostCd || 0;
      const btotal = cls.boostCd || 5;
      const cooling = bcd > 0 && !(own.boostT > 0);
      _toggle('btcd', el.btnBoost, 'cd', cooling);
      _toggle('bton', el.btnBoost, 'on', (own.boostT || 0) > 0);
      if (el.boostCdOverlay) {
        const frac = cooling ? Math.max(0, Math.min(1, bcd / btotal)) : 0;
        const fracQ = Math.round(frac * 10) / 10;
        _setStyle('btco', el.boostCdOverlay, 'background', cooling
          ? `conic-gradient(rgba(0,0,0,.78) ${(1 - fracQ) * 360}deg, transparent ${(1 - fracQ) * 360}deg)`
          : 'transparent');
      }
      if (el.boostCdText) _setTxt('btct', el.boostCdText, cooling ? Math.ceil(bcd) : '');
    }
    // mode + timer
    const mode = defs.MODES[snap.mode];
    _setTxt('mode', el.modeName, `${mode.icon} ${mode.name}`);
    const t = snap.tm;
    _setTxt('tm', el.timer, `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
    _setTxt('cap', el.scoreCap, snap.sc ? `FIRST TO ${snap.sc} PTS` : 'LAST CANOE STANDING');
    if (snap.ldr) {
      const l = snap.ps.find(p => p.i === snap.ldr);
      _setTxt('ldr', el.leaderLine, l ? `👑 ${l.n} — ${l.sc} pts` : '');
    }
  }

  // ---------- shop ----------
  function renderShop(own, defs) {
    if (!own || !defs) return;
    el.shopCreds.textContent = '💰 ' + own.credits + ' booty';
    const cls = defs.CLASSES[own.cls];
    let html = '';
    for (const [key, name] of [['w1', 'PRIMARY'], ['w2', 'SECONDARY'], ['hull', 'HULL']]) {
      const track = cls[key];
      const cur = own.w[key === 'w1' ? 0 : key === 'w2' ? 1 : 2];
      const tiers = track.tiers;
      const next = tiers[cur + 1];
      let pips = '';
      for (let i = 0; i < tiers.length; i++) {
        pips += `<div class="sc-pip ${i < cur ? 'owned' : i === cur ? 'next' : ''}"></div>`;
      }
      html += `<div class="shopcard">
        <h3>${track.icon} ${track.name} — ${track.desc}</h3>
        <div class="sc-track">${pips}</div>
        <div class="sc-tier">${tiers[cur].n}</div>
        <div class="sc-desc">${tiers[cur].desc || ''}</div>
        ${next ? `<div class="sc-next">NEXT: ${next.n} — ${next.desc || ''}</div>
          <div class="sc-cost">${next.cost} booty</div>
          <button class="btn shopbtn" data-track="${key}">UPGRADE ${next.cost}💰</button>`
        : `<div class="sc-next">MAXED OUT 💪</div>`}
      </div>`;
    }
    el.shopBody.innerHTML = html;
    el.shopBody.querySelectorAll('.shopbtn').forEach(b => {
      b.onclick = () => actions.buy(b.dataset.track);
    });
  }

  // ---------- misc ----------
  let upgPopupT = 0;
  function killfeed(k) {
    const defs = actions.getDefs();
    if (!defs) return;
    const nm = (id) => { const p = k.ps && k.ps.find(x => x.i === id); return p ? p.n : '?'; };
    const div = document.createElement('div');
    div.className = 'kf-item';
    if (k.a) div.innerHTML = `🤝 <b>${nm(k.k)}</b> assisted sinking <b>${nm(k.v)}</b>${k.u ? ` <span class="wk">⬆UPG ${k.u}</span>` : ''}`;
    else if (k.k === -1) div.innerHTML = `🌊 <b>${nm(k.v)}</b> was claimed by <span class="wk">${k.w}</span>`;
    else div.innerHTML = `☠ <b>${nm(k.k)}</b> <span class="wk">${k.w}</span> → <b>${nm(k.v)}</b>${k.s > 1 ? ` <span class="wk">×${k.s} streak!</span>` : ''}${k.u ? ` <span class="wk">⬆UPG ${k.u}</span>` : ''}`;
    el.killfeed.prepend(div);
    while (el.killfeed.children.length > 5) el.killfeed.lastChild.remove();
    setTimeout(() => { if (div.parentNode) div.remove(); }, 5000);
    // FANFARE popup on the PLAYER'S OWN kills (never bots/others) — the kill
    // registered a weapon upgrade, so celebrate it
    if (k.k === UI.myId && k.u > 0 && el.upgPopup) {
      const wname = k.w || 'weapon';
      el.upgPopup.querySelector('.upg-weapon').textContent =
        `${wname} ⬆ LEVEL ${k.u}${k.s > 1 ? ' — ×' + k.s + ' STREAK!' : ''}`;
      el.upgPopup.classList.remove('hidden');
      clearTimeout(upgPopupT);
      upgPopupT = setTimeout(() => el.upgPopup.classList.add('hidden'), 2700);
    }
  }

  function toast(msg) {
    if (!el.toasts) return; // notifications removed — killfeed is the feed now
    const div = document.createElement('div');
    div.className = 'toast';
    div.textContent = msg;
    el.toasts.appendChild(div);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 3200);
  }

  function msg(text, ms = 2600) {
    const d = document.createElement('div');
    d.className = 'msg';
    d.textContent = text;
    el.msgs.appendChild(d);
    setTimeout(() => d.remove(), ms);
  }

  function countdown(n, sub) {
    el.countdown.classList.remove('hidden');
    el.countTxt.textContent = n;
    el.countSub.textContent = sub;
    if (n && n.startsWith('GO')) { // matches 'GO' and 'GO!'
      setTimeout(() => el.countdown.classList.add('hidden'), 800);
    }
  }

  function showDeath(text) {
    el.death.classList.remove('hidden');
    el.deathTxt.textContent = text;
  }
  function hideDeath() { el.death.classList.add('hidden'); }

  function showSpectate(name) {
    el.spectateBar.classList.remove('hidden');
    el.specName.textContent = name;
  }
  function hideSpectate() { el.spectateBar.classList.add('hidden'); }

  function showScoreboard(rows) {
    el.scoreboard.classList.remove('hidden');
    let html = '<tr><th>#</th><th>PILOT</th><th>CLASS</th><th>SCORE</th><th>KILLS</th><th>DEATHS</th><th>💰</th><th>HP</th></tr>';
    rows.forEach((r, i) => {
      html += `<tr class="${r.i === UI.myId ? 'me' : ''} ${i === 0 && rows.length > 1 ? 'leader' : ''}">
        <td>${i + 1}</td><td>${r.n}${r.al ? '' : ' 💀'}</td><td>${r.c}</td>
        <td>${r.sc}</td><td>${r.k}</td><td>${r.d}</td><td>${r.cr}</td><td>${r.al ? Math.ceil(r.hp) : '—'}</td></tr>`;
    });
    el.sbTable.innerHTML = html;
  }
  function hideScoreboard() { el.scoreboard.classList.add('hidden'); }

  function showEnd(results, xpInfo, myRank, win) {
    el.end.classList.remove('hidden');
    el.endTitle.textContent = win ? '🏆 VICTORY!' : '🏁 MATCH OVER';
    let html = '';
    results.forEach((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      html += `<div class="rankrow"><span class="rk">${medal}</span>
        <span class="rkname">${r.n}${r.i === UI.myId ? ' (you)' : ''}</span>
        <span class="rkclass">${r.c}</span>
        <span class="rkscore">${r.sc} pts · ${r.k} kills</span></div>`;
    });
    el.endResults.innerHTML = html;
    el.xpGain.textContent = xpInfo ? `+${xpInfo.xp} XP earned (base ${xpInfo.base} + kills ${xpInfo.kxp} + ${xpInfo.win ? 'win 120' : 'rank ' + xpInfo.rkxp})` : '';
    if (xpInfo && xpInfo.unlocks.length) {
      el.unlockBox.innerHTML = xpInfo.unlocks.map(u => `<span class="unlock-chip">🔓 ${u.icon || '🎨'} ${u.name} unlocked!</span>`).join('');
    } else el.unlockBox.innerHTML = '';
  }
  function hideEnd() { el.end.classList.add('hidden'); el.unlockBox.innerHTML = ''; }

  function hitmark() {
    el.hitmarker.classList.remove('show');
    void el.hitmarker.offsetWidth;
    el.hitmarker.classList.add('show');
  }

  // ---- AA scene transition: fade the veil in, swap the UI underneath,
  // fade it out. Every screen-to-screen jump (play→end, end→lobby,
  // pause→title) funnels through here instead of popping instantly.
  let veilBusy = false;
  function transition(fn) {
    if (!el.veil) { fn(); return; }
    if (veilBusy) { fn(); return; } // mid-fade: just swap (never lose the action)
    veilBusy = true;
    el.veil.classList.add('on');
    setTimeout(() => {
      try { fn(); } catch (e) { console.log('transition cb failed:', e && e.message); }
      setTimeout(() => { el.veil.classList.remove('on'); veilBusy = false; }, 60);
    }, 380);
  }

  function setCrosshair(x, y) {
    el.crosshair.style.left = x + 'px';
    el.crosshair.style.top = y + 'px';
    el.hitmarker.style.left = x + 'px';
    el.hitmarker.style.top = y + 'px';
  }

  // ---------- events ----------
  el.inpName.addEventListener('input', () => prof.setName(el.inpName.value));
  // launch button is driven by updateLaunchButton() (phase-aware)
  el.botMinus.onclick = () => actions.setBots(Math.max(1, UI.botTarget - 1));
  el.botPlus.onclick = () => actions.setBots(Math.min(8, UI.botTarget + 1));
  el.btnShopClose.onclick = () => el.shop.classList.add('hidden');
  el.btnResume.onclick = () => actions.togglePause();
  el.btnQuit.onclick = () => actions.leaveMatch();
  el.btnMute.onclick = () => { actions.mute(); el.btnMute.textContent = isMuted() ? '🔇 UNMUTE' : '🔊 MUTE'; };
  el.btnAgain.onclick = () => {
    // AA transition: fade out the results, swap to the lobby underneath
    transition(() => { actions.toLobby(); hideEnd(); showMenu(actions.getDefs()); });
  };

  // left-panel toggle buttons (they're ALSO keyboard shortcuts)
  if (el.btnMuteT) el.btnMuteT.onclick = () => {
    actions.mute();
    el.btnMuteT.textContent = isMuted() ? '🔇 MUTED' : '🔊 MUTE';
    el.btnMuteT.classList.toggle('on', isMuted());
  };
  if (el.btnShopT) el.btnShopT.onclick = () => el.shop.classList.toggle('hidden');
  if (el.btnScoresT) el.btnScoresT.onclick = () => { UI.sbBtn = !UI.sbBtn; el.btnScoresT.classList.toggle('on', UI.sbBtn); };

  // title screen → lobby (CREATE / JOIN / PRACTICE / SHOP-disabled)
  if (el.btnCreate) el.btnCreate.onclick = () => actions.join('create');
  if (el.btnJoin) el.btnJoin.onclick = () => actions.join('join');
  if (el.btnPractice) el.btnPractice.onclick = () => actions.join('practice');
  // collapsible DOCKED windows: host settings (left), chat (right).
  // Collapsing hides the body — the labeled tab stays pinned to the screen edge.
  if (el.hostPanelHead) el.hostPanelHead.onclick = () => { el.hostPanel.classList.toggle('collapsed'); SND.click(); };
  if (el.chatHead) el.chatHead.onclick = () => { el.chatPanel.classList.toggle('collapsed'); SND.click(); };
  // STYLE & COSMETICS: an overlay window over the lobby (not a docked tab)
  if (el.btnStyle) el.btnStyle.onclick = () => openCosmetics();
  if (el.btnCosmApply) el.btnCosmApply.onclick = () => applyCosmetics();
  if (el.btnCosmCancel) el.btnCosmCancel.onclick = () => { closeCosmetics(); SND.click(); };
  // RETURN TO MAIN MENU: back to the title screen + leave any lobby
  if (el.btnMenu) el.btnMenu.onclick = () => actions.leaveMatch();
  // LOGIN — persistent profiles (new username = fresh account)
  const doLogin = () => {
    const u = el.loginUser ? el.loginUser.value : '';
    const p = el.loginPass ? el.loginPass.value : '';
    const res = prof.login(u, p);
    if (!res.ok) {
      if (el.loginErr) el.loginErr.textContent = res.error || 'Login failed';
      return;
    }
    hideLogin();
    refreshProfile();
    buildCosmetics();
    if (res.created) msg(`Welcome aboard, ${u}! New profile created.`);
    SND.go();
  };
  if (el.btnLogin) el.btnLogin.onclick = doLogin;
  if (el.loginPass) el.loginPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  if (el.loginUser) el.loginUser.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.loginPass.focus(); });
  if (el.btnLogout) el.btnLogout.onclick = () => {
    prof.logout();
    showLogin();
    refreshProfile();
    buildCosmetics();
    SND.click();
  };
  // Add Bots? Yes/No (host-only server-side; the panel is host-only client-side)
  if (el.botsOnYes) el.botsOnYes.onclick = () => actions.hostBotsOn(true);
  if (el.botsOnNo) el.botsOnNo.onclick = () => actions.hostBotsOn(false);
  // lobby chat send (click or Enter)
  const sendChat = () => {
    if (!el.chatInput) return;
    const t = el.chatInput.value.trim();
    if (!t) return;
    el.chatInput.value = '';
    actions.chat(t);
  };
  if (el.chatSend) el.chatSend.onclick = sendChat;
  if (el.chatInput) el.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  // title view ⇄ lobby view (the docked chat/style windows are lobby-only;
  // the host settings dock additionally needs renderLobby's host grant).
  // ALL THREE START COLLAPSED — just their labeled tabs attached to the main
  // window; clicking a tab's text expands/collapses its extension.
  function setJoinedView(joined) {
    if (el.titleView) el.titleView.classList.toggle('hidden', joined);
    el.lobbyCol.classList.toggle('hidden', !joined);
    if (el.chatPanel) { el.chatPanel.classList.toggle('hidden', !joined); if (joined) el.chatPanel.classList.add('collapsed'); }
    if (el.hostPanel && joined) el.hostPanel.classList.add('collapsed');
    updateLaunchButton('lobby');
  }

  // menu tabs: PLAY setup · LOBBY (after join) · STYLE cosmetics
  if (el.menuTabs) el.menuTabs.querySelectorAll('.tab').forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  document.addEventListener('keydown', (e) => {
    // typing in a form field must never trigger game shortcuts — Tab has to
    // move between the login inputs (user: "Tab button is not working to
    // logically switch between the username and password fields")
    const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.code === 'KeyB' && !SHOP_DISABLED && !typing) el.shop.classList.toggle('hidden');
    if (e.code === 'Tab' && !typing) { e.preventDefault(); }
    if (e.code === 'Escape' && !typing) actions.togglePause();
    if ((e.code === 'KeyN' || e.code === 'KeyM') && !typing) actions.spectateNext(e.code === 'KeyM' ? 1 : -1);
  });

  // init cosmetics interactions happen in buildCosmetics

  // initial launch-button state (pre-join: JOIN LOBBY)
  updateLaunchButton('lobby');

  return {
    UI, el,
    showMenu, setHudVisible, setZoneBanner, setLobbyVisible, setJoinedView, showPause, hidePause, gamepadMenuTick,
    switchTab, updateLaunchButton,
    renderControlTips,
    updateHud, renderLobby, renderShop,
    killfeed, toast, msg, countdown, showDeath, hideDeath,
    chatMsg: (n, m, self) => { appendChat(n, m, self); if (!self) { if (SND.chat) SND.chat(); } },
    showSpectate, hideSpectate, showScoreboard, hideScoreboard,
    showEnd, hideEnd, hitmark, setCrosshair, refreshProfile, buildCosmetics,
    transition, showLogin, hideLogin, openCosmetics, closeCosmetics,
    get shopOpen() { return !el.shop.classList.contains('hidden'); },
  };
}
