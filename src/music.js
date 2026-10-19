/* 달무티 배경 음악 — 르네상스 류트 풍. 음원 파일 없이 Web Audio로 직접 연주한다.
 * - 소리: 줄 튕김(카플러스-스트롱) 류트 + 낮은 베이스 류트 + 작은 북, 방 울림
 * - 곡: 16세기부터 쓰던 공용 반주 화음 진행(라 폴리아, 파사메초 안티코, 로마네스카) 위에
 *       선율을 정해진 규칙으로 지어 붙임. 한 곡 = 앞 가락 두 번 + 꾸민 가락 두 번, 곡마다 돌아가며.
 */
(function (root) {
  'use strict';
  // D 도리안 (화음이 A면 C#)
  var SCALE = [62, 64, 65, 67, 69, 71, 72]; // D E F G A B C
  var CH = { Dm: [62, 65, 69], C: [60, 64, 67], A: [57, 61, 64], F: [53, 57, 60], G: [55, 59, 62], Bb: [58, 62, 65] };
  var PIECES = [
    { name: '라 폴리아', meter: 3, bpm: 92, prog: ['Dm', 'A', 'Dm', 'C', 'F', 'C', 'Dm', 'A', 'Dm', 'A', 'Dm', 'C', 'F', 'C', 'Dm|A', 'Dm'] },
    { name: '파사메초 안티코', meter: 4, bpm: 76, prog: ['Dm', 'C', 'Dm', 'A', 'F', 'C', 'Dm|A', 'Dm'] },
    { name: '로마네스카', meter: 4, bpm: 80, prog: ['F', 'C', 'Dm', 'A', 'F', 'C', 'Dm|A', 'Dm'] },
    { name: '갈리아르드', meter: 3, bpm: 104, prog: ['Dm', 'Dm', 'C', 'C', 'F', 'C', 'Dm', 'A', 'F', 'C', 'Dm', 'A', 'Dm', 'C', 'Dm|A', 'Dm'] }
  ];
  // 한 마디의 리듬 (박 단위). 3박·4박
  var RHY = {
    3: [[1, 1, 1], [2, 1], [1.5, .5, 1], [1, .5, .5, 1], [.5, .5, 1, 1], [3]],
    4: [[1, 1, 1, 1], [2, 1, 1], [1.5, .5, 1, 1], [1, .5, .5, 2], [.5, .5, .5, .5, 1, 1], [1, 1, 2], [2, 2]]
  };
  var RHY_FANCY = {
    3: [[.5, .5, .5, .5, 1], [1, .5, .5, .5, .5], [.5, .5, .5, .5, .5, .5], [1.5, .5, .5, .5]],
    4: [[.5, .5, .5, .5, .5, .5, 1], [1, .5, .5, .5, .5, 1], [.5, .5, .5, .5, .5, .5, .5, .5], [1.5, .5, .5, .5, 1]]
  };

  function rng(seed) { return function () { seed = (seed + 0x6D2B79F5) | 0; var t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function pc(m) { return ((m % 12) + 12) % 12; }
  function scaleFor(chord) {
    return SCALE.map(function (m) { return chord === 'A' && pc(m) === 0 ? m + 1 : m; }); // C → C#
  }
  // 범위 안에서 음계 음 전체
  function ladder(chord, lo, hi) {
    var s = scaleFor(chord).map(pc), out = [];
    for (var m = lo; m <= hi; m++) if (s.indexOf(pc(m)) >= 0) out.push(m);
    return out;
  }
  function chordTones(chord, lo, hi) {
    var c = CH[chord].map(pc), out = [];
    for (var m = lo; m <= hi; m++) if (c.indexOf(pc(m)) >= 0) out.push(m);
    return out;
  }
  function nearest(list, x) { var b = list[0]; list.forEach(function (m) { if (Math.abs(m - x) < Math.abs(b - x)) b = m; }); return b; }

  /* 한 가락(마디들) 짓기 → 음표 목록 [{t(박), d(박), m, v, voice}] */
  function compose(piece, seed, fancy) {
    var R = rng(seed), notes = [], meter = piece.meter, prev = 69, t = 0;
    var bars = piece.prog.length;
    piece.prog.forEach(function (spec, bi) {
      var halves = spec.split('|'), last = bi === bars - 1, penult = bi === bars - 2;
      var chordAt = function (beat) { return halves.length > 1 && beat >= meter / 2 ? halves[1] : halves[0]; };
      // 베이스: 첫 박 근음(낮게), 3박자면 2박째 5도, 4박자면 3박째 5도
      halves.forEach(function (c, hi) {
        var root = CH[c][0], bass = root - 12; while (bass > 52) bass -= 12; while (bass < 38) bass += 12;
        var start = hi * meter / halves.length, len = meter / halves.length;
        notes.push({ t: t + start, d: len, m: bass, v: .9, voice: 'bass' });
        if (len >= 2 && !last) notes.push({ t: t + start + (meter === 3 ? 2 : 2), d: 1, m: bass + 7 > 55 ? bass - 5 : bass + 7, v: .55, voice: 'bass' });
      });
      // 안쪽 아르페지오(가볍게 뜯는 화음)
      for (var b = 0; b < meter; b++) {
        if (last && b > 0) break;
        var tones = chordTones(chordAt(b), 57, 69);
        var pick = tones[(b * 2 + (fancy ? 1 : 0)) % tones.length];
        notes.push({ t: t + b + .5, d: .5, m: pick, v: .32, voice: 'inner' });
        if (fancy && b % 2 === 0) notes.push({ t: t + b, d: .5, m: tones[(b + 1) % tones.length] + (tones[(b + 1) % tones.length] < 60 ? 12 : 0), v: .25, voice: 'inner' });
      }
      // 선율
      if (last) {
        notes.push({ t: t, d: meter, m: nearest(chordTones(halves[0], 62, 74), prev), v: .85, voice: 'mel' });
        prev = notes[notes.length - 1].m;
      } else {
        var pool = penult ? RHY[meter].slice(0, 3) : (fancy ? RHY_FANCY[meter].concat(RHY[meter].slice(0, 2)) : RHY[meter]);
        var rhythm = pool[Math.floor(R() * pool.length)], beat = 0;
        rhythm.forEach(function (d, k) {
          var ch = chordAt(beat), strong = beat === Math.floor(beat) && (beat === 0 || (meter === 4 && beat === 2));
          var m;
          if (strong || d >= 1) m = nearest(chordTones(ch, 62, 76), prev + (R() < .5 ? -2 : 2) * (R() < .4 ? 2 : 1));
          else {
            var lad = ladder(ch, 60, 77), i = lad.indexOf(nearest(lad, prev));
            var dir = prev > 72 ? -1 : prev < 64 ? 1 : (R() < .5 ? -1 : 1);
            m = lad[Math.max(0, Math.min(lad.length - 1, i + dir))];
          }
          // 마지막 앞 마디 끝은 이끎음(C#)으로
          if (penult && k === rhythm.length - 1) m = nearest([61, 73], prev);
          notes.push({ t: t + beat, d: d, m: m, v: (strong ? .8 : .62) + R() * .1, voice: 'mel' });
          prev = m; beat += d;
        });
      }
      // 작은 북: 첫 박 쿵, 나머지 톡
      for (var k2 = 0; k2 < meter; k2++) notes.push({ t: t + k2, d: .1, m: 0, v: k2 === 0 ? .7 : .28, voice: k2 === 0 ? 'drum' : 'tap' });
      t += meter;
    });
    return { notes: notes, beats: t };
  }

  /* ───── 소리 ───── */
  var Music = { on: false, volume: .5, pieceName: '' };
  var ctx = null, out = null, master = null, cache = {}, timer = null, queue = [], qStart = 0, pieceIdx = 0, section = 0, cur = null, secStart = 0, spb = .7;

  function pluckBuffer(m, voice) {
    var key = m + voice;
    if (cache[key]) return cache[key];
    var sr = ctx.sampleRate, f = 440 * Math.pow(2, (m - 69) / 12);
    var decay = voice === 'bass' ? .9965 : .9952, bright = voice === 'mel' ? .5 : .44;
    // 줄 길이: 평균 필터가 늦추는 만큼 빼고, 소수점 길이는 보간해서 음높이를 정확히
    var D = sr / f - (1 - bright), N = Math.max(2, Math.floor(D)), fr = D - N;
    var dur = voice === 'bass' ? 2.6 : 1.7, n = Math.floor(sr * dur);
    var buf = ctx.createBuffer(1, n, sr), y = buf.getChannelData(0);
    // 튕긴 자리 흉내: 잡음을 한 번 부드럽게 (류트는 거트 줄이라 둥근 소리)
    var seed = rng(m * 31 + voice.length), prev = 0;
    for (var i = 0; i <= N; i++) { var x = seed() * 2 - 1; prev = prev * .55 + x * .45; y[i] = prev; }
    var at = function (k) { return k < 0 ? 0 : y[k]; };
    for (var j = N + 1; j < n; j++) {
      var d0 = (1 - fr) * at(j - N) + fr * at(j - N - 1), d1 = (1 - fr) * at(j - N - 1) + fr * at(j - N - 2);
      y[j] = decay * (bright * d0 + (1 - bright) * d1);
    }
    // 앞부분 날카로운 소리 줄이고 끝을 부드럽게
    var fade = Math.floor(sr * .04);
    for (var k = 0; k < fade; k++) y[n - 1 - k] *= k / fade;
    var peak = 0; for (var p = 0; p < Math.min(n, N * 4); p++) peak = Math.max(peak, Math.abs(y[p]));
    if (peak > 0) for (var q = 0; q < n; q++) y[q] /= peak;
    cache[key] = buf;
    return buf;
  }
  function impulse() {
    var sr = ctx.sampleRate, len = Math.floor(sr * 2.2), buf = ctx.createBuffer(2, len, sr);
    for (var c = 0; c < 2; c++) { var d = buf.getChannelData(c), r = rng(7 + c); for (var i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    return buf;
  }
  function setup(audioCtx) {
    if (ctx === audioCtx && master) return;
    ctx = audioCtx;
    master = ctx.createGain(); master.gain.value = 0;
    var body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 220; body.Q.value = .9; body.gain.value = 4;
    var air = ctx.createBiquadFilter(); air.type = 'lowpass'; air.frequency.value = 3800;
    var dry = ctx.createGain(); dry.gain.value = .8;
    var wet = ctx.createGain(); wet.gain.value = .32;
    var rev = ctx.createConvolver(); rev.buffer = impulse();
    out = ctx.createGain(); out.gain.value = 1;
    out.connect(body); body.connect(air); air.connect(dry); air.connect(rev); rev.connect(wet);
    dry.connect(master); wet.connect(master); master.connect(ctx.destination);
  }
  function play(n, when) {
    if (n.voice === 'drum' || n.voice === 'tap') {
      var g = ctx.createGain(), o = ctx.createOscillator();
      if (n.voice === 'drum') {
        o.type = 'sine'; o.frequency.setValueAtTime(110, when); o.frequency.exponentialRampToValueAtTime(58, when + .18);
        g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(.22 * n.v, when + .006); g.gain.exponentialRampToValueAtTime(.0005, when + .35);
        o.connect(g); g.connect(master); o.start(when); o.stop(when + .4);
      } else {
        var len = Math.floor(ctx.sampleRate * .06), b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0), r = rng(len);
        for (var i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, 4);
        var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 1.2;
        s.buffer = b; g.gain.value = .12 * n.v; s.connect(f); f.connect(g); g.connect(master); s.start(when);
      }
      return;
    }
    var src = ctx.createBufferSource(), gain = ctx.createGain(), pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    src.buffer = pluckBuffer(n.m, n.voice);
    var vol = (n.voice === 'bass' ? .5 : n.voice === 'inner' ? .3 : .42) * n.v;
    gain.gain.setValueAtTime(vol, when);
    // 다음 음이 오면 줄을 살짝 막음
    var hold = Math.min(src.buffer.duration, n.d * spb + (n.voice === 'bass' ? .9 : .35));
    gain.gain.setTargetAtTime(0, when + hold, .08);
    src.connect(gain);
    if (pan) { pan.pan.value = n.voice === 'bass' ? -.25 : n.voice === 'inner' ? .3 : .05; gain.connect(pan); pan.connect(out); } else gain.connect(out);
    src.start(when + (n.voice === 'inner' ? .012 : 0)); src.stop(when + hold + .6);
  }
  function nextSection() {
    var piece = PIECES[pieceIdx % PIECES.length];
    if (section === 0) { Music.pieceName = piece.name; spb = 60 / piece.bpm; }
    // A A B B (B는 꾸민 가락), 그다음 곡
    var fancy = section >= 2, seed = pieceIdx * 101 + (fancy ? 17 : 3);
    cur = compose(piece, seed, fancy);
    queue = cur.notes.slice().sort(function (a, b) { return a.t - b.t; });
    section++;
    if (section >= 4) { section = 0; pieceIdx++; }
  }
  function pump() {
    if (!ctx || !Music.on) return;
    var ahead = ctx.currentTime + .35;
    while (true) {
      if (!queue.length) {
        var gap = cur ? cur.beats * spb : 0;
        var endPause = section === 0 && cur ? spb * 1.5 : 0; // 곡이 바뀔 때 숨 한 번
        secStart += gap + endPause;
        nextSection();
        if (secStart < ctx.currentTime) secStart = ctx.currentTime + .05;
      }
      var n = queue[0], when = secStart + n.t * spb;
      if (when > ahead) break;
      queue.shift();
      // 사람이 치는 것처럼 조금씩 어긋나게
      if (when >= ctx.currentTime - .02) play(n, Math.max(ctx.currentTime, when + (n.voice === 'mel' ? (Math.random() - .5) * .012 : 0)));
    }
  }
  Music.start = function (audioCtx) {
    if (!audioCtx) return;
    setup(audioCtx);
    if (Music.on) return;
    Music.on = true;
    cur = null; queue = []; secStart = ctx.currentTime + .15;
    pieceIdx = Math.floor(Math.random() * PIECES.length); section = 0;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(Music.volume, ctx.currentTime + 1.5);
    timer = setInterval(pump, 90);
    pump();
  };
  Music.stop = function () {
    if (!Music.on) return;
    Music.on = false;
    clearInterval(timer); timer = null;
    if (ctx && master) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + .6);
    }
  };
  Music.setVolume = function (v) {
    Music.volume = v;
    if (ctx && master && Music.on) master.gain.setTargetAtTime(v, ctx.currentTime, .1);
  };
  Music.compose = compose; Music.PIECES = PIECES; // 시험용
  // 시험용: 오프라인으로 seconds초 미리 렌더링
  Music._render = function (offCtx, seconds, startPiece) {
    ctx = null; master = null; cache = {}; setup(offCtx); master.gain.value = Music.volume;
    Music.on = true; cur = null; queue = []; secStart = .05; pieceIdx = startPiece || 0; section = 0;
    var now = { t: 0 };
    while (true) {
      if (!queue.length) { var gap = cur ? cur.beats * spb : 0, endPause = section === 0 && cur ? spb * 1.5 : 0; secStart += gap + endPause; nextSection(); }
      var n = queue[0], when = secStart + n.t * spb;
      if (when > seconds) break;
      queue.shift(); play(n, when);
    }
    Music.on = false; ctx = null; master = null; cache = {};
  };

  root.DMMusic = Music;
  if (typeof module !== 'undefined' && module.exports) module.exports = Music;
})(typeof window !== 'undefined' ? window : globalThis);
