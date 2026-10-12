// Pure game logic. No DOM, no network: the host runs every action through
// reduce() and broadcasts the result, so this file is the single source of
// truth for the rules and can be unit-tested in Node.

export const CATEGORIES = ['name', 'place', 'animal', 'food', 'thing'];
export const POINTS = 10;
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

export const DEFAULT_SETTINGS = {
  seconds: 90,
  rounds: 5,
  letterMode: 'random', // 'random' | 'pick' (players take turns choosing)
  excluded: ['Q', 'X', 'Z'],
};

// Compare on the first letter only, ignoring accents and leading punctuation,
// so "Évian" counts for E and "'Ohana" for O.
export function firstLetter(text) {
  const norm = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = norm.match(/[A-Za-z]/);
  return m ? m[0].toUpperCase() : '';
}

export function autoValid(answer, letter) {
  return String(answer || '').trim().length > 1 && firstLetter(answer) === letter;
}

export function emptyAnswers() {
  return Object.fromEntries(CATEGORIES.map(c => [c, '']));
}

export function createGame(hostId, hostName, settings = {}) {
  return {
    phase: 'lobby', // lobby | picking | playing | review | over
    hostId,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    players: [{ id: hostId, name: hostName, connected: true, total: 0 }],
    round: 0,
    letter: null,
    usedLetters: [],
    pickerId: null,
    endsAt: null,
    stoppedBy: null,
    answers: {},
    rejects: {},
    history: [],
  };
}

export function availableLetters(state) {
  return ALPHABET.filter(l => !state.usedLetters.includes(l) && !state.settings.excluded.includes(l));
}

const player = (state, id) => state.players.find(p => p.id === id);
const activeIds = state => state.players.filter(p => p.connected).map(p => p.id);

// Players are matched by name on rejoin so a refreshed tab gets its score back
// instead of appearing as a second player.
function join(state, id, name) {
  name = String(name || '').trim().slice(0, 20);
  if (!name) return { error: 'Enter a name.' };
  const existing = state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.connected && existing.id !== id) return { error: `"${name}" is already taken in this room.` };
    const oldId = existing.id;
    existing.id = id;
    existing.connected = true;
    if (state.answers[oldId]) { state.answers[id] = state.answers[oldId]; delete state.answers[oldId]; }
    if (state.pickerId === oldId) state.pickerId = id;
    remapRejects(state, oldId, id);
    for (const r of state.history) {
      if (r.results[oldId]) { r.results[id] = r.results[oldId]; delete r.results[oldId]; }
    }
    return {};
  }
  state.players.push({ id, name, connected: true, total: 0 });
  return {};
}

function remapRejects(state, oldId, newId) {
  const next = {};
  for (const [key, voters] of Object.entries(state.rejects)) {
    const [pid, cat] = key.split('|');
    next[`${pid === oldId ? newId : pid}|${cat}`] = voters.map(v => (v === oldId ? newId : v));
  }
  state.rejects = next;
}

function nextPicker(state) {
  const ids = activeIds(state);
  if (!ids.length) return null;
  const idx = ids.indexOf(state.pickerId);
  return ids[(idx + 1) % ids.length];
}

function beginPicking(state) {
  state.round += 1;
  state.phase = 'picking';
  state.letter = null;
  state.answers = {};
  state.rejects = {};
  state.stoppedBy = null;
  state.endsAt = null;
  state.pickerId = state.settings.letterMode === 'pick' ? nextPicker(state) : state.hostId;
}

function startPlaying(state, letter, now) {
  state.letter = letter;
  state.usedLetters.push(letter);
  state.phase = 'playing';
  state.endsAt = now + state.settings.seconds * 1000;
  for (const id of activeIds(state)) state.answers[id] = emptyAnswers();
}

function endRound(state, stoppedBy) {
  state.phase = 'review';
  state.endsAt = null;
  state.stoppedBy = stoppedBy || null;
}

// An answer that passes the first-letter check stands unless a strict
// majority of the *other* connected players reject it. In single player the
// lone player is the judge of their own answers.
export function isValid(state, pid, cat) {
  const answer = state.answers[pid]?.[cat];
  if (!autoValid(answer, state.letter)) return false;
  const voters = activeIds(state).filter(id => id !== pid);
  const rejects = state.rejects[`${pid}|${cat}`] || [];
  if (!voters.length) return rejects.length === 0;
  return rejects.filter(v => voters.includes(v)).length * 2 <= voters.length;
}

export function roundScore(state, pid) {
  return CATEGORIES.reduce((sum, c) => sum + (isValid(state, pid, c) ? POINTS : 0), 0);
}

function finalizeRound(state) {
  const results = {};
  for (const id of Object.keys(state.answers)) {
    const valid = Object.fromEntries(CATEGORIES.map(c => [c, isValid(state, id, c)]));
    const score = roundScore(state, id);
    results[id] = { answers: { ...state.answers[id] }, valid, score };
    const p = player(state, id);
    if (p) p.total += score;
  }
  state.history.push({ round: state.round, letter: state.letter, stoppedBy: state.stoppedBy, results });
  const outOfLetters = availableLetters(state).length === 0;
  if (state.round >= state.settings.rounds || outOfLetters) state.phase = 'over';
  else beginPicking(state);
}

export function randomLetter(state, rng = Math.random) {
  const pool = availableLetters(state);
  return pool.length ? pool[Math.floor(rng() * pool.length)] : null;
}

// Returns { state, error? }. State is mutated in place and also returned so
// callers can treat this like a reducer.
export function reduce(state, action, from, now = Date.now(), rng = Math.random) {
  const isHost = from === state.hostId;
  const fail = error => ({ state, error });
  // A peer whose join was refused can still hold an open connection; ignore it.
  if (action.type !== 'join' && action.type !== 'leave' && !player(state, from)) return fail('Join the room first.');
  switch (action.type) {
    case 'join': {
      const r = join(state, from, action.name);
      if (r.error) return fail(r.error);
      // Joining mid-round: give them a blank row so they can still play it.
      if (state.phase === 'playing' && !state.answers[from]) state.answers[from] = emptyAnswers();
      return { state };
    }
    case 'leave': {
      const p = player(state, from);
      if (p) p.connected = false;
      if (state.phase === 'picking' && state.pickerId === from) state.pickerId = nextPicker(state);
      return { state };
    }
    case 'settings': {
      if (!isHost || state.phase !== 'lobby') return fail('Only the host can change settings before the game starts.');
      const s = { ...state.settings, ...action.settings };
      s.seconds = Math.min(600, Math.max(15, Math.round(Number(s.seconds) || DEFAULT_SETTINGS.seconds)));
      s.rounds = Math.min(26, Math.max(1, Math.round(Number(s.rounds) || DEFAULT_SETTINGS.rounds)));
      s.letterMode = s.letterMode === 'pick' ? 'pick' : 'random';
      s.excluded = (s.excluded || []).map(l => String(l).toUpperCase()).filter(l => ALPHABET.includes(l));
      if (ALPHABET.length - s.excluded.length < 1) return fail('At least one letter must be allowed.');
      state.settings = s;
      return { state };
    }
    case 'start': {
      if (!isHost || state.phase !== 'lobby') return fail('Only the host can start the game.');
      beginPicking(state);
      return { state };
    }
    case 'pick': {
      if (state.phase !== 'picking') return fail('Not picking a letter right now.');
      const letter = action.random ? randomLetter(state, rng) : String(action.letter || '').toUpperCase();
      if (from !== state.pickerId && !isHost) return fail('It is not your turn to choose the letter.');
      if (!availableLetters(state).includes(letter)) return fail(`${letter || 'That letter'} is not available.`);
      startPlaying(state, letter, now);
      return { state };
    }
    case 'answers': {
      if (state.phase !== 'playing' || !state.answers[from]) return { state };
      const clean = emptyAnswers();
      for (const c of CATEGORIES) clean[c] = String(action.answers?.[c] || '').slice(0, 40);
      state.answers[from] = clean;
      return { state };
    }
    case 'stop': {
      if (state.phase !== 'playing') return { state };
      if (action.answers) reduce(state, { type: 'answers', answers: action.answers }, from, now);
      const a = state.answers[from];
      if (!a || !CATEGORIES.every(c => autoValid(a[c], state.letter))) {
        return fail(`Fill every column with a word starting with ${state.letter} before calling STOP.`);
      }
      endRound(state, from);
      return { state };
    }
    case 'timeUp': {
      if (!isHost || state.phase !== 'playing') return { state };
      endRound(state, null);
      return { state };
    }
    case 'reject': {
      if (state.phase !== 'review') return { state };
      const { pid, cat } = action;
      if (!CATEGORIES.includes(cat) || !state.answers[pid]) return { state };
      const solo = activeIds(state).length <= 1;
      if (pid === from && !solo) return fail('You cannot vote on your own answers.');
      const key = `${pid}|${cat}`;
      const voters = state.rejects[key] || [];
      state.rejects[key] = voters.includes(from) ? voters.filter(v => v !== from) : [...voters, from];
      return { state };
    }
    case 'confirm': {
      if (!isHost || state.phase !== 'review') return fail('Only the host can confirm scores.');
      finalizeRound(state);
      return { state };
    }
    case 'endGame': {
      if (!isHost) return fail('Only the host can end the game.');
      if (state.phase === 'review') finalizeRound(state);
      state.phase = 'over';
      return { state };
    }
    case 'restart': {
      if (!isHost || state.phase !== 'over') return fail('Only the host can start a new game.');
      const fresh = createGame(state.hostId, '', state.settings);
      fresh.players = state.players.filter(p => p.connected).map(p => ({ ...p, total: 0 }));
      return { state: Object.assign(state, fresh) };
    }
    default:
      return fail(`Unknown action ${action.type}`);
  }
}

// What a given player is allowed to see. During play, other players' answers
// are stripped so they can't be read from devtools or the network.
export function viewFor(state, pid, now = Date.now()) {
  const view = JSON.parse(JSON.stringify(state));
  if (state.phase === 'playing') {
    view.answers = { [pid]: state.answers[pid] };
    view.filled = Object.fromEntries(Object.entries(state.answers).map(([id, a]) => [
      id, CATEGORIES.filter(c => autoValid(a[c], state.letter)).length,
    ]));
  }
  // Send time remaining, not an absolute timestamp: device clocks disagree.
  view.remainingMs = state.endsAt ? Math.max(0, state.endsAt - now) : null;
  delete view.endsAt;
  if (state.phase === 'review') {
    view.valid = {};
    for (const id of Object.keys(state.answers)) {
      view.valid[id] = Object.fromEntries(CATEGORIES.map(c => [c, isValid(state, id, c)]));
    }
  }
  return view;
}
