// Transport. The host's browser is the game server: it owns the state, runs
// every action through engine.reduce() and pushes a per-player view to each
// peer. Clients never mutate state, they only send actions. PeerJS's public
// broker is used only to set up the WebRTC connections; game traffic is
// peer-to-peer, so there is no backend to deploy.

import { createGame, reduce, viewFor } from './engine.js?v=1.1.2';

const PREFIX = 'nameplaceanimal-';
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
// Late "answers" messages after the timer would otherwise be lost, so the
// host waits a moment past zero before closing the round.
const GRACE_MS = 1200;

export function makeCode(len = 5) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function requirePeer() {
  if (!window.Peer) throw new Error('Online play could not load (PeerJS blocked or offline). Solo still works.');
}

// Host and solo share this: the only difference is whether peers exist.
class HostSession {
  constructor({ name, online, onState, onError, onStatus }) {
    Object.assign(this, { name, online, onState, onError, onStatus });
    this.conns = new Map();
    this.timer = setInterval(() => this.tick(), 250);
  }

  async start() {
    if (!this.online) {
      this.id = 'me';
      this.state = createGame(this.id, this.name);
      this.publish();
      return;
    }
    requirePeer();
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = makeCode();
      try {
        this.peer = await openPeer(PREFIX + code);
        this.code = code;
        break;
      } catch (e) {
        if (e.type !== 'unavailable-id' || attempt === 3) throw friendly(e);
      }
    }
    this.id = this.peer.id;
    this.state = createGame(this.id, this.name);
    this.peer.on('connection', conn => this.accept(conn));
    // Losing the broker doesn't drop existing players, but new joiners can't
    // find us until we re-register.
    this.peer.on('disconnected', () => {
      this.onStatus?.('Reconnecting to lobby server…');
      setTimeout(() => !this.closed && this.peer.reconnect(), 1000);
    });
    this.peer.on('open', () => this.onStatus?.(''));
    this.peer.on('error', e => this.onError(friendly(e).message));
    this.publish();
  }

  accept(conn) {
    conn.on('data', msg => {
      if (msg?.type !== 'action') return;
      if (msg.action?.type === 'join') this.conns.set(conn.peer, conn);
      this.apply(msg.action, conn.peer, conn);
    });
    conn.on('close', () => {
      if (this.conns.get(conn.peer) !== conn) return;
      this.conns.delete(conn.peer);
      this.apply({ type: 'leave' }, conn.peer);
    });
    conn.on('error', () => conn.close());
  }

  dispatch(action) {
    this.apply(action, this.id);
  }

  apply(action, from, conn) {
    const { error } = reduce(this.state, action, from);
    if (error) {
      if (from === this.id) this.onError(error);
      else conn?.open && conn.send({ type: 'error', error, fatal: action.type === 'join' });
      if (action.type === 'join') { this.conns.delete(from); setTimeout(() => conn?.close(), 300); }
      return;
    }
    this.publish();
  }

  tick() {
    const s = this.state;
    if (s?.phase === 'playing' && Date.now() >= s.endsAt + GRACE_MS) this.dispatch({ type: 'timeUp' });
  }

  publish() {
    const now = Date.now();
    for (const [pid, conn] of this.conns) {
      if (conn.open) conn.send({ type: 'state', view: viewFor(this.state, pid, now) });
    }
    this.onState(viewFor(this.state, this.id, now), this.id);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const c of this.conns.values()) c.close();
    this.peer?.destroy();
  }
}

class ClientSession {
  constructor({ name, code, onState, onError, onStatus, onClosed }) {
    Object.assign(this, { name, code: normalizeCode(code), onState, onError, onStatus, onClosed });
  }

  async start() {
    requirePeer();
    this.peer = await openPeer().catch(e => { throw friendly(e); });
    this.id = this.peer.id;
    await new Promise((resolve, reject) => {
      const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
      this.conn = conn;
      const timeout = setTimeout(() => reject(new Error(`Couldn't reach room ${this.code}. Check the code, or the host's network may block peer-to-peer connections.`)), 12000);
      this.peer.on('error', e => { clearTimeout(timeout); reject(friendly(e)); });
      conn.on('open', () => {
        clearTimeout(timeout);
        conn.send({ type: 'action', action: { type: 'join', name: this.name } });
        resolve();
      });
      let joined = false;
      conn.on('data', msg => {
        if (msg?.type === 'state') { joined = true; this.onState(msg.view, this.id); }
        else if (msg?.type === 'error') {
          if (msg.fatal && !joined) { this.refused = true; this.onClosed(msg.error); }
          else this.onError(msg.error);
        }
      });
      conn.on('close', () => {
        if (!this.closed && !this.refused) this.onClosed('Lost connection to the host. Rejoin with the same name to keep your score.');
      });
    });
  }

  dispatch(action) {
    if (this.conn?.open) this.conn.send({ type: 'action', action });
    else this.onError('Not connected to the host.');
  }

  close() {
    this.closed = true;
    this.peer?.destroy();
  }
}

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new window.Peer(id, { debug: 1 }) : new window.Peer({ debug: 1 });
    const onError = e => { peer.destroy(); reject(e); };
    peer.once('error', onError);
    peer.once('open', () => { peer.off('error', onError); resolve(peer); });
  });
}

function friendly(e) {
  const map = {
    'peer-unavailable': 'Room not found. Check the code — the host may have closed the game.',
    'network': 'Network error talking to the lobby server.',
    'server-error': 'Lobby server unavailable. Try again shortly.',
    'socket-error': 'Lobby server unavailable. Try again shortly.',
    'browser-incompatible': 'This browser does not support peer-to-peer connections.',
    'unavailable-id': 'Room code collision, try again.',
  };
  const err = new Error(map[e?.type] || e?.message || String(e));
  err.type = e?.type;
  return err;
}

export function createSession(opts) {
  if (opts.mode === 'client') return new ClientSession(opts);
  return new HostSession({ ...opts, online: opts.mode === 'host' });
}
