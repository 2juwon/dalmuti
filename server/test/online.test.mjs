/* 로컬 서버(wrangler dev --var FAST_TEST:1)에 봇 여러 명을 붙여 온라인 흐름을 끝까지 확인
 *   cd server && npx wrangler dev --var FAST_TEST:1  (다른 창)
 *   node test/online.test.mjs
 * 모든 메시지마다 남의 패·씨앗·남끼리의 세금 카드·숨긴 혁명이 새지 않는지 검사한다.
 */
import { createRequire } from 'module';
import assert from 'assert';
const require = createRequire(import.meta.url);
const DM = require('../../src/engine.js');
const AI = require('../../src/ai.js');
AI.budget = 40;

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const WSB = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newPid = () => crypto.randomUUID().replace(/-/g, '');
let checked = 0;

function checkPrivacy(m) {
  const v = m.view;
  if (!v) return;
  checked++;
  const reveal = v.phase === 'gameEnd' || v.phase === 'matchEnd';
  assert.strictEqual(v.seed, 0, '씨앗이 보임');
  v.players.forEach((p, i) => {
    if (i !== m.seat && !reveal) assert.strictEqual(p.hand, null, `남의 패가 보임 (자리 ${i})`);
    assert.strictEqual(typeof p.count, 'number');
  });
  assert.ok(Array.isArray(v.players[m.seat].hand), '내 패가 없음');
  if (v.tax) for (const p of v.tax.pairs) {
    if (p.from === m.seat || p.to === m.seat) continue;
    assert.ok(p.taken.every((x) => x === 0), '남끼리 세금 카드가 보임');
    if (p.given) assert.ok(p.given.every((x) => x === 0), '남끼리 돌려준 카드가 보임');
  }
  if (v.revolution && v.revolution.reveal !== true) {
    assert.ok(v.revolution.pid === m.seat || v.revolution.pid === -1, '숨긴 혁명/고민 중인 사람이 보임');
    if (v.revolution.pid === -1) assert.strictEqual(m.room.deadline, 0, '남의 혁명 고민 시간이 보임');
  }
}

class Bot {
  constructor(name, code, opts = {}) {
    Object.assign(this, { name, code, pid: opts.pid || newPid(), auto: opts.auto !== false, idle: !!opts.idle });
    this.errors = []; this.last = null; this.count = 0; this.sentFor = null; this.readyFor = new Set(); this.timedOut = 0;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WSB}/ws/${this.code}?pid=${this.pid}&name=${encodeURIComponent(this.name)}`);
      this.ws = ws; this.closed = false;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('ws error ' + this.name));
      ws.onclose = () => { this.closed = true; };
      ws.onmessage = (e) => {
        if (e.data === 'pong') return;
        const m = JSON.parse(e.data);
        if (m.t === 'error') { this.errors.push(m); return; }
        if (m.t !== 'state') return;
        this.last = m; this.count++;
        if (m.timedOut) this.timedOut++;
        checkPrivacy(m);
        this.watch(m);
        if (this.auto) this.react(m);
      };
    });
  }
  // 내 차례가 언제 시작해서 언제 넘어갔는지 (낼 카드가 없을 때 일찍 넘어가지 않는지 보려고)
  watch(m) {
    const v = m.view;
    if (!v || v.phase !== 'play') return;
    const p = DM.pending(v);
    if (p && p.pid === m.seat && this.turnSeq !== v.seq) { this.turnSeq = v.seq; this.turnAt = Date.now(); this.turnNoMove = !!v.trick && DM.moves(v, m.seat).length === 0; this.turnAway = !!m.room.seats[m.seat].away; }
    const last = v.log[v.log.length - 1];
    if (last && last.t === 'pass' && last.pid === m.seat && this.turnAt && this.turnSeq === v.seq - 1) {
      if (!this.turnAway) (this.passWaits = this.passWaits || []).push({ ms: Date.now() - this.turnAt, noMove: this.turnNoMove }); // 자리 비움이면 컴퓨터가 빨리 대신 두는 게 맞음
      this.turnAt = 0;
    }
  }
  react(m) {
    const v = m.view;
    if (!v || m.room.status !== 'playing') return;
    if (v.phase === 'gameEnd') {
      if (!this.readyFor.has(v.gameNo)) { this.readyFor.add(v.gameNo); setTimeout(() => this.send({ t: 'ready' }), 20); }
      return;
    }
    if (this.idle) return;
    const p = DM.pending(v);
    if (!p || p.pid !== m.seat) return;
    const c = DM.clone(v); c.players[m.seat].level = 'normal';
    const a = AI.decide(c);
    if (!a) return;
    if (a.type === 'revolution') a.reveal = Math.random() < 0.5;
    const key = v.seq;
    if (this.sentFor === key) return;
    this.sentFor = key;
    setTimeout(() => this.send({ t: 'act', a: { ...a, seq: v.seq } }), 10);
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  close() { this.ws.close(); }
}

async function api(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(30); }
  throw new Error('시간 초과: ' + what);
}

/* 1) 사람 3명(그중 1명은 아무것도 안 함) + 컴퓨터 2명, 3판 끝까지 */
{
  const { code } = await api('/api/rooms');
  const a = new Bot('가나', code), b = new Bot('다라', code), idle = new Bot('잠꾸러기', code, { idle: true });
  await a.connect(); await b.connect(); await idle.connect();
  await until(() => a.last && a.last.room.seats.filter((s) => s.kind === 'human').length === 3, 3000, '3명 입장');
  assert.strictEqual(a.last.room.host, 0, '첫 사람이 방장');
  b.send({ t: 'start' });
  await sleep(150);
  assert.ok(b.errors.some((e) => /방장만/.test(e.message)), '방장 아닌 사람은 시작 못 함');
  a.send({ t: 'settings', settings: { max: 5, games: 3, turnSec: 10, level: 'hard', firstTax: true, public: false } });
  await until(() => a.last.room.settings.games === 3 && a.last.room.settings.turnSec === 10, 2000, '설정');
  a.send({ t: 'start' });
  await until(() => a.last.view && a.last.view.phase === 'drawn', 3000, '계급 뽑기');
  assert.strictEqual(a.last.view.players.length, 5);
  // 첫 차례가 오기 전엔 남은 시간 표시 없음, 뽑기 후 자동으로 나눔
  await until(() => a.last.view.phase !== 'drawn', 3000, '자동으로 카드 나누기');
  // 잠꾸러기가 시간 초과로 자동 패스/자동 진행 되는지
  await until(() => idle.timedOut >= 1, 20000, '시간 초과 알림');
  await until(() => (idle.passWaits || []).some((w) => w.noMove), 60000, '낼 카드가 없는 잠꾸러기 차례');
  const early = idle.passWaits.filter((w) => w.noMove && w.ms < 850);
  assert.deepStrictEqual(early, [], '낼 카드가 없어도 제한 시간 전에 넘어가면 안 됨 ' + JSON.stringify(idle.passWaits));
  await until(() => a.last.room.seats[idle.last.seat].away, 30000, '두 번 시간 초과면 자리 비움');
  await until(() => a.last.room.status === 'ended', 120000, '3판 끝까지');
  const v = a.last.view;
  assert.strictEqual(v.phase, 'matchEnd'); assert.strictEqual(v.gameNo, 3);
  const total = v.players.reduce((n, p) => n + p.score, 0);
  assert.strictEqual(total, 3 * (4 * 5 / 2), '점수 합');
  assert.deepStrictEqual(a.errors.filter((e) => !/지나간 차례/.test(e.message)), [], '봇 오류 없음 ' + JSON.stringify(a.errors));
  // 한 번 더 → 대기실, 접속 중인 사람만 남음
  idle.close(); await sleep(200);
  a.send({ t: 'again' });
  await until(() => a.last.room.status === 'waiting', 3000, '대기실로');
  assert.strictEqual(a.last.room.seats.filter((s) => s.kind === 'human').length, 2);
  a.close(); b.close();
  console.log('✓ 3판 완주, 시간 초과 자동 진행·자리 비움, 한 번 더');
}

/* 2) 게임 중 끊겼다 다시 들어오기, 나가기 → 컴퓨터가 이어받음, 다른 사람이 그 자리로 들어오기 */
{
  const { code } = await api('/api/rooms');
  const a = new Bot('하나', code), b = new Bot('두울', code);
  await a.connect(); await b.connect();
  await until(() => a.last && a.last.room.seats.filter((s) => s.kind === 'human').length === 2, 3000, '입장');
  a.send({ t: 'settings', settings: { max: 4, games: 10, turnSec: 10 } });
  await sleep(100);
  a.send({ t: 'start' });
  await until(() => b.last.view && b.last.view.phase === 'play', 5000, '판 시작');
  const seatB = b.last.seat;
  b.close();
  await until(() => a.last.room.seats[seatB].online === false, 3000, '끊김 표시');
  const b2 = new Bot('두울', code, { pid: b.pid });
  await b2.connect();
  await until(() => b2.last && b2.last.seat === seatB, 3000, '같은 자리로 복귀');
  assert.ok(b2.last.view && Array.isArray(b2.last.view.players[seatB].hand), '복귀하면 내 패가 보임');
  b2.send({ t: 'leave' });
  await until(() => a.last.room.seats[seatB].kind === 'ai', 3000, '나가면 컴퓨터가 이어받음');
  const c = new Bot('세엣', code);
  await c.connect();
  await until(() => c.last && c.last.seat === seatB, 3000, '새 사람이 컴퓨터 자리로');
  assert.strictEqual(c.last.view.players[seatB].name, '세엣');
  a.close(); c.close();
  console.log('✓ 끊김·복귀, 나가기, 중간 참가');
}

/* 3) 빠른 참가는 같은 방으로, 꽉 차면 못 들어옴 */
{
  const r1 = await api('/api/quick');
  const x = new Bot('빠른1', r1.code); await x.connect();
  await until(() => x.last, 2000, '빠른 참가 입장');
  const r2 = await api('/api/quick');
  assert.strictEqual(r2.code, r1.code, '빠른 참가는 기다리는 방으로');
  const bots = [];
  for (let i = 0; i < 4; i++) { const y = new Bot('빠' + i, r1.code); await y.connect(); bots.push(y); }
  await until(() => x.last.room.seats.filter((s) => s.kind === 'human').length === 5, 3000, '5명');
  const full = new Bot('넘침', r1.code); await full.connect();
  await until(() => full.errors.length, 2000, '꽉 참 오류');
  assert.strictEqual(full.errors[0].code, 'full');
  const r3 = await api('/api/quick');
  assert.notStrictEqual(r3.code, r1.code, '꽉 찬 방엔 안 보냄');
  x.close(); bots.forEach((b) => b.close());
  console.log('✓ 빠른 참가, 꽉 찬 방');
}

/* 4) 이상한 행동은 거절 */
{
  const { code } = await api('/api/rooms');
  const a = new Bot('검사', code, { auto: false }), b = new Bot('검사2', code, { auto: false });
  await a.connect(); await b.connect();
  await until(() => a.last && a.last.room.seats.filter((s) => s.kind === 'human').length === 2, 3000, '입장');
  a.send({ t: 'settings', settings: { max: 4, firstTax: false } });
  await sleep(80);
  a.send({ t: 'start' });
  await until(() => a.last.view && a.last.view.phase === 'play', 5000, '판 시작');
  const v = a.last.view, me = a.last.seat, other = v.turn === me ? b : a;
  other.send({ t: 'act', a: { type: 'play', v: 12, n: 1, j: 0 } });
  await until(() => other.errors.length, 2000, '차례 아닌 사람 거절');
  const bad = other === a ? b : a;
  bad.send({ t: 'act', a: { type: 'play', v: 1, n: 5, j: 0 } });
  await until(() => bad.errors.length, 2000, '없는 카드 거절');
  bad.send({ t: 'act', a: { type: 'hack' } });
  await until(() => bad.errors.length >= 2, 2000, '모르는 행동 거절');
  a.close(); b.close();
  console.log('✓ 이상한 행동 거절');
}

console.log(`모두 통과 · 정보 노출 검사 ${checked}번`);
process.exit(0);
