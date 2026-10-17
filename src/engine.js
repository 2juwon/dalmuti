/* 달무티 규칙 엔진 — JSON 상태 + apply(state, action) → 새 상태 */
(function (root) {
  'use strict';
  var DM = {};
  DM.VERSION = 1;
  DM.JOKER = 13;
  DM.CARD_NAMES = ['', '달무티', '대주교', '시종장', '남작부인', '수녀원장', '기사', '재봉사', '석공', '요리사', '양치기', '광부', '농노', '어릿광대'];
  DM.MIN_PLAYERS = 4;
  DM.MAX_PLAYERS = 8;

  function zeros() { var a = []; for (var i = 0; i < 14; i++) a.push(0); return a; }
  DM.zeros = zeros;
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  DM.clone = clone;

  // 계급 이름 (0 = 가장 높음)
  DM.rankNames = function (n) {
    var a = [];
    for (var i = 0; i < n; i++) {
      if (i === 0) a.push('달무티');
      else if (i === n - 1) a.push('농노');
      else if (i === 1) a.push('총리대신');
      else if (i === n - 2) a.push('소작농');
      else a.push('상인');
    }
    return a;
  };

  function rnd(s) {
    var t = (s.seed = (s.seed + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function fullDeck() {
    var d = [];
    for (var v = 1; v <= 12; v++) for (var k = 0; k < v; k++) d.push(v);
    d.push(13, 13);
    return d;
  }
  function shuffle(a, s) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd(s) * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  DM.handSize = function (h) { var c = 0; for (var i = 1; i < 14; i++) c += h[i]; return c; };
  DM.deckCounts = function () { var a = zeros(); for (var v = 1; v <= 12; v++) a[v] = v; a[13] = 2; return a; };

  function log(s, e) { e.seq = s.seq; s.log.push(e); if (s.log.length > 60) s.log.shift(); }

  /* cfg: { players:[{name, ai, level}], games: 3|5|10|0(끝없이), firstTax: bool, seed } */
  DM.newMatch = function (cfg) {
    var n = cfg.players.length;
    if (n < DM.MIN_PLAYERS || n > DM.MAX_PLAYERS) throw new Error('인원은 4~8명');
    return {
      v: DM.VERSION, n: n, seed: (cfg.seed >>> 0) || 1,
      games: cfg.games == null ? 5 : cfg.games,
      opts: { firstTax: cfg.firstTax !== false },
      players: cfg.players.map(function (p, i) {
        return { id: i, name: p.name, ai: !!p.ai, level: p.level || 'normal', hand: zeros(), score: 0, hist: [] };
      }),
      gameNo: 0, phase: 'draw', ranks: null, draws: null, finished: [], trick: null, trickPlays: [],
      prevTrick: null, turn: -1, passes: 0, lastPlayer: -1, played: zeros(), status: {},
      revolution: null, tax: null, lastResult: null, log: [], seq: 0
    };
  };

  /* ───── 계급 뽑기 ───── */
  function drawRanks(s) {
    var draws = {};
    function resolve(ids) {
      if (ids.length === 1) return ids;
      var d = shuffle(fullDeck(), s), vals = {};
      ids.forEach(function (id, k) { vals[id] = d[k]; (draws[id] = draws[id] || []).push(d[k]); });
      var byV = {};
      ids.forEach(function (id) { (byV[vals[id]] = byV[vals[id]] || []).push(id); });
      var out = [];
      Object.keys(byV).map(Number).sort(function (a, b) { return a - b; }).forEach(function (k) {
        out = out.concat(byV[k].length > 1 ? resolve(byV[k]) : byV[k]);
      });
      return out;
    }
    s.ranks = resolve(s.players.map(function (p) { return p.id; }));
    s.draws = draws;
    s.phase = 'drawn';
    log(s, { t: 'draw' });
  }

  /* ───── 나누기 ───── */
  function deal(s) {
    var deck = shuffle(fullDeck(), s);
    s.players.forEach(function (p) { p.hand = zeros(); });
    var n = s.n, base = Math.floor(80 / n), r = 80 - base * n, k = 0;
    for (var ri = 0; ri < n; ri++) {
      var pid = s.ranks[ri], cnt = base + (ri >= n - r ? 1 : 0);
      for (var c = 0; c < cnt; c++) s.players[pid].hand[deck[k++]]++;
    }
    s.played = zeros(); s.finished = []; s.trick = null; s.trickPlays = []; s.prevTrick = null;
    s.status = {}; s.revolution = null; s.tax = null; s.lastResult = null;
    s.gameNo++;
    log(s, { t: 'deal', game: s.gameNo });
    var noTax = s.gameNo === 1 && !s.opts.firstTax;
    var holder = -1;
    s.players.forEach(function (p) { if (p.hand[13] === 2) holder = p.id; });
    if (holder >= 0 && !noTax) { s.phase = 'revolution'; s.revolution = { pid: holder, reveal: null, kind: null }; }
    else startTax(s, noTax);
  }

  function lowestCards(h, k) {
    var out = [];
    for (var v = 1; v <= 13 && out.length < k; v++) for (var c = 0; c < h[v] && out.length < k; c++) out.push(v);
    return out;
  }
  // 조공: 숫자 카드 중 가장 작은 것 (어릿광대는 바치지 않음, 숫자 카드가 모자랄 때만)
  function tribute(h, k) {
    var out = [];
    for (var v = 1; v <= 12 && out.length < k; v++) for (var c = 0; c < h[v] && out.length < k; c++) out.push(v);
    if (out.length < k) out = lowestCards(h, k);
    return out;
  }

  function startTax(s, skip) {
    if (skip) { s.tax = null; startPlay(s); return; }
    var n = s.n, R = s.ranks;
    var pairs = [{ from: R[n - 1], to: R[0], k: 2 }, { from: R[n - 2], to: R[1], k: 1 }];
    pairs.forEach(function (p) {
      var fh = s.players[p.from].hand, th = s.players[p.to].hand;
      p.taken = tribute(fh, p.k);
      p.taken.forEach(function (v) { fh[v]--; th[v]++; });
      p.given = null;
    });
    s.tax = { pairs: pairs };
    s.phase = 'taxReturn';
    log(s, { t: 'tribute' });
  }

  function startPlay(s) {
    s.phase = 'play';
    s.turn = s.ranks[0];
    s.trick = null; s.trickPlays = []; s.passes = 0; s.lastPlayer = -1; s.status = {};
    log(s, { t: 'start', pid: s.turn });
  }

  /* ───── 차례 ───── */
  function isOut(s, pid) { return s.finished.indexOf(pid) >= 0; }
  function nextActive(s, pid) {
    var seat = s.ranks, i = seat.indexOf(pid), n = seat.length;
    for (var k = 1; k <= n; k++) { var q = seat[(i + k) % n]; if (!isOut(s, q)) return q; }
    return -1;
  }
  DM.nextActive = nextActive;
  function activeCount(s) { return s.n - s.finished.length; }

  DM.check = function (s, pid, m) {
    if (s.phase !== 'play') return '지금은 낼 수 없어요';
    if (s.turn !== pid) return '차례가 아니에요';
    if (!m) return '카드를 고르세요';
    var h = s.players[pid].hand, v = m.v | 0, n = m.n | 0, j = m.j | 0, t = n + j;
    if (t < 1) return '카드를 고르세요';
    if (n < 0 || j < 0) return '잘못된 선택이에요';
    if (v === 13) {
      if (n !== 0) return '잘못된 선택이에요';
      if (h[13] < j) return '어릿광대가 모자라요';
    } else {
      if (v < 1 || v > 12) return '잘못된 선택이에요';
      if (n < 1) return '어릿광대는 숫자 카드와 함께 내야 그 수가 돼요';
      if (h[v] < n) return '카드가 모자라요';
      if (h[13] < j) return '어릿광대가 모자라요';
    }
    if (s.trick) {
      if (t !== s.trick.count) return s.trick.count + '장을 내야 해요';
      if (v >= s.trick.v) return (s.trick.v === 13 ? '어릿광대(13)' : s.trick.v) + '보다 작은 수만 낼 수 있어요';
    }
    return null;
  };

  DM.moves = function (s, pid) {
    if (s.phase !== 'play' || s.turn !== pid) return [];
    var h = s.players[pid].hand, tr = s.trick, out = [];
    for (var v = 1; v <= 12; v++) {
      if (h[v] < 1) continue;
      if (tr && v >= tr.v) continue;
      for (var n = 1; n <= h[v]; n++) for (var j = 0; j <= h[13]; j++) {
        if (tr && n + j !== tr.count) continue;
        out.push({ v: v, n: n, j: j });
      }
    }
    if (!tr) for (var jj = 1; jj <= h[13]; jj++) out.push({ v: 13, n: 0, j: jj });
    return out;
  };

  function play(s, pid, m) {
    var err = DM.check(s, pid, m);
    if (err) throw new Error(err);
    var h = s.players[pid].hand, v = m.v, n = m.n | 0, j = m.j | 0;
    if (v === 13) { h[13] -= j; s.played[13] += j; }
    else { h[v] -= n; h[13] -= j; s.played[v] += n; s.played[13] += j; }
    var pl = { pid: pid, v: v, n: n, j: j, count: n + j };
    s.trick = { v: v, count: n + j, by: pid };
    s.trickPlays.push(pl);
    s.status[pid] = { t: 'play', v: v, n: n, j: j };
    s.lastPlayer = pid; s.passes = 0;
    log(s, { t: 'play', pid: pid, v: v, n: n, j: j });
    if (DM.handSize(h) === 0) {
      s.finished.push(pid);
      log(s, { t: 'out', pid: pid, place: s.finished.length });
      if (activeCount(s) === 1) {
        var last = nextActive(s, pid);
        s.finished.push(last);
        endGame(s);
        return;
      }
    }
    s.turn = nextActive(s, pid);
    maybeClear(s);
  }

  function pass(s, pid) {
    if (s.phase !== 'play') throw new Error('지금은 패스할 수 없어요');
    if (s.turn !== pid) throw new Error('차례가 아니에요');
    if (!s.trick) throw new Error('선은 패스할 수 없어요');
    s.status[pid] = { t: 'pass' };
    s.passes++;
    log(s, { t: 'pass', pid: pid });
    s.turn = nextActive(s, pid);
    maybeClear(s);
  }

  // 마지막으로 낸 사람을 뺀 남은 사람이 모두 이어서 패스하면 판을 치움
  function maybeClear(s) {
    if (!s.trick) return;
    var lp = s.lastPlayer;
    var need = activeCount(s) - (isOut(s, lp) ? 0 : 1);
    if (s.passes >= need) {
      var leader = isOut(s, lp) ? nextActive(s, lp) : lp;
      s.prevTrick = { plays: s.trickPlays, by: lp, leader: leader };
      s.trick = null; s.trickPlays = []; s.passes = 0; s.status = {};
      s.turn = leader;
      log(s, { t: 'clear', pid: leader, by: lp });
    }
  }

  function endGame(s) {
    var n = s.n;
    s.finished.forEach(function (pid, i) {
      var p = s.players[pid];
      p.score += n - 1 - i;
      p.hist.push(i);
    });
    s.lastResult = { order: s.finished.slice(), prevRanks: s.ranks.slice(), revolution: s.revolution && s.revolution.reveal ? s.revolution.kind : null };
    s.trick = null; s.turn = -1;
    s.phase = (s.games > 0 && s.gameNo >= s.games) ? 'matchEnd' : 'gameEnd';
    log(s, { t: 'end', order: s.finished.slice() });
  }

  DM.standings = function (s) {
    // 총점 높은 순, 같으면 최근 판 순위가 높은 사람
    return s.players.slice().sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var la = a.hist.length ? a.hist[a.hist.length - 1] : 99, lb = b.hist.length ? b.hist[b.hist.length - 1] : 99;
      return la - lb;
    }).map(function (p) { return p.id; });
  };

  /* 지금 누가 무엇을 해야 하는지 */
  DM.pending = function (s) {
    if (s.phase === 'revolution') return { pid: s.revolution.pid, kind: 'revolution' };
    if (s.phase === 'taxReturn') {
      for (var i = 0; i < s.tax.pairs.length; i++) if (!s.tax.pairs[i].given) return { pid: s.tax.pairs[i].to, kind: 'giveBack', k: s.tax.pairs[i].k, to: s.tax.pairs[i].from };
      return null;
    }
    if (s.phase === 'play') return { pid: s.turn, kind: 'play' };
    return null;
  };

  DM.apply = function (state, a) { return DM.step(clone(state), a); };
  // 상태를 그대로 바꾸는 버전 (컴퓨터의 앞날 내다보기용)
  DM.step = function (s, a) {
    s.seq++;
    switch (a.type) {
      case 'drawRanks':
        if (s.phase !== 'draw') throw new Error('bad phase');
        drawRanks(s); break;
      case 'skipDraw': // 첫 판을 앉은 순서대로 (선만 무작위)
        if (s.phase !== 'draw') throw new Error('bad phase');
        var ids = s.players.map(function (p) { return p.id; }), st = Math.floor(rnd(s) * s.n);
        s.ranks = ids.slice(st).concat(ids.slice(0, st)); s.draws = null; s.phase = 'drawn'; break;
      case 'deal':
        if (s.phase !== 'drawn') throw new Error('bad phase');
        deal(s); break;
      case 'revolution':
        if (s.phase !== 'revolution' || a.pid !== s.revolution.pid) throw new Error('bad revolution');
        if (a.reveal) {
          s.revolution.reveal = true;
          if (a.pid === s.ranks[s.n - 1]) { s.revolution.kind = 'great'; s.ranks.reverse(); }
          else s.revolution.kind = 'normal';
          log(s, { t: 'revolution', pid: a.pid, kind: s.revolution.kind });
          startPlay(s);
        } else {
          s.revolution.reveal = false;
          startTax(s, false);
        }
        break;
      case 'giveBack':
        if (s.phase !== 'taxReturn') throw new Error('bad phase');
        var pair = null;
        s.tax.pairs.forEach(function (p) { if (!pair && p.to === a.pid && !p.given) pair = p; });
        if (!pair) throw new Error('돌려줄 차례가 아니에요');
        var cards = (a.cards || []).slice();
        if (cards.length !== pair.k) throw new Error(pair.k + '장을 골라야 해요');
        var th = s.players[pair.to].hand, need = zeros();
        cards.forEach(function (v) { need[v]++; });
        for (var v = 1; v < 14; v++) if (need[v] > th[v]) throw new Error('없는 카드예요');
        var fh = s.players[pair.from].hand;
        cards.forEach(function (v) { th[v]--; fh[v]++; });
        pair.given = cards.sort(function (x, y) { return x - y; });
        log(s, { t: 'giveBack', pid: a.pid });
        if (s.tax.pairs.every(function (p) { return p.given; })) startPlay(s);
        break;
      case 'play': play(s, a.pid, a); break;
      case 'pass': pass(s, a.pid); break;
      case 'nextGame':
        if (s.phase !== 'gameEnd') throw new Error('bad phase');
        s.ranks = s.finished.slice();
        s.phase = 'drawn';
        deal(s); break;
      default: throw new Error('unknown action ' + a.type);
    }
    return s;
  };

  root.DM = DM;
  if (typeof module !== 'undefined' && module.exports) module.exports = DM;
})(typeof window !== 'undefined' ? window : globalThis);
