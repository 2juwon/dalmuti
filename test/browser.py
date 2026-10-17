# 브라우저 자동 플레이: 사람 자리(0번)를 화면 버튼으로 두고 컴퓨터와 한 경기 끝까지
import sys, json, time
from playwright.sync_api import sync_playwright
URL = 'file://' + sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else '.'
W = int(sys.argv[3]) if len(sys.argv) > 3 else 390
N = int(sys.argv[4]) if len(sys.argv) > 4 else 5
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': W, 'height': 844}, color_scheme='dark')
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text) if 'ERR_TUNNEL' not in m.text else None)
    pg.add_init_script('window.__dalmutiFast = true'); pg.set_default_timeout(3000)
    pg.goto(URL); pg.wait_for_timeout(300)
    pg.screenshot(path=f'{OUT}/01-start.png')
    pg.click(f'[data-seg="n"] [data-val="{N}"]'); pg.click('[data-seg="games"] [data-val="3"]')
    pg.click('#startBtn'); pg.wait_for_timeout(200)
    pg.screenshot(path=f'{OUT}/02-draw.png')
    pg.click('#dealBtn')
    shots = {'tax': False, 'follow': False, 'lead': False, 'result': False, 'revo': False}
    stats = {'plays': 0, 'passes': 0, 'gives': 0, 'revo': 0, 'games': 0}
    t0 = time.time()
    while time.time() - t0 < 240:
        pg.wait_for_timeout(40)
        st = pg.evaluate('''() => { const S = window.__dalmuti.get(); if (!S) return null;
          const p = DM.pending(S); return { phase: S.phase, pend: p, game: S.gameNo, trick: S.trick,
            sheet: !document.getElementById('sheetWrap').hidden, ids: [...document.querySelectorAll('button[id]')].filter(b=>b.offsetParent).map(b=>b.id) } }''')
        if st is None: continue
        ids = st['ids']
        if 'againBtn' in ids:
            pg.screenshot(path=f'{OUT}/09-final.png'); break
        if 'nextBtn' in ids:
            if not shots['result']: pg.screenshot(path=f'{OUT}/08-result.png'); shots['result'] = True
            stats['games'] += 1; pg.click('#nextBtn'); continue
        if 'revYes' in ids:
            if not shots['revo']: pg.screenshot(path=f'{OUT}/05-revo.png'); shots['revo'] = True
            stats['revo'] += 1; pg.click('#revYes'); continue
        if 'revOk' in ids: pg.click('#revOk'); continue
        if 'taxOk' in ids:
            if not shots['tax']: pg.screenshot(path=f'{OUT}/04-tax-summary.png'); shots['tax'] = True
            pg.click('#taxOk'); continue
        if 'autoGive' in ids:
            pg.screenshot(path=f'{OUT}/03-giveback.png')
            pg.click('#autoGive'); pg.wait_for_timeout(50); pg.click('#playBtn'); stats['gives'] += 1; continue
        if st['sheet'] or not st['pend'] or st['pend']['pid'] != 0 or st['phase'] != 'play': continue
        # 내 차례: 컴퓨터 판단을 빌려 화면으로 둔다
        m = pg.evaluate('() => { const S = window.__dalmuti.get(); const c = DM.clone(S); c.players[0].level = "normal"; const d = DMAI.decide(c); return d && d.pid === 0 ? d : null; }')
        if not m: continue
        if m['type'] == 'pass':
            if pg.evaluate('() => DM.moves(window.__dalmuti.get(), 0).length') == 0: continue  # 자동 패스에 맡김
            if pg.is_disabled('#passBtn'): errors.append('패스 버튼이 꺼져 있음'); break
            pg.click('#passBtn'); stats['passes'] += 1; continue
        key = 'follow' if st['trick'] else 'lead'
        try:
          _ = None
          if m['v'] == 13:
              for _ in range(m['j']): pg.click('.stack[data-v="13"]')
          else:
              pg.click(f'.stack[data-v="{m["v"]}"]')
              if not st['trick']:
                  h = pg.evaluate('() => window.__dalmuti.get().players[0].hand')
                  for _ in range(h[m['v']] - m['n']): pg.click(f'.stack[data-v="{m["v"]}"]')
                  for _ in range(m['j']): pg.click('.stack[data-v="13"]')
          pg.wait_for_timeout(30)
          if not shots[key]: pg.screenshot(path=f'{OUT}/0{6 if key=="lead" else 7}-{key}.png'); shots[key] = True
          if pg.is_disabled('#playBtn'):
              errors.append('내기 버튼 꺼짐: ' + json.dumps(m) + ' ' + pg.inner_text('#hint')); pg.click('#passBtn') if not pg.is_disabled('#passBtn') else None; continue
          pg.click('#playBtn'); stats['plays'] += 1
        except Exception as e:
          stats.setdefault('races', 0); stats['races'] += 1
    ov = pg.evaluate('() => document.documentElement.scrollWidth > innerWidth')
    final = pg.evaluate('() => { const S = window.__dalmuti.get(); return { phase: S.phase, scores: S.players.map(p=>[p.name,p.score,p.hist]) } }')
    print(json.dumps({'stats': stats, 'final': final, 'overflow': ov, 'errors': errors[:10], 'secs': round(time.time()-t0)}, ensure_ascii=False))
    b.close()
