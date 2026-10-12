import { CATEGORIES, ALPHABET, POINTS, autoValid, emptyAnswers, firstLetter } from './engine.js';
import { createSession, normalizeCode } from './net.js';
import { VERSION } from './version.js';

const LABELS = { name: 'Name', place: 'Place', animal: 'Animal', food: 'Food', thing: 'Thing' };
const ICONS = { name: '🙋', place: '📍', animal: '🐾', food: '🍎', thing: '🧸' };
const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');

let session = null;
let myId = null;
let view = null;
let mode = null; // solo | host | client
let busy = false;
let draft = emptyAnswers();
let draftKey = null;
let deadline = null; // performance.now() timestamp, local clock only
let sendTimer = null;
let lastKey = null;

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: not worth surfacing */ } },
};

const home = {
  name: store.get('npa.name'),
  code: normalizeCode(new URLSearchParams(location.search).get('room')),
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const me = () => view?.players.find(p => p.id === myId);
const isHost = () => view && view.hostId === myId;
const playerName = id => view?.players.find(p => p.id === id)?.name ?? 'Someone';
const online = () => mode !== 'solo';

let toastTimer;
function toast(msg, kind = 'error') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

// ---------- session lifecycle ----------

async function begin(newMode) {
  const name = home.name.trim();
  if (!name) return toast('Enter your name first.');
  if (newMode === 'client' && normalizeCode(home.code).length < 4) return toast('Enter the room code from the host.');
  store.set('npa.name', name);
  busy = true;
  mode = newMode;
  render();
  session = createSession({
    mode: newMode,
    name,
    code: home.code,
    onState: (v, id) => { myId = id; onState(v); },
    onError: msg => toast(msg),
    onStatus: msg => { statusEl.textContent = msg; },
    onClosed: msg => { leave(); toast(msg); },
  });
  try {
    await session.start();
    if (newMode === 'host') history.replaceState(null, '', `?room=${session.code}`);
  } catch (e) {
    console.error(e);
    leave();
    toast(e.message);
  } finally {
    busy = false;
    render();
  }
}

function leave() {
  session?.close();
  session = null;
  view = null;
  mode = null;
  deadline = null;
  lastKey = null;
  statusEl.textContent = '';
  if (location.search && !home.code) history.replaceState(null, '', location.pathname);
  render();
}

function dispatch(action) {
  session?.dispatch(action);
}

function onState(v) {
  view = v;
  const key = `${v.phase}|${v.round}|${v.letter}`;
  if (v.phase === 'playing') {
    if (draftKey !== key) {
      draftKey = key;
      draft = { ...emptyAnswers(), ...(v.answers[myId] || {}) };
    }
    deadline = performance.now() + v.remainingMs;
  } else {
    deadline = null;
  }
  // Re-rendering the answer form on every peer update would fight the
  // keyboard on phones; only the progress panel needs refreshing.
  if (key === lastKey && v.phase === 'playing') updatePlaying();
  else render();
  lastKey = key;
}

// ---------- rendering ----------

function render() {
  const active = document.activeElement;
  const focusId = active?.id;
  const sel = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  app.innerHTML = !view ? renderHome() : ({
    lobby: renderLobby,
    picking: renderPicking,
    playing: renderPlaying,
    review: renderReview,
    over: renderOver,
  }[view.phase] || (() => ''))();

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch { /* number inputs */ }
    }
  }
  document.body.classList.toggle('at-home', !view);
  if (view?.phase === 'playing') updatePlaying();
}

function renderHome() {
  const dis = busy ? 'disabled' : '';
  const tiles = word => [...word].map((ch, i) =>
    `<span class="tile" style="--r:${((i * 37) % 9) - 4}deg">${ch}</span>`).join('');
  const joinFirst = !!home.code;
  const joinCard = `
      <div class="mode join ${joinFirst ? 'featured' : ''}">
        <span class="mode-icon" aria-hidden="true">🔗</span>
        <span class="mode-title">Join a game</span>
        <span class="mode-sub">Got a room code from a friend?</span>
        <div class="join-row">
          <input id="home-code" class="code-input" maxlength="8" autocapitalize="characters" autocomplete="off"
            value="${esc(home.code)}" placeholder="CODE" aria-label="Room code">
          <button class="btn primary" data-act="join" ${dis}>${busy && mode === 'client' ? '…' : 'Join'}</button>
        </div>
      </div>`;
  return `
  <section class="title-screen">
    <h1 class="logo" aria-label="Name Place Animal">
      <span class="tiles">${tiles('NAME')}</span>
      <span class="tiles">${tiles('PLACE')}</span>
      <span class="tiles">${tiles('ANIMAL')}</span>
    </h1>
    <p class="byline">by Fitz Joseph</p>
    <p class="cats" aria-label="Categories: Name, Place, Animal, Food, Thing">
      ${CATEGORIES.map(c => `<span class="cat">${ICONS[c]} ${LABELS[c]}</span>`).join('')}
    </p>
    <div class="spin-wrap" aria-hidden="true">
      <span class="spin-label">Your letter is…</span>
      <span class="tile spin" id="spin">A</span>
    </div>
  </section>

  <section class="card player-card">
    <span class="avatar lg" id="home-avatar" aria-hidden="true">${esc(home.name.trim()[0]?.toUpperCase() || '?')}</span>
    <label class="field grow">
      <span>Who's playing?</span>
      <input id="home-name" maxlength="20" autocomplete="nickname" value="${esc(home.name)}" placeholder="Enter your name">
    </label>
  </section>

  <section class="modes" aria-label="Choose a game mode">
    ${joinFirst ? joinCard : ''}
    <button class="mode" data-act="solo" ${dis}>
      <span class="mode-icon" aria-hidden="true">🎯</span>
      <span class="mode-title">Solo</span>
      <span class="mode-sub">Beat the clock and your best score</span>
    </button>
    <button class="mode" data-act="host" ${dis}>
      <span class="mode-icon" aria-hidden="true">📡</span>
      <span class="mode-title">${busy && mode === 'host' ? 'Opening room…' : 'Host a game'}</span>
      <span class="mode-sub">Create a room and share the code</span>
    </button>
    ${joinFirst ? '' : joinCard}
  </section>

  <details class="card rules">
    <summary>How to play</summary>
    <ol>
      <li>A letter is drawn at random, or chosen by a player (they take turns).</li>
      <li>Fill in a <b>Name</b>, <b>Place</b>, <b>Animal</b>, <b>Food</b> and <b>Thing</b> starting with that letter.</li>
      <li>The round ends when the timer runs out, or when someone with every column filled hits <b>STOP</b>.</li>
      <li>Everyone reviews the answers. An answer counts unless most of the other players reject it.</li>
      <li>Each accepted answer scores ${POINTS}. Highest total after the last round wins.</li>
    </ol>
  </details>`;
}

// Title-screen flourish: cycle the letter tile like a slot reel, pausing on
// each pick. Skipped entirely for reduced-motion users.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let spinTick = 0;
setInterval(() => {
  const el = document.getElementById('spin');
  if (!el || reducedMotion.matches) return;
  spinTick = (spinTick + 1) % 14;
  if (spinTick > 8) { el.classList.add('landed'); return; }
  el.classList.remove('landed');
  el.textContent = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}, 140);

function playersList() {
  return `<ul class="players">${view.players.map(p => `
    <li class="${p.connected ? '' : 'offline'}">
      <span class="avatar" aria-hidden="true">${esc(p.name[0]?.toUpperCase())}</span>
      <span class="pname">${esc(p.name)}${p.id === myId ? ' <em>(you)</em>' : ''}</span>
      ${p.id === view.hostId ? '<span class="tag">host</span>' : ''}
      ${p.connected ? '' : '<span class="tag dim">offline</span>'}
      <span class="score">${p.total}</span>
    </li>`).join('')}</ul>`;
}

function renderLobby() {
  const s = view.settings;
  const host = isHost();
  const code = session?.code;
  const link = code ? `${location.origin}${location.pathname}?room=${code}` : '';
  const dis = host ? '' : 'disabled';
  return `
  ${online() ? `
  <section class="card center">
    <p class="muted small">${host ? 'Share this code with your friends' : 'Room'}</p>
    ${code ? `<div class="room-code" aria-label="Room code">${esc(code)}</div>
      <div class="row gap center"><button class="btn small" data-act="copy" data-link="${esc(link)}">Copy invite link</button></div>`
      : '<p>Connected. Waiting for the host to start.</p>'}
  </section>` : ''}
  <div class="grid2">
    <section class="card">
      <h2>${online() ? `Players (${view.players.filter(p => p.connected).length})` : 'Player'}</h2>
      ${playersList()}
      ${online() && host && view.players.length < 2 ? '<p class="muted small">Waiting for others to join… You can also start alone.</p>' : ''}
    </section>
    <section class="card">
      <h2>Settings</h2>
      <div class="settings">
        <label class="field"><span>Seconds per round</span>
          <input id="set-seconds" type="number" min="15" max="600" step="15" value="${s.seconds}" ${dis}></label>
        <label class="field"><span>Rounds</span>
          <input id="set-rounds" type="number" min="1" max="26" value="${s.rounds}" ${dis}></label>
        <fieldset class="field" ${dis}>
          <legend>Letter</legend>
          <label class="radio"><input type="radio" name="letterMode" value="random" ${s.letterMode === 'random' ? 'checked' : ''}> Random draw</label>
          <label class="radio"><input type="radio" name="letterMode" value="pick" ${s.letterMode === 'pick' ? 'checked' : ''}> ${online() ? 'Players take turns choosing' : 'I choose'}</label>
        </fieldset>
        <fieldset class="field" ${dis}>
          <legend>Excluded letters <span class="muted small">(tap to toggle)</span></legend>
          <div class="letters small-letters">${ALPHABET.map(l => `
            <button type="button" class="letter ${s.excluded.includes(l) ? 'off' : ''}" data-act="exclude" data-letter="${l}"
              aria-pressed="${s.excluded.includes(l)}" ${dis}>${l}</button>`).join('')}</div>
        </fieldset>
      </div>
    </section>
  </div>
  <div class="row gap end">
    <button class="btn ghost" data-act="leave">Leave</button>
    ${host ? '<button class="btn primary big" data-act="start">Start game</button>' : '<p class="muted">Waiting for the host to start…</p>'}
  </div>`;
}

function roundBanner() {
  return `<p class="muted small center">Round ${view.round} of ${view.settings.rounds}</p>`;
}

function renderPicking() {
  const random = view.settings.letterMode === 'random';
  const mine = view.pickerId === myId;
  const used = new Set([...view.usedLetters, ...view.settings.excluded]);
  let body;
  if (random) {
    body = isHost()
      ? `<button class="btn primary huge" data-act="draw">Draw a letter</button>`
      : `<p class="waiting">Waiting for ${esc(playerName(view.hostId))} to draw a letter…</p>`;
  } else if (mine) {
    body = `<h2 class="center">Choose the letter</h2>
      <div class="letters">${ALPHABET.map(l => `
        <button class="letter" data-act="pick" data-letter="${l}" ${used.has(l) ? 'disabled' : ''}>${l}</button>`).join('')}</div>
      <div class="row center"><button class="btn" data-act="draw">Surprise me</button></div>`;
  } else {
    body = `<p class="waiting">${esc(playerName(view.pickerId))} is choosing the letter…</p>
      ${isHost() ? '<div class="row center"><button class="btn small ghost" data-act="draw">Draw one for them</button></div>' : ''}`;
  }
  const endBtn = isHost() && view.history.length
    ? '<div class="row end"><button class="btn ghost small" data-act="endGame">End game & show results</button></div>' : '';
  return `${roundBanner()}<section class="card">${body}</section>${endBtn}${sheetCard()}${footer()}`;
}

function renderPlaying() {
  const L = view.letter;
  return `
  ${roundBanner()}
  <section class="card play">
    <div class="play-head">
      <div class="big-letter" aria-label="Letter ${L}">${L}</div>
      <div class="timer" id="timer" aria-live="off">--</div>
      <button class="btn stop" id="stop-btn" data-act="stop">STOP</button>
    </div>
    <form class="answers" id="answers" autocomplete="off" onsubmit="return false">
      ${CATEGORIES.map(c => `
        <label class="answer" id="wrap-${c}">
          <span>${LABELS[c]}</span>
          <input id="ans-${c}" data-cat="${c}" maxlength="40" autocapitalize="words" spellcheck="false"
            placeholder="${L}…" value="${esc(draft[c])}">
        </label>`).join('')}
    </form>
    ${online() ? '<div id="progress" class="progress"></div>' : ''}
  </section>
  ${sheetCard()}
  ${footer()}`;
}

// Cheap per-tick updates for the play screen; never touches the inputs' values.
function updatePlaying() {
  if (view?.phase !== 'playing') return;
  const remaining = deadline == null ? 0 : Math.max(0, deadline - performance.now());
  const locked = remaining <= 0;
  const timer = document.getElementById('timer');
  if (timer) {
    const secs = Math.ceil(remaining / 1000);
    timer.textContent = locked ? "Time's up" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    timer.classList.toggle('urgent', !locked && secs <= 10);
  }
  let filled = 0;
  for (const c of CATEGORIES) {
    const ok = autoValid(draft[c], view.letter);
    const bad = draft[c].trim() && firstLetter(draft[c]) !== view.letter;
    if (ok) filled++;
    document.getElementById(`wrap-${c}`)?.classList.toggle('ok', ok);
    document.getElementById(`wrap-${c}`)?.classList.toggle('bad', !!bad);
    const input = document.getElementById(`ans-${c}`);
    if (input) input.disabled = locked;
  }
  const stop = document.getElementById('stop-btn');
  if (stop) {
    stop.disabled = locked || filled < CATEGORIES.length;
    stop.title = stop.disabled ? 'Fill all five columns to call STOP' : 'End the round for everyone';
  }
  const prog = document.getElementById('progress');
  if (prog && view.filled) {
    prog.innerHTML = view.players.filter(p => p.connected && view.filled[p.id] != null).map(p => `
      <span class="chip ${view.filled[p.id] === CATEGORIES.length ? 'done' : ''}">
        ${esc(p.name)} <b>${p.id === myId ? filled : view.filled[p.id]}/${CATEGORIES.length}</b></span>`).join('');
  }
  if (locked && sendTimer) flushAnswers();
}

function flushAnswers() {
  clearTimeout(sendTimer);
  sendTimer = null;
  if (view?.phase === 'playing') dispatch({ type: 'answers', answers: draft });
}

function renderReview() {
  const solo = view.players.filter(p => p.connected).length <= 1;
  const ids = Object.keys(view.answers);
  const by = view.stoppedBy ? `${esc(playerName(view.stoppedBy))} called STOP!` : "Time's up!";
  return `
  ${roundBanner()}
  <section class="card">
    <div class="review-head">
      <div class="big-letter sm">${view.letter}</div>
      <div><h2>${by}</h2>
        <p class="muted small">${solo
          ? 'Be honest — tap any answer that doesn\'t really count.'
          : 'Tap an answer you think is wrong. It is thrown out if most of the other players reject it.'}</p></div>
    </div>
    <div class="table-wrap">
      <table class="sheet review">
        <thead><tr><th>Player</th>${CATEGORIES.map(c => `<th>${LABELS[c]}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${ids.map(pid => {
          let total = 0;
          const cells = CATEGORIES.map(c => {
            const ans = view.answers[pid][c];
            const auto = autoValid(ans, view.letter);
            const ok = view.valid[pid][c];
            if (ok) total += POINTS;
            const votes = view.rejects[`${pid}|${c}`] || [];
            const mineRejected = votes.includes(myId);
            const canVote = auto && (solo || pid !== myId);
            const reason = !ans.trim() ? '' : auto ? '' : 'wrong letter';
            return `<td class="${ok ? 'ok' : 'no'}">
              ${canVote
                ? `<button class="vote ${mineRejected ? 'rejected' : ''}" data-act="reject" data-pid="${esc(pid)}" data-cat="${c}"
                    aria-pressed="${mineRejected}" title="${mineRejected ? 'Undo reject' : 'Reject this answer'}">
                    <span class="ans">${esc(ans)}</span>${votes.length ? `<span class="votes">✗${votes.length}</span>` : ''}</button>`
                : `<span class="ans">${esc(ans) || '—'}</span>${reason ? `<span class="why">${reason}</span>` : ''}${votes.length ? `<span class="votes">✗${votes.length}</span>` : ''}`}
            </td>`;
          }).join('');
          return `<tr><th>${esc(playerName(pid))}</th>${cells}<td class="total">${total}</td></tr>`;
        }).join('')}</tbody>
      </table>
    </div>
  </section>
  <div class="row gap end">
    ${isHost()
      ? `<button class="btn ghost" data-act="endGame">End game now</button>
         <button class="btn primary big" data-act="confirm">${view.round >= view.settings.rounds ? 'Confirm & finish' : 'Confirm & next round'}</button>`
      : '<p class="muted">Vote, then wait for the host to confirm scores…</p>'}
  </div>
  ${footer(true)}`;
}

function renderOver() {
  const ranked = [...view.players].sort((a, b) => b.total - a.total);
  const top = ranked[0]?.total ?? 0;
  const winners = ranked.filter(p => p.total === top && top > 0);
  const headline = !online() || view.players.length === 1
    ? `You scored ${top}`
    : winners.length > 1 ? `It's a tie at ${top}!` : winners.length ? `${esc(winners[0].name)} wins with ${top}!` : 'Game over';
  return `
  <section class="card center">
    <h1>${headline}</h1>
    ${view.players.length > 1 ? `<ol class="standings">${ranked.map(p => `
      <li class="${p.total === top && top > 0 ? 'winner' : ''}"><span>${esc(p.name)}</span><b>${p.total}</b></li>`).join('')}</ol>` : ''}
  </section>
  ${ranked.map(p => sheetCard(p.id)).join('')}
  <div class="row gap end">
    <button class="btn ghost" data-act="leave">Leave</button>
    ${isHost() ? '<button class="btn primary big" data-act="restart">Play again</button>' : '<p class="muted">The host can start a new game.</p>'}
  </div>`;
}

// The paper score sheet: one row per letter, one column per category.
function sheetCard(pid = myId) {
  const rows = view.history.filter(r => r.results[pid]);
  if (!rows.length) return '';
  const total = rows.reduce((s, r) => s + r.results[pid].score, 0);
  const who = pid === myId ? 'Your sheet' : `${esc(playerName(pid))}'s sheet`;
  return `
  <section class="card">
    <h2>${who}</h2>
    <div class="table-wrap">
      <table class="sheet">
        <thead><tr><th></th>${CATEGORIES.map(c => `<th>${LABELS[c]}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${rows.map(r => {
          const res = r.results[pid];
          return `<tr><th class="letter-cell">${r.letter}</th>${CATEGORIES.map(c =>
            `<td class="${res.valid[c] ? 'ok' : 'no'}">${esc(res.answers[c]) || '—'}</td>`).join('')}<td class="total">${res.score}</td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><th colspan="${CATEGORIES.length + 1}">Total</th><td class="total">${total}</td></tr></tfoot>
      </table>
    </div>
  </section>`;
}

function footer(hideLeave) {
  return `
  ${online() ? `<section class="card"><h2>Scores</h2>${playersList()}</section>` : ''}
  ${hideLeave ? '' : `<div class="row end"><button class="btn ghost small" data-act="leave">Leave game</button></div>`}`;
}

// ---------- events ----------

app.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'home-name') {
    home.name = t.value;
    const av = document.getElementById('home-avatar');
    if (av) av.textContent = t.value.trim()[0]?.toUpperCase() || '?';
  }
  else if (t.id === 'home-code') { home.code = normalizeCode(t.value); t.value = home.code; }
  else if (t.dataset.cat && view?.phase === 'playing') {
    draft[t.dataset.cat] = t.value;
    updatePlaying();
    clearTimeout(sendTimer);
    sendTimer = setTimeout(flushAnswers, 300);
  }
});

app.addEventListener('change', e => {
  const t = e.target;
  if (!isHost() || view?.phase !== 'lobby') return;
  if (t.id === 'set-seconds') dispatch({ type: 'settings', settings: { seconds: t.value } });
  else if (t.id === 'set-rounds') dispatch({ type: 'settings', settings: { rounds: t.value } });
  else if (t.name === 'letterMode') dispatch({ type: 'settings', settings: { letterMode: t.value } });
});

app.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t.id === 'home-code') begin('client');
  else if (t.id === 'home-name') begin(home.code ? 'client' : 'solo');
  else if (t.dataset.cat) {
    // Enter moves down the columns like a paper sheet; on the last one, try STOP.
    e.preventDefault();
    const i = CATEGORIES.indexOf(t.dataset.cat);
    const next = document.getElementById(`ans-${CATEGORIES[i + 1]}`);
    if (next) next.focus();
    else document.getElementById('stop-btn')?.click();
  }
});

app.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  switch (act) {
    case 'solo': return begin('solo');
    case 'host': return begin('host');
    case 'join': return begin('client');
    case 'leave':
      if (isHost() && online() && view.players.some(p => p.connected && p.id !== myId)
        && !confirm('You are the host — leaving ends the game for everyone. Leave?')) return;
      home.code = '';
      return leave();
    case 'copy': {
      const link = b.dataset.link;
      try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Name Place Animal', url: link });
        else { await navigator.clipboard.writeText(link); toast('Invite link copied.', 'info'); }
      } catch (err) {
        if (err?.name !== 'AbortError') toast(`Copy failed — share this link: ${link}`, 'info');
      }
      return;
    }
    case 'exclude': {
      const l = b.dataset.letter;
      const ex = view.settings.excluded;
      return dispatch({ type: 'settings', settings: { excluded: ex.includes(l) ? ex.filter(x => x !== l) : [...ex, l] } });
    }
    case 'start': return dispatch({ type: 'start' });
    case 'draw': return dispatch({ type: 'pick', random: true });
    case 'pick': return dispatch({ type: 'pick', letter: b.dataset.letter });
    case 'stop': return dispatch({ type: 'stop', answers: draft });
    case 'reject': return dispatch({ type: 'reject', pid: b.dataset.pid, cat: b.dataset.cat });
    case 'confirm': return dispatch({ type: 'confirm' });
    case 'endGame': return dispatch({ type: 'endGame' });
    case 'restart': return dispatch({ type: 'restart' });
  }
});

setInterval(updatePlaying, 200);

window.addEventListener('beforeunload', e => {
  if (session && isHost() && online() && view?.players.some(p => p.connected && p.id !== myId)) e.preventDefault();
});

document.getElementById('version').textContent = `v${VERSION}`;
render();
