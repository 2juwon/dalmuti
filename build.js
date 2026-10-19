// src/ → index.html (GitHub Pages 완성본), dist/dalmuti.html (아티팩트용)
const fs = require('fs');
const path = require('path');
const r = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
// 서버 주소: config.json (로컬 시험은 --server=http://127.0.0.1:8787 --out=dist/local.html)
let server = arg('server');
if (server == null) { try { server = JSON.parse(r('config.json')).server || ''; } catch (e) { server = ''; } }
if (server && !/^https?:\/\/[\w.:-]+$/.test(server)) throw new Error('서버 주소가 이상해요: ' + server);
const out = arg('out') || 'index.html';
let ui = r('src/ui.html');
const engine = r('src/engine.js'), ai = r('src/ai.js'), art = r('src/art.js'), music = r('src/music.js');
ui = ui.replace('/*@ENGINE*/', () => engine).replace('/*@AI*/', () => ai).replace('/*@ART*/', () => art).replace('/*@MUSIC*/', () => music);
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
// 아티팩트 안에서는 다른 서버에 접속할 수 없어서 혼자 하기만
fs.writeFileSync(path.join(__dirname, 'dist/dalmuti.html'), ui.replace('__SERVER_URL__', ''));
ui = ui.replace('__SERVER_URL__', () => server);
const head = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="달무티 카드 게임 — 컴퓨터 3~7명과 계급 다툼. 세금, 혁명, 대혁명까지.">
<meta property="og:title" content="달무티">
<meta property="og:description" content="먼저 손을 비운 사람이 왕이 됩니다. 컴퓨터와 하는 달무티 카드 게임.">
<meta property="og:type" content="website">
<meta name="theme-color" content="#11131b">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style>
`;
const page = head + ui.replace(/^<title>/, '<title>') .replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '') + '\n</html>\n';
// <title>~</style> 까지가 head, 나머지가 body
const cut = page.indexOf('</style>', page.indexOf('/* 궁정 연회장')) + '</style>'.length;
fs.writeFileSync(path.join(__dirname, out), page.slice(0, cut) + '\n</head>\n<body>\n' + page.slice(cut).replace(/\n<\/html>\n$/, '\n</body>\n</html>\n'));
console.log(out, fs.statSync(path.join(__dirname, out)).size, 'bytes / dist/dalmuti.html', fs.statSync(path.join(__dirname, 'dist/dalmuti.html')).size, 'bytes');
