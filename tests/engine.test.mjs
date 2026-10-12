// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, reduce, viewFor, isValid, autoValid, firstLetter, availableLetters } from '../js/engine.js';

const fill = L => ({ name: `${L}nna`, place: `${L}msterdam`, animal: `${L}nt`, food: `${L}pple`, thing: `${L}xe` });

function threePlayerRound(letter = 'A') {
  const s = createGame('h', 'Host', { letterMode: 'random', seconds: 60, rounds: 2 });
  reduce(s, { type: 'join', name: 'Bea' }, 'b');
  reduce(s, { type: 'join', name: 'Cal' }, 'c');
  reduce(s, { type: 'start' }, 'h');
  assert.equal(reduce(s, { type: 'pick', letter }, 'h', 0).error, undefined);
  return s;
}

test('first-letter check ignores case, accents and leading punctuation', () => {
  assert.equal(firstLetter('évian'), 'E');
  assert.equal(firstLetter("'Ohana"), 'O');
  assert.ok(autoValid('apple', 'A'));
  assert.ok(!autoValid('A', 'A'), 'single letters are not answers');
  assert.ok(!autoValid('banana', 'A'));
});

test('full round: stop requires all five, scoring is 10 per accepted answer', () => {
  const s = threePlayerRound('A');
  assert.equal(s.phase, 'playing');
  reduce(s, { type: 'answers', answers: { ...fill('A'), thing: '' } }, 'b');
  assert.match(reduce(s, { type: 'stop' }, 'b').error, /Fill every column/);
  reduce(s, { type: 'answers', answers: { name: 'Carl', place: 'Athens' } }, 'c');
  assert.equal(reduce(s, { type: 'stop', answers: fill('A') }, 'h').error, undefined);
  assert.equal(s.phase, 'review');
  assert.equal(s.stoppedBy, 'h');

  // One of two other voters rejecting is not a majority; both is.
  reduce(s, { type: 'reject', pid: 'h', cat: 'thing' }, 'b');
  assert.ok(isValid(s, 'h', 'thing'));
  reduce(s, { type: 'reject', pid: 'h', cat: 'thing' }, 'c');
  assert.ok(!isValid(s, 'h', 'thing'));
  assert.match(reduce(s, { type: 'reject', pid: 'h', cat: 'name' }, 'h').error, /own answers/);

  reduce(s, { type: 'confirm' }, 'h');
  const totals = Object.fromEntries(s.players.map(p => [p.id, p.total]));
  assert.deepEqual(totals, { h: 40, b: 40, c: 10 }); // Carl is wrong letter
  assert.equal(s.phase, 'picking');
  assert.equal(s.round, 2);
  assert.ok(!availableLetters(s).includes('A'));
});

test('only the host confirms; non-members are ignored', () => {
  const s = threePlayerRound();
  reduce(s, { type: 'timeUp' }, 'h');
  assert.ok(reduce(s, { type: 'confirm' }, 'b').error);
  assert.ok(reduce(s, { type: 'reject', pid: 'h', cat: 'name' }, 'stranger').error);
});

test('other players answers are hidden during play', () => {
  const s = threePlayerRound();
  reduce(s, { type: 'answers', answers: fill('A') }, 'h');
  const v = viewFor(s, 'b', 10_000);
  assert.deepEqual(Object.keys(v.answers), ['b']);
  assert.equal(v.filled.h, 5);
  assert.equal(v.remainingMs, 50_000);
  assert.equal(v.endsAt, undefined);
});

test('solo player can reject their own answers', () => {
  const s = createGame('me', 'Solo', { rounds: 1 });
  reduce(s, { type: 'start' }, 'me');
  reduce(s, { type: 'pick', letter: 'B' }, 'me');
  reduce(s, { type: 'stop', answers: fill('B') }, 'me');
  assert.equal(reduce(s, { type: 'reject', pid: 'me', cat: 'food' }, 'me').error, undefined);
  reduce(s, { type: 'confirm' }, 'me');
  assert.equal(s.players[0].total, 40);
  assert.equal(s.phase, 'over');
});

test('pick mode rotates the chooser and enforces turns', () => {
  const s = createGame('h', 'Host', { letterMode: 'pick', rounds: 3 });
  reduce(s, { type: 'join', name: 'Bea' }, 'b');
  reduce(s, { type: 'start' }, 'h');
  const first = s.pickerId;
  const other = first === 'h' ? 'b' : 'h';
  if (other !== 'h') assert.match(reduce(s, { type: 'pick', letter: 'C' }, other).error, /not your turn/);
  reduce(s, { type: 'pick', letter: 'C' }, first);
  reduce(s, { type: 'timeUp' }, 'h');
  reduce(s, { type: 'confirm' }, 'h');
  assert.equal(s.pickerId, other);
  assert.match(reduce(s, { type: 'pick', letter: 'C' }, other).error, /not available/);
});

test('rejoining with the same name keeps score and answers', () => {
  const s = threePlayerRound();
  reduce(s, { type: 'answers', answers: fill('A') }, 'b');
  reduce(s, { type: 'leave' }, 'b');
  assert.match(reduce(s, { type: 'join', name: 'cal' }, 'x').error, /already taken/);
  reduce(s, { type: 'join', name: 'bea' }, 'b2');
  assert.equal(s.players.filter(p => p.name === 'Bea').length, 1);
  assert.equal(s.answers.b2.name, 'Anna');
  assert.equal(s.answers.b, undefined);
});

test('random draw never repeats or uses excluded letters', () => {
  const s = createGame('me', 'Solo', { rounds: 26, excluded: ['Q', 'X', 'Z'] });
  reduce(s, { type: 'start' }, 'me');
  const seen = new Set();
  while (s.phase === 'picking') {
    reduce(s, { type: 'pick', random: true }, 'me');
    assert.ok(!seen.has(s.letter) && !'QXZ'.includes(s.letter));
    seen.add(s.letter);
    reduce(s, { type: 'timeUp' }, 'me');
    reduce(s, { type: 'confirm' }, 'me');
  }
  assert.equal(seen.size, 23);
  assert.equal(s.phase, 'over');
});

test('displayed version matches package.json', async () => {
  const { VERSION } = await import('../js/version.js');
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(VERSION, pkg.version);
});

// A stale ?v= means phones keep running cached code after a release.
test('every local asset URL is stamped with the current version', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  const { version } = JSON.parse(await read('package.json'));
  for (const f of ['index.html', 'js/app.js', 'js/net.js']) {
    const text = await read(f);
    const refs = [...text.matchAll(/(?:(?:href|src)="(?!https?:)([^"]+\.(?:css|js)[^"]*)"|from '(\.\/[^']+)')/g)].map(m => m[1] || m[2]);
    assert.ok(refs.length, `no asset refs found in ${f}`);
    for (const r of refs) assert.ok(r.endsWith(`?v=${version}`), `${f}: ${r} should end with ?v=${version} — run npm run bump`);
  }
});
