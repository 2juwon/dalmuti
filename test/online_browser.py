# 브라우저 3개로 온라인 한 경기: 방 만들기 → 초대 링크로 들어오기 → 시작 → 3판 → 한 번 더
# 한 사람(C)은 아무것도 안 해서 제한 시간이 지나면 자동 패스·자리 비움이 되는지 본다.
#   cd server && npx wrangler dev --var FAST_TEST:1   (다른 창, 시간이 10배 빠름)
#   node build.js --server=http://127.0.0.1:8787 --out=dist/local.html
#   python3 test/online_browser.py "$PWD/dist/local.html" /tmp/shots
import sys, json, time
from playwright.sync_api import sync_playwright
PAGE = 'file://' + sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else '.'
errors = []
STATE = '''() => { const D = window.__dalmuti, S = D.get(), N = D.net(), me = D.me();
  const vis = [...document.querySelectorAll('button[id]')].filter(b => b.offsetParent && !b.disabled).map(b => b.id);
  return { S: S ? { phase: S.phase, seq: S.seq, gameNo: S.gameNo, trick: S.trick, pend: DM.pending(S), hand: S.players[me] && S.players[me].hand } : null,
    me, room: N && N.room ? { status: N.room.status, code: N.room.code, host: N.room.host, deadline: N.room.deadline, seats: N.room.seats } : null,
    ids: vis, sent: D.ui().sentSeq, clock: !document.getElementById('clock').hidden ? document.getElementById('clock').textContent : '' } }'''
DECIDE = '''() => { const D = window.__dalmuti, S = D.get(), me = D.me(); const c = DM.clone(S); c.players[me].level = 'normal'; const a = DMAI.decide(c); return a && a.pid === me ? a : null; }'''

def mk(b, name, hash_=''):
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, color_scheme='dark')
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(name + ': ' + str(e) + ' @ ' + (e.stack or '')[:600]))
    pg.on('console', lambda m: m.type == 'error' and 'ERR_TUNNEL' not in m.text and 'fonts.g' not in m.text and errors.append(name + ' console: ' + m.text))
    pg.set_default_timeout(4000)
    pg.goto(PAGE + hash_); pg.wait_for_timeout(300)
    return pg

def act(pg, st):
    """내 차례면 화면 버튼으로 한 수 둔다. 둔 게 있으면 True"""
    S = st['S']
    if not S or st['sent'] == S['seq']: return False
    ids = st['ids']
    if 'autoGive' in ids:
        pg.click('#autoGive'); pg.wait_for_timeout(40); pg.click('#playBtn'); return True
    if 'revYes' in ids:
        pg.click('#revNo'); return True
    p = S['pend']
    if not p or p['pid'] != st['me'] or S['phase'] != 'play': return False
    m = pg.evaluate(DECIDE)
    if not m: return False
    if m['type'] == 'pass':
        if 'passBtn' in ids: pg.click('#passBtn'); return True
        return False  # 낼 게 없으면 서버가 자동 패스
    if m['v'] == 13:
        for _ in range(m['j']): pg.click('.stack[data-v="13"]')
    else:
        pg.click(f'.stack[data-v="{m["v"]}"]')
        if not S['trick']:
            for _ in range(S['hand'][m['v']] - m['n']): pg.click(f'.stack[data-v="{m["v"]}"]')
            for _ in range(m['j']): pg.click('.stack[data-v="13"]')
    pg.wait_for_timeout(30)
    if pg.is_disabled('#playBtn'):
        errors.append('내기 버튼 꺼짐 ' + json.dumps(m) + ' ' + pg.inner_text('#hint')); return False
    pg.click('#playBtn'); return True

with sync_playwright() as p:
    b = p.chromium.launch()
    A = mk(b, 'A')
    A.click('[data-mode] [data-val="online"]'); A.fill('#nameIn', '주원'); A.click('#makeBtn')
    A.wait_for_selector('#goBtn'); A.wait_for_timeout(200)
    code = A.evaluate('() => window.__dalmuti.net().code')
    B = mk(b, 'B', '#' + code)
    assert B.input_value('#codeIn') == code, '초대 링크로 열면 방 번호가 채워짐'
    B.fill('#nameIn', '지수'); B.click('#joinBtn')
    C = mk(b, 'C', '#' + code); C.fill('#nameIn', '잠꾸러기'); C.click('#joinBtn')
    A.wait_for_function('() => window.__dalmuti.net().room.seats.filter(s => s.kind === "human").length === 3')
    # 방장 설정: 4명, 제한 시간 30초(시험 서버는 10배 빨라 3초), 3판
    A.click('[data-seg="max"] [data-val="4"]'); A.wait_for_timeout(150)
    A.click('[data-seg="turnSec"] [data-val="30"]'); A.wait_for_timeout(150)
    A.click('[data-seg="games"] [data-val="3"]'); A.wait_for_timeout(250)
    B.wait_for_function('() => window.__dalmuti.net().room.settings.turnSec === 30')
    A.screenshot(path=f'{OUT}/on-01-lobby-host.png'); B.screenshot(path=f'{OUT}/on-02-lobby-guest.png')
    assert not B.query_selector('#goBtn'), '방장 아니면 시작 버튼 없음'
    A.click('#goBtn')
    A.wait_for_function('() => { const S = window.__dalmuti.get(); return S && S.phase === "drawn"; }')
    A.screenshot(path=f'{OUT}/on-03-draw.png')
    shots = set(); stats = {'A': 0, 'B': 0, 'reload': False, 'timedOutBanner': False, 'away': False}
    t0 = time.time()
    while time.time() - t0 < 240:
        done = False
        for name, pg in (('A', A), ('B', B)):
            st = pg.evaluate(STATE)
            ids = st['ids']
            if st['room'] and st['room']['status'] == 'ended':
                done = True; continue
            if 'nextBtn' in ids: pg.click('#nextBtn'); continue
            if 'taxOk' in ids and 'tax' not in shots and name == 'A': pg.screenshot(path=f'{OUT}/on-05-tax.png'); shots.add('tax')
            if st['clock'] and 'clock' not in shots:
                pg.screenshot(path=f'{OUT}/on-04-myturn-{name}.png'); shots.add('clock')
            try:
                if act(pg, st): stats[name] += 1
            except Exception as e:
                pass  # 상태가 바뀌는 사이에 누름 — 다음 바퀴에 다시
        cs = C.evaluate(STATE)
        if not stats['timedOutBanner'] and '자동으로' in C.inner_text('#banner'):
            stats['timedOutBanner'] = True; C.screenshot(path=f'{OUT}/on-06-timeout-C.png')
        if cs['room'] and cs['room']['seats'][cs['me']]['away'] and not stats['away']:
            stats['away'] = True; A.screenshot(path=f'{OUT}/on-07-away-seen-by-A.png')
        # 2판째에 B가 새로고침 → 같은 자리로 복귀
        if not stats['reload'] and cs['S'] and cs['S']['gameNo'] == 2 and cs['S']['phase'] == 'play':
            seat = B.evaluate('() => window.__dalmuti.me()')
            B.reload(); B.wait_for_timeout(800)
            B.wait_for_function('() => window.__dalmuti.get() && window.__dalmuti.net().room')
            assert B.evaluate('() => window.__dalmuti.me()') == seat, '새로고침해도 같은 자리'
            stats['reload'] = True
        if done: break
        A.wait_for_timeout(60)
    A.wait_for_selector('#againBtn', timeout=8000)
    A.screenshot(path=f'{OUT}/on-08-final-host.png'); B.screenshot(path=f'{OUT}/on-09-final-guest.png')
    final = A.evaluate('() => window.__dalmuti.get().players.map(p => [p.name, p.score, p.hist])')
    A.click('#againBtn')
    A.wait_for_selector('#goBtn'); B.wait_for_selector('#outBtn')
    B.click('#outBtn'); B.wait_for_timeout(300)
    assert B.evaluate('() => window.__dalmuti.net()') is None, '나가면 접속 끊김'
    B.wait_for_selector('#quickBtn')
    ov = [pg.evaluate('document.documentElement.scrollWidth > innerWidth') for pg in (A, B, C)]
    print(json.dumps({'stats': stats, 'final': final, 'overflow': ov, 'errors': errors[:10], 'secs': round(time.time() - t0)}, ensure_ascii=False))
    b.close()
