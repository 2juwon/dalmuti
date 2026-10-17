const DM = require('../src/engine.js');
const AI = require('../src/ai.js');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('✗', name, '\n  ', e.message); } }
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' 기대 ' + JSON.stringify(b) + ' 실제 ' + JSON.stringify(a)); }
function ok(c, m) { if (!c) throw new Error(m || '조건 실패'); }
function throws(fn, m) { let th = false; try { fn(); } catch (e) { th = true; } if (!th) throw new Error(m || '에러가 나야 함'); }

function match(n, opts) {
  const players = []; for (let i = 0; i < n; i++) players.push({ name: 'P' + i, ai: i > 0 });
  return DM.newMatch(Object.assign({ players, games: 3, seed: 7 }, opts || {}));
}
function hand(spec) { const h = DM.zeros(); for (const k in spec) h[+k] = spec[k]; return h; }
// 손패를 직접 정한 '판 진행 중' 상태
function playState(hands, opts) {
  const s = match(hands.length, opts);
  s.ranks = hands.map((_, i) => i); s.phase = 'play'; s.gameNo = 1; s.turn = 0;
  s.players.forEach((p, i) => p.hand = hand(hands[i]));
  const d = DM.deckCounts();
  s.played = DM.zeros();
  for (let v = 1; v < 14; v++) { let held = 0; s.players.forEach(p => held += p.hand[v]); s.played[v] = Math.max(0, d[v] - held); }
  return s;
}
function total(s) { let c = 0; s.players.forEach(p => c += DM.handSize(p.hand)); for (let v = 1; v < 14; v++) c += s.played[v]; return c; }

t('덱은 80장, 숫자별 장수', () => { const d = DM.deckCounts(); let c = 0; for (let v = 1; v < 14; v++) c += d[v]; eq(c, 80); eq(d[12], 12); eq(d[13], 2); });
t('계급 이름', () => {
  eq(DM.rankNames(4), ['달무티', '총리대신', '소작농', '농노']);
  eq(DM.rankNames(6), ['달무티', '총리대신', '상인', '상인', '소작농', '농노']);
});
for (const n of [4, 5, 6, 7, 8]) t(n + '명 나누기: 장수와 남는 카드는 낮은 계급에게', () => {
  let s = DM.apply(match(n, { firstTax: false }), { type: 'drawRanks' });
  ok(s.ranks.length === n && new Set(s.ranks).size === n);
  s = DM.apply(s, { type: 'deal' });
  const sizes = s.ranks.map(pid => DM.handSize(s.players[pid].hand));
  const base = Math.floor(80 / n), r = 80 % n;
  sizes.forEach((c, i) => eq(c, base + (i >= n - r ? 1 : 0), '계급 ' + i));
  eq(total(s), 80);
});
t('계급 뽑기: 작은 수를 뽑은 사람이 높은 계급', () => {
  for (let seed = 1; seed < 40; seed++) {
    const s = DM.apply(match(6, { seed }), { type: 'drawRanks' });
    const last = pid => s.draws[pid][s.draws[pid].length - 1];
    const first = pid => s.draws[pid][0];
    for (let i = 0; i + 1 < s.ranks.length; i++) ok(first(s.ranks[i]) <= first(s.ranks[i + 1]), '첫 뽑기 순서');
    ok(last(s.ranks[0]) !== undefined);
  }
});
t('세금: 농노는 가장 작은 숫자 2장, 소작농은 1장을 바침 → 돌려주기', () => {
  for (let seed = 1; seed < 60; seed++) {
    let s = DM.apply(match(5, { seed }), { type: 'drawRanks' });
    s = DM.apply(s, { type: 'deal' });
    if (s.phase === 'revolution') s = DM.apply(s, { type: 'revolution', pid: s.revolution.pid, reveal: false });
    eq(s.phase, 'taxReturn');
    const [a, b] = s.tax.pairs;
    eq(a.from, s.ranks[4]); eq(a.to, s.ranks[0]); eq(a.taken.length, 2);
    eq(b.from, s.ranks[3]); eq(b.to, s.ranks[1]); eq(b.taken.length, 1);
    const fh = s.players[a.from].hand;
    ok(a.taken.every(v => v <= 12), '어릿광대는 바치지 않음');
    for (let v = 1; v < a.taken[1]; v++) eq(fh[v], 0, '더 작은 숫자가 남으면 안 됨 v=' + v);
    throws(() => DM.apply(s, { type: 'giveBack', pid: a.to, cards: [1] }), '장수 틀림');
    const g1 = AI.chooseGiveBack(s, a.to, 2, 'normal', Math.random);
    s = DM.apply(s, { type: 'giveBack', pid: a.to, cards: g1 });
    eq(s.phase, 'taxReturn');
    s = DM.apply(s, { type: 'giveBack', pid: b.to, cards: AI.chooseGiveBack(s, b.to, 1, 'normal', Math.random) });
    eq(s.phase, 'play'); eq(s.turn, s.ranks[0]);
    const sizes = s.ranks.map(pid => DM.handSize(s.players[pid].hand));
    eq(sizes, [16, 16, 16, 16, 16]); eq(total(s), 80);
  }
});
t('첫 판 세금 없음 옵션', () => {
  let s = DM.apply(match(5, { firstTax: false }), { type: 'drawRanks' });
  s = DM.apply(s, { type: 'deal' }); eq(s.phase, 'play'); eq(s.tax, null);
});
t('돌려줄 때 가장 쓸모없는 낱장을 고름 (10 한 장 vs 12 다섯 장 → 10)', () => {
  const s = playState([{ 1: 1, 2: 2, 10: 1, 12: 5 }, { 3: 1 }, { 4: 1 }, { 5: 1 }]);
  eq(AI.chooseGiveBack(s, 0, 1, 'normal'), [10]);
});
t('같은 숫자를 원하는 만큼 선으로 냄, 따라 낼 땐 같은 장수·더 작은 수', () => {
  let s = playState([{ 9: 4, 1: 1 }, { 6: 4, 3: 1 }, { 4: 4, 5: 1 }, { 8: 3 }]);
  s = DM.apply(s, { type: 'play', pid: 0, v: 9, n: 4 });
  eq(s.trick, { v: 9, count: 4, by: 0 });
  throws(() => DM.apply(s, { type: 'play', pid: 1, v: 6, n: 3 }), '장수 다름');
  throws(() => DM.apply(s, { type: 'play', pid: 0, v: 1, n: 1 }), '차례 아님');
  s = DM.apply(s, { type: 'play', pid: 1, v: 6, n: 4 });
  throws(() => DM.apply(s, { type: 'play', pid: 2, v: 6, n: 4 }), '같은 수는 못 냄');
  s = DM.apply(s, { type: 'play', pid: 2, v: 4, n: 4 });
  eq(s.turn, 3);
});
t('어릿광대: 혼자면 13, 함께 내면 그 수', () => {
  let s = playState([{ 3: 2, 9: 1 }, { 2: 1, 13: 1, 7: 1 }, { 1: 1, 13: 1, 8: 1 }, { 12: 3 }]);
  s = DM.apply(s, { type: 'play', pid: 0, v: 3, n: 2 });
  s = DM.apply(s, { type: 'play', pid: 1, v: 2, n: 1, j: 1 });
  eq(s.trick.v, 2); eq(s.trick.count, 2);
  s = DM.apply(s, { type: 'play', pid: 2, v: 1, n: 1, j: 1 });
  eq(s.trick.v, 1);
  throws(() => DM.apply(playState([{ 13: 1, 5: 1 }, {}, {}, {}]), { type: 'play', pid: 0, v: 5, n: 0, j: 1 }), '어릿광대만으로 5는 안 됨');
  let s2 = playState([{ 13: 2, 5: 1 }, { 12: 2 }, { 11: 1 }, { 10: 1 }]);
  s2 = DM.apply(s2, { type: 'play', pid: 0, v: 13, n: 0, j: 2 });
  eq(s2.trick.v, 13);
  s2 = DM.apply(s2, { type: 'play', pid: 1, v: 12, n: 2 });
  eq(s2.trick.v, 12);
});
t('선은 패스 못 함, 낼 수 있어도 작전상 패스 가능', () => {
  let s = playState([{ 9: 1, 5: 1 }, { 2: 1, 7: 1 }, { 4: 1, 8: 1 }, { 6: 1, 3: 1 }]);
  throws(() => DM.apply(s, { type: 'pass', pid: 0 }));
  s = DM.apply(s, { type: 'play', pid: 0, v: 9, n: 1 });
  s = DM.apply(s, { type: 'pass', pid: 1 });
  eq(s.turn, 2);
});
t('패스가 한 바퀴 돌면 마지막에 낸 사람이 새 선, 패스한 사람도 다음 차례에 다시 낼 수 있음', () => {
  let s = playState([{ 9: 1, 5: 1 }, { 2: 1, 7: 1 }, { 4: 1, 8: 1 }, { 6: 1, 3: 1 }]);
  s = DM.apply(s, { type: 'play', pid: 0, v: 9, n: 1 });
  s = DM.apply(s, { type: 'pass', pid: 1 });
  s = DM.apply(s, { type: 'play', pid: 2, v: 8, n: 1 });
  s = DM.apply(s, { type: 'pass', pid: 3 });
  s = DM.apply(s, { type: 'pass', pid: 0 });
  eq(s.turn, 1, '패스했던 1번에게 다시 기회');
  s = DM.apply(s, { type: 'play', pid: 1, v: 7, n: 1 });
  s = DM.apply(s, { type: 'pass', pid: 2 });
  s = DM.apply(s, { type: 'pass', pid: 3 });
  s = DM.apply(s, { type: 'pass', pid: 0 });
  eq(s.trick, null); eq(s.turn, 1); eq(s.prevTrick.by, 1);
});
t('다 털고 나간 사람의 판이면 그 다음 사람이 선', () => {
  let s = playState([{ 9: 1 }, { 2: 1, 7: 1 }, { 4: 1, 8: 1 }, { 6: 1, 3: 1 }]);
  s = DM.apply(s, { type: 'play', pid: 0, v: 9, n: 1 });
  eq(s.finished, [0]);
  s = DM.apply(s, { type: 'pass', pid: 1 });
  s = DM.apply(s, { type: 'pass', pid: 2 });
  eq(s.trick.v, 9);
  s = DM.apply(s, { type: 'pass', pid: 3 });
  eq(s.trick, null); eq(s.turn, 1);
});
t('남은 한 사람은 자동으로 꼴등, 점수와 다음 판 계급', () => {
  let s = playState([{ 9: 1 }, { 2: 1 }, { 4: 1, 8: 1 }, { 6: 1, 3: 2 }]);
  s = DM.apply(s, { type: 'play', pid: 0, v: 9, n: 1 });
  s = DM.apply(s, { type: 'play', pid: 1, v: 2, n: 1 });
  eq(s.finished, [0, 1]);
  s = DM.apply(s, { type: 'pass', pid: 2 }); s = DM.apply(s, { type: 'pass', pid: 3 });
  eq(s.turn, 2, '1번이 나간 판이라 다음 사람 2번이 선');
  s = DM.apply(s, { type: 'play', pid: 2, v: 8, n: 1 });
  s = DM.apply(s, { type: 'play', pid: 3, v: 6, n: 1 });
  s = DM.apply(s, { type: 'play', pid: 2, v: 4, n: 1 });
  eq(s.phase, 'gameEnd'); eq(s.finished, [0, 1, 2, 3]);
  eq(s.players.map(p => p.score), [3, 2, 1, 0]);
  s = DM.apply(s, { type: 'nextGame' });
  eq(s.ranks, [0, 1, 2, 3]); eq(s.gameNo, 2);
});
t('정해진 판 수가 끝나면 matchEnd, 순위는 총점', () => {
  let s = playState([{ 9: 1 }, { 2: 1 }, { 4: 1 }, { 6: 1 }]);
  s.games = 1;
  s = DM.apply(s, { type: 'play', pid: 0, v: 9, n: 1 });
  s = DM.apply(s, { type: 'play', pid: 1, v: 2, n: 1 });
  s = DM.apply(s, { type: 'pass', pid: 2 }); s = DM.apply(s, { type: 'pass', pid: 3 });
  s = DM.apply(s, { type: 'play', pid: 2, v: 4, n: 1 });
  eq(s.phase, 'matchEnd'); eq(DM.standings(s), [0, 1, 2, 3]);
});
function revoState(holderRank) {
  for (let seed = 1; seed < 5000; seed++) {
    let s = DM.apply(match(6, { seed }), { type: 'drawRanks' });
    s = DM.apply(s, { type: 'deal' });
    if (s.phase === 'revolution' && s.ranks.indexOf(s.revolution.pid) === holderRank) return s;
  }
  throw new Error('상황을 못 찾음');
}
t('대혁명: 농노가 어릿광대 2장을 공개하면 계급이 뒤집히고 세금 없음', () => {
  let s = revoState(5); const before = s.ranks.slice();
  ok(AI.chooseRevolution(s, s.revolution.pid));
  s = DM.apply(s, { type: 'revolution', pid: s.revolution.pid, reveal: true });
  eq(s.revolution.kind, 'great'); eq(s.ranks, before.slice().reverse()); eq(s.phase, 'play'); eq(s.turn, before[5]); eq(s.tax, null);
});
t('혁명: 다른 계급이 공개하면 계급은 그대로, 세금만 없음', () => {
  let s = revoState(2); const before = s.ranks.slice();
  s = DM.apply(s, { type: 'revolution', pid: s.revolution.pid, reveal: true });
  eq(s.revolution.kind, 'normal'); eq(s.ranks, before); eq(s.phase, 'play'); eq(s.tax, null);
});
t('혁명 숨기면 세금 진행, 높은 계급 컴퓨터는 숨김', () => {
  let s = revoState(0);
  ok(!AI.chooseRevolution(s, s.revolution.pid));
  s = DM.apply(s, { type: 'revolution', pid: s.revolution.pid, reveal: false });
  eq(s.phase, 'taxReturn');
});
t('가능한 수 목록', () => {
  let s = playState([{ 5: 2, 13: 1 }, { 9: 1 }, { 9: 1 }, { 9: 1 }]);
  const lead = DM.moves(s, 0);
  ok(lead.some(m => m.v === 5 && m.n === 2 && m.j === 1));
  ok(lead.some(m => m.v === 13 && m.j === 1));
  eq(lead.length, 5); // 5x1,5x1+J,5x2,5x2+J,J
  s.trick = { v: 6, count: 3, by: 1 }; s.turn = 0;
  eq(DM.moves(s, 0), [{ v: 5, n: 2, j: 1 }]);
  lead.forEach(m => eq(DM.check(Object.assign({}, playState([{ 5: 2, 13: 1 }, { 9: 1 }, { 9: 1 }, { 9: 1 }])), 0, m), null));
});
t('확실히 이기는 수 판단', () => {
  const s = playState([{ 1: 1, 5: 1 }, { 9: 3, 2: 1 }, { 9: 3 }, { 9: 3 }]);
  ok(AI.sureWin(s, 0, 1, 1));
  ok(!AI.sureWin(s, 0, 5, 1));
});
t('컴퓨터: 마지막 묶음이면 어릿광대까지 한꺼번에', () => {
  const s = playState([{ 7: 2, 13: 1 }, { 9: 3 }, { 9: 3 }, { 9: 3 }]);
  const a = AI.decide(s, () => 0.9);
  eq([a.v, a.n, a.j], [7, 2, 1]);
});

console.log(`${pass} 통과, ${fail} 실패`);
if (fail) process.exit(1);
