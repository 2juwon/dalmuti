/* 달무티 컴퓨터 — 자기 손패와 공개된 정보(낸 카드, 남은 장수)만 사용 */
(function (root) {
  'use strict';
  var DM = root.DM || (typeof require !== 'undefined' ? require('./engine.js') : null);
  var AI = {};
  AI.LEVELS = { easy: '느긋한', normal: '보통', hard: '고수' };
  AI.budget = 800; // 고수가 한 수에 상상해 볼 판 수

  function groups(h) { var g = 0; for (var v = 1; v <= 12; v++) if (h[v] > 0) g++; return g; }

  // 아직 못 본 카드 (내 손패·이미 낸 카드 제외)
  AI.unseen = function (s, pid) {
    var d = DM.deckCounts(), h = s.players[pid].hand, u = DM.zeros();
    for (var v = 1; v < 14; v++) u[v] = d[v] - h[v] - s.played[v];
    return u;
  };
  function maxOppCards(s, pid) {
    var m = 0;
    s.players.forEach(function (p) { if (p.id !== pid && s.finished.indexOf(p.id) < 0) m = Math.max(m, DM.count(p)); });
    return m;
  }
  // (v, t)를 내면 아무도 못 받는가?
  AI.sureWin = function (s, pid, v, t) {
    if (maxOppCards(s, pid) < t) return true;
    var u = AI.unseen(s, pid);
    for (var w = 1; w < Math.min(v, 13); w++) if (u[w] >= 1 && u[w] + u[13] >= t) return false;
    return true;
  };

  // 손패 부담: 묶음마다 1 + 약할수록 무겁고, 장수가 많으면 가벼움. 어릿광대·1은 힘
  function handCost(h) {
    var c = 0;
    for (var v = 1; v <= 12; v++) if (h[v] > 0) c += 1 + v / 12 - 0.06 * Math.min(h[v], 8);
    c -= h[13] * 0.6;
    if (h[1] > 0) c -= 0.4;
    return c;
  }
  AI.handCost = handCost;

  // 세금으로 돌려줄 카드 고르기
  AI.chooseGiveBack = function (s, pid, k, level, rand) {
    var h = s.players[pid].hand.slice();
    var best = null, bestC = Infinity;
    function rec(start, left, picked) {
      if (left === 0) {
        var c = handCost(h);
        if (level === 'easy') c += rand() * 0.8;
        if (c < bestC - 1e-9) { bestC = c; best = picked.slice(); }
        return;
      }
      for (var v = start; v < 14; v++) {
        if (h[v] < 1) continue;
        h[v]--; picked.push(v);
        rec(v, left - 1, picked);
        picked.pop(); h[v]++;
      }
    }
    rec(1, k, []);
    return best;
  };

  AI.chooseRevolution = function (s, pid) {
    var r = s.ranks.indexOf(pid);
    return r >= s.n - 2; // 소작농·농노만 공개 (세금을 피하거나 대혁명)
  };

  function strengthSpent(m) {
    var w = function (v) { return Math.max(0, 6 - v) / 5; };
    return (m.v === 13 ? 0 : m.n * w(m.v)) + m.j * 1.3;
  }

  function leadMove(s, pid, level) {
    var h = s.players[pid].hand, g = groups(h);
    // 묶음 하나만 남았으면 어릿광대까지 모두
    if (g <= 1) {
      for (var v = 1; v <= 12; v++) if (h[v] > 0) return { v: v, n: h[v], j: h[13] };
      return { v: 13, n: 0, j: h[13] };
    }
    var opts = [];
    for (var x = 1; x <= 12; x++) if (h[x] > 0) opts.push({ v: x, n: h[x], j: 0 });
    if (level === 'hard') {
      // 확실히 이기는 묶음을 내고 남은 게 한 묶음이면 그걸로 끝낼 수 있음
      var sure = opts.filter(function (m) { return AI.sureWin(s, pid, m.v, m.n); });
      if (sure.length && g - 1 <= 1) return sure[0];
      if (h[13] && g === 2) {
        // 어릿광대를 붙여 못 받게 만들 수 있는 묶음
        for (var i = 0; i < opts.length; i++) {
          var m = opts[i];
          for (var j = 1; j <= h[13]; j++) if (AI.sureWin(s, pid, m.v, m.n + j)) return { v: m.v, n: m.n, j: j };
        }
      }
      var weak = opts.filter(function (m) { return !AI.sureWin(s, pid, m.v, m.n); });
      if (weak.length) opts = weak;
    }
    // 가장 약한 묶음(큰 수)부터, 같으면 많은 쪽
    opts.sort(function (a, b) { return b.v - a.v || b.n - a.n; });
    return opts[0];
  }

  function followMove(s, pid, level) {
    var h = s.players[pid].hand, moves = DM.moves(s, pid);
    if (!moves.length) return null;
    var size = DM.handSize(h), g = groups(h);
    var spendW = size <= 5 ? 0.5 : size <= 9 ? 0.9 : 1.3;
    var best = null, bestSc = level === 'hard' ? 0.2 : 0;
    moves.forEach(function (m) {
      var after = h.slice(); if (m.v === 13) after[13] -= m.j; else { after[m.v] -= m.n; after[13] -= m.j; }
      var left = DM.handSize(after);
      var sc;
      if (left === 0) sc = 100;
      else {
        var removed = g - groups(after);
        sc = removed * 3 + m.n * 0.25 - strengthSpent(m) * spendW * 2;
        if (m.v !== 13 && m.n < h[m.v]) sc -= 1.6;   // 묶음 쪼개기
        sc += (m.v - 6) * 0.08;                       // 약한 카드로 받을수록 좋음
        if (level === 'hard') {
          var sure = AI.sureWin(s, pid, m.v, m.n + m.j);
          if (sure) { sc += 1.5; if (groups(after) <= 1 && after[13] === 0) sc += 50; if (groups(after) === 0) sc += 50; }
          // 거의 끝난 사람이 이 판을 가져가려 하면 막기
          var lp = s.trick.by, lpLeft = DM.count(s.players[lp]);
          if (lpLeft > 0 && lpLeft <= 2) sc += 2.5;
        }
      }
      if (sc > bestSc) { bestSc = sc; best = m; }
    });
    return best;
  }

  /* ───── 고수: 남의 패를 여러 번 상상해서 끝까지 두어 보고 고르기 ───── */
  function candidates(s, pid) {
    var h = s.players[pid].hand, out = [], seen = {};
    function add(m) { var k = m.v + ':' + m.n + ':' + m.j; if (!seen[k]) { seen[k] = 1; out.push(m); } }
    if (s.trick) {
      out.push(null); // 패스
      DM.moves(s, pid).forEach(add);
    } else {
      for (var v = 1; v <= 12; v++) if (h[v] > 0) {
        add({ v: v, n: h[v], j: 0 });
        for (var j = 1; j <= h[13]; j++) add({ v: v, n: h[v], j: j });
        if (h[v] > 1) add({ v: v, n: 1, j: 0 });
      }
      for (var jj = 1; jj <= h[13]; jj++) add({ v: 13, n: 0, j: jj });
    }
    return out;
  }
  function imagine(s, pid, rand) {
    var t = DM.clone(s);
    t.log = []; t.games = 0;
    var pool = [], u = AI.unseen(s, pid);
    for (var v = 1; v < 14; v++) for (var k = 0; k < u[v]; k++) pool.push(v);
    for (var i = pool.length - 1; i > 0; i--) { var r = Math.floor(rand() * (i + 1)); var x = pool[i]; pool[i] = pool[r]; pool[r] = x; }
    var at = 0;
    t.players.forEach(function (p) {
      p.level = 'normal';
      if (p.id === pid) return;
      var c = DM.count(p); p.hand = DM.zeros();
      for (var q = 0; q < c; q++) p.hand[pool[at++]]++;
    });
    return t;
  }
  function playout(t, pid) {
    var steps = 0;
    while (t.phase === 'play' && steps++ < 600) {
      var p = t.turn, m = t.trick ? followMove(t, p, 'normal') : leadMove(t, p, 'normal');
      if (m) DM.step(t, { type: 'play', pid: p, v: m.v, n: m.n, j: m.j });
      else DM.step(t, { type: 'pass', pid: p });
    }
    var place = t.finished.indexOf(pid);
    return place < 0 ? t.n : place;
  }
  AI.lookahead = function (s, pid, rand, budget) {
    var cands = candidates(s, pid);
    if (cands.length === 1) return cands[0];
    var K = Math.max(6, Math.floor((budget || 160) / cands.length));
    var sum = cands.map(function () { return 0; });
    for (var k = 0; k < K; k++) {
      var base = imagine(s, pid, rand);
      cands.forEach(function (m, i) {
        var t = DM.clone(base);
        if (m) DM.step(t, { type: 'play', pid: pid, v: m.v, n: m.n, j: m.j });
        else DM.step(t, { type: 'pass', pid: pid });
        sum[i] += playout(t, pid);
      });
    }
    // 같은 점수면 휴리스틱이 고른 수
    var pref = s.trick ? followMove(s, pid, 'hard') : leadMove(s, pid, 'hard');
    var best = -1, bestV = Infinity;
    cands.forEach(function (m, i) {
      var val = sum[i] / K;
      var same = (m === null && pref === null) || (m && pref && m.v === pref.v && m.n === pref.n && m.j === pref.j);
      if (same) val -= 0.05;
      if (val < bestV) { bestV = val; best = i; }
    });
    return cands[best];
  };

  /* 컴퓨터 행동 하나 고르기. rand: 0~1 난수 함수 */
  AI.decide = function (s, rand) {
    rand = rand || Math.random;
    var p = DM.pending(s);
    if (!p) return null;
    var me = s.players[p.pid], level = me.level || 'normal';
    if (p.kind === 'revolution') return { type: 'revolution', pid: p.pid, reveal: AI.chooseRevolution(s, p.pid) };
    if (p.kind === 'giveBack') return { type: 'giveBack', pid: p.pid, cards: AI.chooseGiveBack(s, p.pid, p.k, level, rand) };
    if (p.kind !== 'play') return null;
    var moves = DM.moves(s, p.pid);
    if (level === 'easy' && rand() < 0.45) {
      if (s.trick && (rand() < 0.35 || !moves.length)) return { type: 'pass', pid: p.pid };
      var mm = moves[Math.floor(rand() * moves.length)];
      if (mm) return { type: 'play', pid: p.pid, v: mm.v, n: mm.n, j: mm.j };
    }
    var m;
    if (level === 'hard' && moves.length) m = AI.lookahead(s, p.pid, rand, AI.budget);
    else m = s.trick ? followMove(s, p.pid, level) : leadMove(s, p.pid, level);
    if (!m) return { type: 'pass', pid: p.pid };
    return { type: 'play', pid: p.pid, v: m.v, n: m.n, j: m.j };
  };

  root.DMAI = AI;
  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
})(typeof window !== 'undefined' ? window : globalThis);
