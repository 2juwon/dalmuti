/* 달무티 온라인 서버 (Cloudflare Workers + Durable Objects)
 * - Room: 방 하나. 규칙 엔진(DM)으로 판을 진행하고, 사람마다 그 사람에게 보이는 정보(DM.viewFor)만 보낸다.
 *         차례마다 제한 시간이 있고, 지나면 자동으로 패스(선이면 가장 약한 묶음을 냄)한다.
 *         빈자리·자리 비운 사람은 컴퓨터(DMAI)가 대신 둔다.
 * - Lobby: 빠른 참가용 공개 방 목록 (하나뿐)
 */
import { DurableObject } from 'cloudflare:workers';
import DM from '../../src/engine.js';
import DMAI from '../../src/ai.js';

DMAI.budget = 100;            // 고수 컴퓨터가 한 수에 상상해 볼 판 수 (서버 CPU 아끼기)
const DRAW_MS = 5000;         // 계급 뽑기 결과 보여 주는 시간
const NEXT_MS = 25000;        // 판이 끝나고 다음 판까지 최대 대기
const AWAY_MS = 1200;         // 자리 비운 사람 대신 둘 때
const AI_MS = { play: [800, 1400], giveBack: [900, 1300], revolution: [900, 1300] };
const EMPTY_ROOM_MS = 30 * 60 * 1000;  // 아무도 없으면 30분 뒤 방 정리
const OPEN_ROOM_TTL = 10 * 60 * 1000;  // 빠른 참가에서 오래된 방은 제외
const AI_NAMES = ['민지', '도윤', '서연', '하준', '지우', '은우', '수아', '시우'];
const TURN_SECS = [10, 15, 20, 30, 60];
const between = ([a, b]) => a + Math.random() * (b - a);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
});
function rand32() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
const randomCode = () => String(100000 + (rand32() % 900000));
const lobbyStub = (env) => env.LOBBY.get(env.LOBBY.idFromName('main'));
const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));

function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f\u007f<>&"']/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 6).join('') || '손님';
}
const emptySeat = () => ({ kind: 'empty', pid: null, name: '', away: false, ready: false, timeouts: 0, formerPid: null });
export const DEFAULT_SETTINGS = { max: 5, games: 5, turnSec: 20, level: 'normal', firstTax: true, public: false };
function cleanSettings(cur, s) {
  const out = { ...cur };
  if (!s || typeof s !== 'object') return out;
  if ([4, 5, 6, 7, 8].includes(s.max)) out.max = s.max;
  if ([3, 5, 10].includes(s.games)) out.games = s.games;
  if (TURN_SECS.includes(s.turnSec)) out.turnSec = s.turnSec;
  if (['easy', 'normal', 'hard'].includes(s.level)) out.level = s.level;
  if (typeof s.firstTax === 'boolean') out.firstTax = s.firstTax;
  if (typeof s.public === 'boolean') out.public = s.public;
  return out;
}

// 시간이 지났거나 자리를 비운 사람 대신 할 행동: 패스 / (선이면) 컴퓨터가 고른 수 / 추천 카드 돌려주기 / 혁명 숨기기
export function autoAction(g, pid, asComputer) {
  const p = DM.pending(g);
  if (!p || p.pid !== pid) return null;
  if (asComputer) {
    const c = DM.clone(g);
    if (!g.players[pid].ai) c.players[pid].level = 'normal';
    return DMAI.decide(c);
  }
  if (p.kind === 'revolution') return { type: 'revolution', pid, reveal: false };
  if (p.kind === 'giveBack') return { type: 'giveBack', pid, cards: DMAI.chooseGiveBack(g, pid, p.k, 'normal') };
  if (g.trick) return { type: 'pass', pid };
  const c = DM.clone(g); c.players[pid].level = 'normal';
  return DMAI.decide(c);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.speed = env && env.FAST_TEST === '1' ? 0.1 : 1; // 로컬 테스트에서만 시간을 줄임
    ctx.blockConcurrencyWhile(async () => { this.room = (await ctx.storage.get('room')) || null; });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async init(code, isPublic) {
    if (this.room) return false;
    this.room = {
      v: 1, code, created: Date.now(), hostPid: null, gen: 0,
      settings: { ...DEFAULT_SETTINGS, public: !!isPublic },
      seats: Array.from({ length: DEFAULT_SETTINGS.max }, emptySeat),
      status: 'waiting', game: null, deadline: 0, pending: null,
    };
    await this.arm({ kind: 'cleanup', at: Date.now() + EMPTY_ROOM_MS });
    await this.save();
    return true;
  }
  async save() { if (this.room) await this.ctx.storage.put('room', this.room); }
  async arm(p) {
    if (!this.room) return;
    this.room.pending = p || null;
    this.room.deadline = p && p.visible ? p.at : 0;
    if (p) await this.ctx.storage.setAlarm(p.at);
    else await this.ctx.storage.deleteAlarm();
  }

  sockets() { return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1); }
  pidOf(ws) { try { return (ws.deserializeAttachment() || {}).pid || null; } catch (e) { return null; } }
  connectedPids(except) {
    const set = new Set();
    for (const ws of this.sockets()) if (ws !== except) { const p = this.pidOf(ws); if (p) set.add(p); }
    return set;
  }
  seatOf(pid) { return pid && this.room ? this.room.seats.findIndex((s) => s.pid === pid) : -1; }
  nextHost(exclude, online) {
    online = online || this.connectedPids();
    const s = this.room.seats.find((x) => x.kind === 'human' && x.pid !== exclude && online.has(x.pid));
    return s ? s.pid : null;
  }
  uniqueName(name, idx) {
    const taken = new Set(this.room.seats.filter((s, i) => i !== idx && s.kind !== 'empty').map((s) => s.name));
    if (!taken.has(name)) return name;
    for (let k = 2; k < 50; k++) { const n = Array.from(name).slice(0, 5).join('') + k; if (!taken.has(n)) return n; }
    return name;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    const pid = (url.searchParams.get('pid') || '').toLowerCase();
    const name = cleanName(url.searchParams.get('name'));
    server.serializeAttachment({ pid });
    const fail = (code, message) => {
      try { server.send(JSON.stringify({ t: 'error', fatal: true, code, message })); server.close(4000, code); } catch (e) { /* 이미 닫힘 */ }
      return new Response(null, { status: 101, webSocket: client });
    };
    if (!/^[a-f0-9]{16,64}$/.test(pid)) return fail('bad_player', '접속 정보가 올바르지 않아요. 새로고침해 주세요');
    if (!this.room) return fail('no_room', '없는 방이에요. 방 번호를 확인해 주세요');
    const res = this.join(pid, name);
    if (!res.ok) return fail(res.code, res.message);
    await this.afterChange({ lobby: true });
    return new Response(null, { status: 101, webSocket: client });
  }

  join(pid, name) {
    const r = this.room;
    let i = this.seatOf(pid);
    if (i >= 0) { // 다시 들어옴
      const s = r.seats[i];
      s.away = false; s.timeouts = 0;
      if (r.status === 'waiting') s.name = this.uniqueName(name, i);
      if (!r.hostPid || this.seatOf(r.hostPid) < 0) r.hostPid = pid;
      return { ok: true, seat: i };
    }
    if (r.status === 'waiting') {
      i = r.seats.findIndex((s) => s.kind === 'empty');
      if (i < 0) return { ok: false, code: 'full', message: '방이 꽉 찼어요' };
      r.seats[i] = { ...emptySeat(), kind: 'human', pid, name: this.uniqueName(name, i) };
      if (!r.hostPid || this.seatOf(r.hostPid) < 0) r.hostPid = pid;
      return { ok: true, seat: i };
    }
    // 게임 중이면 컴퓨터 자리를 이어받음 (예전 내 자리 먼저)
    let k = r.seats.findIndex((s) => s.kind === 'ai' && s.formerPid === pid);
    if (k < 0) k = r.seats.findIndex((s) => s.kind === 'ai');
    if (k < 0) return { ok: false, code: 'in_game', message: '게임이 진행 중이고 빈자리가 없어요' };
    const nm = this.uniqueName(name, k);
    r.seats[k] = { ...emptySeat(), kind: 'human', pid, name: nm };
    if (r.game) { r.game.players[k].name = nm; r.game.players[k].ai = false; }
    if (!r.hostPid || this.seatOf(r.hostPid) < 0) r.hostPid = pid;
    return { ok: true, seat: k };
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 2000) return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    const r = this.room;
    if (!r || !msg || typeof msg.t !== 'string') return;
    const pid = this.pidOf(ws);
    const seat = this.seatOf(pid);
    if (seat < 0) return;
    const s = r.seats[seat];
    const err = (message) => { try { ws.send(JSON.stringify({ t: 'error', message })); } catch (e) { /* 무시 */ } };
    if (s.away || s.timeouts) { s.away = false; s.timeouts = 0; } // 무엇이든 보내면 돌아온 것으로
    try {
      switch (msg.t) {
        case 'act': {
          if (r.status !== 'playing' || !r.game) return err('지금은 할 수 없어요');
          const a = msg.a || {};
          const type = String(a.type);
          let act;
          if (type === 'play') act = { type, pid: seat, v: a.v | 0, n: a.n | 0, j: a.j | 0 };
          else if (type === 'pass') act = { type, pid: seat };
          else if (type === 'giveBack') act = { type, pid: seat, cards: Array.isArray(a.cards) ? a.cards.slice(0, 3).map((x) => x | 0) : [] };
          else if (type === 'revolution') act = { type, pid: seat, reveal: !!a.reveal };
          else return err('모르는 행동이에요');
          if (a.seq != null && (a.seq | 0) !== r.game.seq) { err('이미 지나간 차례예요'); return this.afterChange(); }
          return this.play(act, err);
        }
        case 'ready': {
          if (r.game && r.game.phase === 'gameEnd') {
            s.ready = true;
            const online = this.connectedPids();
            const need = r.seats.filter((x) => x.kind === 'human' && online.has(x.pid) && !x.away);
            if (need.every((x) => x.ready)) return this.play({ type: 'nextGame' });
          }
          return this.afterChange();
        }
        case 'start':
          if (r.hostPid !== pid) return err('방장만 시작할 수 있어요');
          if (r.status !== 'waiting') return;
          return this.start();
        case 'settings': {
          if (r.hostPid !== pid || r.status !== 'waiting') return;
          const next = cleanSettings(r.settings, msg.settings);
          const humans = r.seats.filter((x) => x.kind === 'human').length;
          if (next.max < humans) { err('지금 들어온 사람보다 적게 줄일 수는 없어요'); next.max = r.settings.max; }
          const people = r.seats.filter((x) => x.kind === 'human');
          r.seats = people.concat(Array.from({ length: next.max - people.length }, emptySeat));
          r.settings = next;
          return this.afterChange({ lobby: true });
        }
        case 'again':
          if (r.hostPid !== pid || r.status !== 'ended') return;
          return this.backToWaiting();
        case 'leave':
          return this.leave(pid);
        case 'hello':
          return this.afterChange();
      }
    } catch (e) {
      console.error('message', e);
      err('서버에서 처리하지 못했어요');
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (e) { /* 이미 닫힘 */ }
    await this.dropped(ws);
  }
  async webSocketError(ws) { await this.dropped(ws); }

  async dropped(ws) {
    const r = this.room;
    if (!r) return;
    const pid = this.pidOf(ws);
    const i = this.seatOf(pid);
    if (i < 0) return;
    const online = this.connectedPids(ws);
    if (!online.has(pid)) {
      if (r.status === 'waiting') r.seats[i] = emptySeat();
      // 게임 중에는 자리를 남겨 두고 컴퓨터가 대신 둠. 다시 들어오면 이어서
      if (r.hostPid === pid) { const h = this.nextHost(pid, online); if (h) r.hostPid = h; }
    }
    await this.afterChange({ lobby: true, except: ws });
  }

  async leave(pid) {
    const r = this.room;
    const i = this.seatOf(pid);
    if (i >= 0) {
      if (r.status === 'waiting') r.seats[i] = emptySeat();
      else {
        const s = r.seats[i];
        r.seats[i] = { ...emptySeat(), kind: 'ai', name: s.name, formerPid: pid };
        if (r.game) { r.game.players[i].ai = true; r.game.players[i].level = 'normal'; }
      }
      if (r.hostPid === pid) r.hostPid = this.nextHost(pid);
    }
    for (const w of this.ctx.getWebSockets()) if (this.pidOf(w) === pid) { try { w.close(1000, 'left'); } catch (e) { /* 무시 */ } }
    await this.afterChange({ lobby: true });
  }

  async start() {
    const r = this.room;
    const used = new Set(r.seats.filter((s) => s.kind === 'human').map((s) => s.name));
    const pool = AI_NAMES.filter((n) => !used.has(n));
    let k = 0;
    r.seats = r.seats.slice(0, r.settings.max).map((s) => {
      if (s.kind !== 'empty') return { ...s, ready: false, away: false, timeouts: 0 };
      return { ...emptySeat(), kind: 'ai', name: pool[k++ % pool.length] };
    });
    const players = r.seats.map((s) => ({ name: s.name, ai: s.kind === 'ai', level: r.settings.level }));
    let g = DM.newMatch({ players, games: r.settings.games, firstTax: r.settings.firstTax, seed: rand32() || 1 });
    g = DM.apply(g, { type: 'drawRanks' });
    r.game = g;
    r.status = 'playing';
    r.gen += 1;
    await this.afterChange({ lobby: true });
  }

  async backToWaiting() {
    const r = this.room;
    const online = this.connectedPids();
    const people = r.seats.filter((s) => s.kind === 'human' && online.has(s.pid))
      .map((s) => ({ ...emptySeat(), kind: 'human', pid: s.pid, name: s.name }));
    r.seats = people.concat(Array.from({ length: Math.max(0, r.settings.max - people.length) }, emptySeat));
    r.status = 'waiting';
    r.game = null;
    await this.afterChange({ lobby: true });
  }

  async play(a, err) {
    const r = this.room;
    try { r.game = DM.apply(r.game, a); }
    catch (e) { if (err) err(e.message); return this.afterChange(); }
    const g = r.game;
    if (g.phase === 'gameEnd') r.seats.forEach((s) => { s.ready = false; });
    if (g.phase === 'matchEnd') r.status = 'ended';
    await this.afterChange({ lobby: g.phase === 'matchEnd' });
  }

  /* ── 다음에 할 일 예약 ── */
  async schedule(online) {
    const r = this.room;
    if (!r) return;
    const now = Date.now();
    const anyone = r.seats.some((s) => s.kind === 'human' && online.has(s.pid));
    if (!anyone) return this.arm({ kind: 'cleanup', at: now + EMPTY_ROOM_MS });
    if (r.status !== 'playing' || !r.game) return this.arm(null);
    const g = r.game, p = r.pending, step = g.seq;
    const keep = (kind, seat) => p && p.step === step && p.kind === kind && (seat == null || p.seat === seat);
    if (g.phase === 'drawn') return this.arm(keep('deal') ? p : { kind: 'deal', step, at: now + DRAW_MS * this.speed });
    if (g.phase === 'gameEnd') return this.arm(keep('next') ? p : { kind: 'next', step, at: now + NEXT_MS * this.speed, visible: true });
    const pend = DM.pending(g);
    if (!pend) return this.arm(null);
    const actor = pend.pid, seat = r.seats[actor];
    const live = seat.kind === 'human' && online.has(seat.pid) && !seat.away;
    if (live) {
      // 낼 카드가 없어도 사람은 자동으로 넘기지 않음 — 바로 넘어가면 그 사람에게 더 작은 카드가 없다는 게 드러남
      if (keep('timeout', actor)) return this.arm(p);
      return this.arm({ kind: 'timeout', seat: actor, step, at: now + r.settings.turnSec * 1000 * this.speed, visible: true });
    }
    if (keep('ai', actor)) return this.arm(p);
    const ms = seat.kind === 'human' ? AWAY_MS : between(AI_MS[pend.kind] || AI_MS.play);
    return this.arm({ kind: 'ai', seat: actor, step, at: now + ms * this.speed });
  }

  async alarm() {
    const r = this.room;
    if (!r || !r.pending) return;
    const p = r.pending;
    try {
      if (p.kind === 'cleanup') {
        if (this.connectedPids().size) { await this.afterChange(); return; }
        await this.removeFromLobby();
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.room = null;
        return;
      }
      const g = r.game;
      if (!g || r.status !== 'playing' || g.seq !== p.step) { r.pending = null; await this.afterChange(); return; }
      if (p.kind === 'deal') return this.play({ type: 'deal' });
      if (p.kind === 'next') return this.play({ type: 'nextGame' });
      const seat = r.seats[p.seat];
      if (p.kind === 'timeout') {
        seat.timeouts = (seat.timeouts || 0) + 1;
        if (seat.timeouts >= 2) seat.away = true; // 두 번 연속 시간 초과면 자리 비움으로 보고 빨리 대신 둠
      }
      const a = autoAction(g, p.seat, p.kind === 'ai');
      if (a) {
        if (p.kind === 'timeout') this.timedOut = p.seat;
        await this.play(a);
      } else { r.pending = null; await this.afterChange(); }
    } catch (e) {
      console.error('alarm', e);
      r.pending = null;
      await this.afterChange();
    }
  }

  async afterChange(opt = {}) {
    const online = this.connectedPids(opt.except);
    await this.schedule(online);
    await this.save();
    this.broadcast(online);
    this.timedOut = null;
    if (opt.lobby) await this.notifyLobby(online);
  }

  broadcast(online) {
    const r = this.room;
    if (!r) return;
    const seats = r.seats.map((s) => ({
      kind: s.kind, name: s.name, away: !!s.away, ready: !!s.ready,
      online: s.kind === 'human' && online.has(s.pid),
    }));
    const base = { code: r.code, status: r.status, settings: r.settings, seats, host: this.seatOf(r.hostPid), gen: r.gen, deadline: r.deadline || 0 };
    const g = r.game;
    // 혁명 고민 중인 사람의 남은 시간은 본인에게만 (누가 어릿광대 둘을 가졌는지 드러나지 않게)
    const hideFor = g && g.phase === 'revolution' && r.pending && r.pending.seat != null ? r.pending.seat : -1;
    for (const ws of this.sockets()) {
      const seat = this.seatOf(this.pidOf(ws));
      const msg = {
        t: 'state', now: Date.now(), seat,
        room: hideFor >= 0 && hideFor !== seat ? { ...base, deadline: 0 } : base,
        view: g && seat >= 0 ? DM.viewFor(g, seat) : null,
        timedOut: this.timedOut === seat ? true : undefined,
      };
      try { ws.send(JSON.stringify(msg)); } catch (e) { /* 끊긴 소켓 */ }
    }
  }

  async notifyLobby(online) {
    const r = this.room;
    if (!r) return;
    online = online || this.connectedPids();
    const humans = r.seats.filter((s) => s.kind === 'human' && online.has(s.pid)).length;
    try { await lobbyStub(this.env).update({ code: r.code, public: r.settings.public, status: r.status, humans, max: r.settings.max }); }
    catch (e) { console.error('lobby', e); }
  }
  async removeFromLobby() { try { await lobbyStub(this.env).remove(this.room.code); } catch (e) { /* 무시 */ } }
}

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rooms = {};
    ctx.blockConcurrencyWhile(async () => { this.rooms = (await ctx.storage.get('rooms')) || {}; });
  }
  async save() { await this.ctx.storage.put('rooms', this.rooms); }
  prune() {
    const now = Date.now();
    for (const [c, r] of Object.entries(this.rooms)) if (now - r.updated > 2 * 60 * 60 * 1000) delete this.rooms[c];
  }
  async update(info) {
    if (!info || !info.code) return;
    const cur = this.rooms[info.code];
    if (!info.public) { if (cur) { delete this.rooms[info.code]; await this.save(); } return; }
    this.rooms[info.code] = { ...cur, ...info, created: cur ? cur.created : Date.now(), updated: Date.now() };
    this.prune();
    await this.save();
  }
  async remove(code) { if (this.rooms[code]) { delete this.rooms[code]; await this.save(); } }
  open() {
    const now = Date.now();
    return Object.values(this.rooms).filter((r) => r.public && r.status === 'waiting' && r.humans < r.max && now - r.updated < OPEN_ROOM_TTL);
  }
  // 사람이 기다리는 공개 방 → 막 만든 빈 공개 방 → 새로 만들기
  async quick() {
    const open = this.open().sort((a, b) => b.humans - a.humans || a.created - b.created);
    if (open.length) { open[0].updated = Date.now(); return { code: open[0].code }; }
    for (let k = 0; k < 6; k++) {
      const code = randomCode();
      if (await roomStub(this.env, code).init(code, true)) {
        const now = Date.now();
        this.rooms[code] = { code, public: true, status: 'waiting', humans: 0, max: DEFAULT_SETTINGS.max, created: now, updated: now };
        await this.save();
        return { code };
      }
    }
    throw new Error('방을 만들지 못했어요');
  }
  async stats() {
    const now = Date.now();
    const open = this.open();
    const playing = Object.values(this.rooms).filter((r) => r.public && r.status === 'playing' && now - r.updated < 60 * 60 * 1000).length;
    return { waitingRooms: open.filter((r) => r.humans > 0).length, waitingPlayers: open.reduce((n, r) => n + r.humans, 0), playingRooms: playing };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (url.pathname === '/api/quick' && request.method === 'POST') return json(await lobbyStub(env).quick());
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (e) { /* 빈 본문 */ }
        const isPublic = !!(body && body.public);
        for (let k = 0; k < 6; k++) {
          const code = randomCode();
          if (await roomStub(env, code).init(code, isPublic)) {
            if (isPublic) await lobbyStub(env).update({ code, public: true, status: 'waiting', humans: 0, max: DEFAULT_SETTINGS.max });
            return json({ code });
          }
        }
        return json({ error: '방을 만들지 못했어요' }, 500);
      }
      if (url.pathname === '/api/stats') return json(await lobbyStub(env).stats());
      const m = url.pathname.match(/^\/ws\/(\d{6})$/);
      if (m) {
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426, headers: CORS });
        return roomStub(env, m[1]).fetch(request);
      }
      if (url.pathname === '/') return new Response('달무티 서버가 돌고 있어요', { headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS } });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: '서버 오류가 났어요' }, 500);
    }
  },
};
