// 컴퓨터끼리 많이 두어 보기: 멈춤·카드 수 불일치가 없는지, 실력 차이가 나는지
const DM = require('../src/engine.js');
const AI = require('../src/ai.js');
AI.budget = +(process.env.BUDGET || 160);
function rng(seed) { return function () { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function total(s) { let c = 0; s.players.forEach(p => c += DM.handSize(p.hand)); for (let v = 1; v < 14; v++) c += s.played[v]; return c; }

function runMatch(levels, seed, games, firstTax) {
  const r = rng(seed * 7919 + 1);
  let s = DM.newMatch({ players: levels.map((l, i) => ({ name: 'C' + i, ai: true, level: l })), games, seed, firstTax });
  s = DM.apply(s, { type: 'drawRanks' });
  s = DM.apply(s, { type: 'deal' });
  let steps = 0, revo = { great: 0, normal: 0 };
  while (s.phase !== 'matchEnd') {
    if (++steps > 20000) throw new Error('멈춤 seed=' + seed);
    if (s.phase === 'gameEnd') { s = DM.apply(s, { type: 'nextGame' }); continue; }
    const a = AI.decide(s, r);
    if (!a) throw new Error('행동 없음 ' + s.phase);
    if (a.type === 'play' && DM.check(s, a.pid, a)) throw new Error('잘못된 수 ' + DM.check(s, a.pid, a));
    s = DM.apply(s, a);
    if (a.type === 'revolution' && a.reveal) revo[s.revolution.kind]++;
    if (s.phase !== 'gameEnd' && s.phase !== 'matchEnd' && total(s) !== 80) throw new Error('카드 수 ' + total(s));
  }
  return { s, steps, revo };
}

const N = +(process.argv[2] || 600);
let gamesPlayed = 0, revo = { great: 0, normal: 0 };
// 1) 모든 인원으로 섞어 두기
for (let n = 4; n <= 8; n++) for (let i = 0; i < N / 5; i++) {
  const lv = []; for (let k = 0; k < n; k++) lv.push(['easy', 'normal', 'hard'][(i + k) % 3]);
  const r = runMatch(lv, n * 100000 + i, 5, i % 2 === 0);
  gamesPlayed += 5; revo.great += r.revo.great; revo.normal += r.revo.normal;
}
console.log(`섞어 두기: ${gamesPlayed}판 문제 없음, 대혁명 ${revo.great}번, 혁명 ${revo.normal}번`);

// 2) 실력 비교: 한 명만 다른 실력, 나머지 보통. 첫 판(세금 없이 동등 조건) 평균 등수
function compare(level, base) {
  let sum = 0, firsts = 0, cnt = 0;
  for (let i = 0; i < N; i++) {
    const n = 5, lv = Array(n).fill(base); const seat = i % n; lv[seat] = level;
    const r = runMatch(lv, 900000 + i, 1, false);
    const place = r.s.lastResult.order.indexOf(seat);
    sum += place; if (place === 0) firsts++; cnt++;
  }
  return { avg: (sum / cnt + 1).toFixed(2), first: (100 * firsts / cnt).toFixed(1) + '%' };
}
console.log('5명, 나머지 보통일 때 (무작위면 평균 3.00등, 1등 20%)');
for (const l of ['easy', 'normal', 'hard']) { const c = compare(l, 'normal'); console.log(`  ${l}: 평균 ${c.avg}등, 1등 ${c.first}`); }
const h = compare('hard', 'hard'); console.log(`  모두 고수(대조): 평균 ${h.avg}등`);

// 3) 계급의 힘: 세금이 있을 때 달무티가 다시 달무티가 되는 비율
let keep = 0, tries = 0;
for (let i = 0; i < N; i++) {
  const r = runMatch(Array(5).fill('normal'), 700000 + i, 2, true);
  const s = r.s; // 2판째의 시작 계급 = 1판째 결과
  if (s.lastResult.revolution) continue;
  tries++; if (s.lastResult.order[0] === s.lastResult.prevRanks[0]) keep++;
}
console.log(`세금 있는 판에서 달무티가 자리를 지킨 비율: ${(100 * keep / tries).toFixed(1)}%`);
