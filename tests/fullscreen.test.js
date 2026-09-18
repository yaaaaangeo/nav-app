/*
 * 전체화면(⛶) 버튼 테스트 — Fullscreen API 진입·종료·실패 처리와 지도 크기 연동
 * 실행: node --test tests/*.test.js
 *
 * index.html 안의 실제 함수 소스를 잘라 와서 가짜 document 위에서 돌린다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];

function extractFunction(name){
  const start = HTML.search(new RegExp('function ' + name + '\\s*\\('));
  assert.ok(start >= 0, name + ' 함수를 찾지 못했습니다');
  let depth = 0;
  for (let i = HTML.indexOf('{', start); i < HTML.length; i++){
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}' && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error(name + ' 함수의 끝을 찾지 못했습니다');
}

/** FULLSCREEN_ICON 처럼 여러 줄에 걸친 const 객체도 잘라 온다 */
function extractConstBlock(name){
  const start = HTML.indexOf('const ' + name + ' =');
  assert.ok(start >= 0, name + ' 상수를 찾지 못했습니다');
  // 문장 끝 ';' 뒤에 줄 끝 주석이 올 수 있고, index.html은 CRLF 줄바꿈이다
  const end = HTML.slice(start).search(/;[ \t]*(\/\/[^\r\n]*)?\r?\n/);
  return HTML.slice(start, start + end + 1);
}

const FUNCS = ['fullscreenElement', 'toggleFullscreen', 'enterFullscreen', 'exitFullscreen',
               'onFullscreenError', 'onFullscreenChange', 'renderFullscreenState'];

/**
 * 브라우저 흉내.
 * mode: 'std'(표준) · 'webkit'(구형 사파리) · 'none'(미지원)
 * behavior: 'ok' · 'reject'(카카오톡처럼 거절) · 'throw' · 'ignore'(조용히 무시)
 */
function makeBrowser({ mode = 'std', behavior = 'ok' } = {}){
  const calls = { request: [], exit: 0, toast: [], viewport: 0 };
  const timers = [];
  const btn = {
    innerHTML: '', title: '', attrs: {},
    classList: { set: new Set(), toggle(c, on){ on ? this.set.add(c) : this.set.delete(c); }, contains(c){ return this.set.has(c); } },
    setAttribute(k, v){ this.attrs[k] = v; },
  };
  const doc = {};
  const root = {};
  let fsEl = null;
  const setFs = v => {
    fsEl = v;
    if (mode === 'std') doc.fullscreenElement = v;
    if (mode === 'webkit') doc.webkitFullscreenElement = v;
  };
  setFs(null);
  const enter = arg => {
    calls.request.push(arg);
    if (behavior === 'throw') throw new TypeError('not allowed');
    if (behavior === 'reject') return Promise.reject(new TypeError('Permissions check failed'));
    if (behavior === 'ignore') return undefined;
    setFs(root);
    return mode === 'std' ? Promise.resolve() : undefined;
  };
  const exit = () => { calls.exit++; setFs(null); return mode === 'std' ? Promise.resolve() : undefined; };
  if (mode === 'std'){ root.requestFullscreen = enter; doc.exitFullscreen = exit; }
  if (mode === 'webkit'){ root.webkitRequestFullscreen = enter; doc.webkitExitFullscreen = exit; }
  doc.documentElement = root;

  const src = `
    ${extractConstBlock('FULLSCREEN_FAIL_MSG')}
    ${extractConstBlock('FULLSCREEN_CHECK_MS')}
    ${extractConstBlock('FULLSCREEN_ICON')}
    let fullscreenCheckTimer = null;
    function $(id){ return id === 'btn-fullscreen' ? __btn : null; }
    function toast(m){ __calls.toast.push(m); }
    function handleViewportChange(){ __calls.viewport++; }
    ${FUNCS.map(extractFunction).join('\n')}
    this.api = { toggleFullscreen, onFullscreenChange, renderFullscreenState, onFullscreenError };
  `;
  const ctx = {
    __btn: btn, __calls: calls, document: doc,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (id && timers[id - 1]) timers[id - 1].fn = null; },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const runTimers = () => { while (timers.length){ const t = timers.shift(); if (t.fn) t.fn(); } };
  const settle = () => new Promise(r => setImmediate(r));
  // 브라우저가 상태를 바꾼 뒤 보내는 fullscreenchange 이벤트를 흉내 낸다
  const fireChange = () => ctx.api.onFullscreenChange();
  return Object.assign(ctx.api, { btn, calls, timers, runTimers, settle, fireChange, root,
    isFull: () => !!fsEl, externalExit: () => setFs(null) });
}

test('처음에는 전체화면 아이콘 · 눌리지 않은 상태', () => {
  const b = makeBrowser();
  b.renderFullscreenState();
  assert.match(b.btn.innerHTML, /M4 9V4h5/);
  assert.strictEqual(b.btn.title, '전체화면');
  assert.strictEqual(b.btn.attrs['aria-pressed'], 'false');
  assert.ok(!b.btn.classList.contains('on'));
});

test('버튼을 누르면 문서 전체를 전체화면으로 — 이후 버튼은 종료 상태, 지도 크기를 다시 맞춘다', async () => {
  const b = makeBrowser();
  b.toggleFullscreen();
  await b.settle();
  assert.strictEqual(b.calls.request.length, 1);
  assert.strictEqual(JSON.stringify(b.calls.request[0]), '{"navigationUI":"hide"}');   // vm 컨텍스트 객체라 값으로 비교
  assert.ok(b.isFull());
  b.fireChange();
  assert.match(b.btn.innerHTML, /M9 4v5H4/);
  assert.strictEqual(b.btn.title, '전체화면 종료');
  assert.strictEqual(b.btn.attrs['aria-pressed'], 'true');
  assert.ok(b.btn.classList.contains('on'));
  assert.strictEqual(b.calls.viewport, 1, '즉시 한 번');
  b.runTimers();
  assert.strictEqual(b.calls.viewport, 2, '주소창이 늦게 사라지는 브라우저를 위해 한 번 더');
  assert.deepStrictEqual(b.calls.toast, [], '성공하면 안내를 띄우지 않는다');
});

test('전체화면에서 다시 누르면 종료 — 버튼과 지도 크기가 원래대로', async () => {
  const b = makeBrowser();
  b.toggleFullscreen(); await b.settle(); b.fireChange();
  b.toggleFullscreen(); await b.settle();
  assert.strictEqual(b.calls.exit, 1);
  assert.ok(!b.isFull());
  b.fireChange();
  assert.strictEqual(b.btn.title, '전체화면');
  assert.ok(!b.btn.classList.contains('on'));
  assert.ok(b.calls.viewport >= 2);
});

test('ESC·안드로이드 뒤로가기로 빠져나와도 버튼 상태가 실제 상태를 따른다', async () => {
  const b = makeBrowser();
  b.toggleFullscreen(); await b.settle(); b.fireChange();
  b.externalExit(); b.fireChange();
  assert.strictEqual(b.btn.attrs['aria-pressed'], 'false');
  assert.strictEqual(b.calls.exit, 0, '앱이 종료를 부른 게 아니다');
  b.toggleFullscreen(); await b.settle();
  assert.strictEqual(b.calls.request.length, 2, '다시 누르면 재진입');
});

test('구형 사파리(webkit 접두사)도 진입·종료된다', async () => {
  const b = makeBrowser({ mode: 'webkit' });
  b.toggleFullscreen(); await b.settle();
  assert.ok(b.isFull());
  b.fireChange();
  assert.strictEqual(b.btn.attrs['aria-pressed'], 'true');
  b.toggleFullscreen();
  assert.strictEqual(b.calls.exit, 1);
  b.runTimers();
  assert.deepStrictEqual(b.calls.toast, []);
});

test('Fullscreen API가 없는 브라우저(iPhone Safari 등) — 오류 없이 안내만', () => {
  const b = makeBrowser({ mode: 'none' });
  assert.doesNotThrow(() => b.toggleFullscreen());
  assert.strictEqual(b.calls.toast.length, 1);
  assert.match(b.calls.toast[0], /전체화면을 지원하지 않습니다.*외부 브라우저/);
});

test('카카오톡 인앱처럼 요청을 거절하면 — 안내 한 번, 앱 상태는 그대로', async () => {
  const b = makeBrowser({ behavior: 'reject' });
  assert.doesNotThrow(() => b.toggleFullscreen());
  await b.settle();
  b.runTimers();
  assert.strictEqual(b.calls.toast.length, 1);
  assert.ok(!b.isFull());
  assert.strictEqual(b.calls.viewport, 0, '화면이 안 바뀌었으니 지도도 건드리지 않는다');
});

test('요청이 예외를 던져도 앱이 멈추지 않는다', () => {
  const b = makeBrowser({ behavior: 'throw' });
  assert.doesNotThrow(() => b.toggleFullscreen());
  b.runTimers();
  assert.strictEqual(b.calls.toast.length, 1);
});

test('오류도 없이 조용히 무시하는 웹뷰 — 잠시 뒤 실제 상태를 보고 안내', async () => {
  const b = makeBrowser({ behavior: 'ignore' });
  b.toggleFullscreen(); await b.settle();
  assert.strictEqual(b.calls.toast.length, 0);
  assert.ok(b.timers.some(t => t.fn && t.ms >= 1000));
  b.runTimers();
  assert.strictEqual(b.calls.toast.length, 1);
});

test('자동 진입 없음 — 요청은 enterFullscreen 안에서만, enterFullscreen은 버튼 클릭에서만', () => {
  const uses = HTML.match(/\.(requestFullscreen|webkitRequestFullscreen)\s*\(/g) || [];
  const enterSrc = extractFunction('enterFullscreen');
  assert.strictEqual((enterSrc.match(/\.(requestFullscreen|webkitRequestFullscreen)\s*\(/g) || []).length, uses.length);
  const callers = HTML.match(/(?<!function )\b(enterFullscreen|toggleFullscreen)\b/g) || [];
  // 정의(function ...)를 뺀 나머지: toggleFullscreen 안의 enterFullscreen() 한 번 + onclick 연결 한 번
  assert.strictEqual(callers.length, 2);
  assert.match(HTML, /\$\('btn-fullscreen'\)\.onclick = toggleFullscreen;/);
});

test('이벤트 연결 — 표준·webkit 변경/오류 이벤트', () => {
  assert.match(HTML, /\['fullscreenchange', 'webkitfullscreenchange'\]\.forEach\(ev => document\.addEventListener\(ev, onFullscreenChange\)\)/);
  assert.match(HTML, /\['fullscreenerror', 'webkitfullscreenerror'\]\.forEach\(ev => document\.addEventListener\(ev, onFullscreenError\)\)/);
});

test('전체화면 처리는 주행 상태·저장값을 건드리지 않는다', () => {
  const src = FUNCS.map(extractFunction).join('\n');
  assert.doesNotMatch(src, /\b(loc|scKey|legIdx|legs|routeCoords|isPlaying|followMode|headingUp|lsSet|saveCheckpoint|localStorage)\b/);
});

test('HTML — 버튼은 map-tools 안 마지막(🛣️ 다음)', () => {
  const tools = HTML.slice(HTML.indexOf('<div id="map-tools">'), HTML.indexOf('</div>', HTML.indexOf('<div id="map-tools">')));
  assert.ok(tools.indexOf('id="btn-overview"') < tools.indexOf('id="btn-fullscreen"'));
  assert.match(tools, /<button class="map-btn" id="btn-fullscreen" title="전체화면"/);
});

test('CSS — 전체화면 규칙은 표준/webkit을 따로 적고, 헤더는 숨기지 않는다', () => {
  assert.match(CSS, /:root:fullscreen\{[^}]*height:100%/);
  assert.match(CSS, /:root:-webkit-full-screen\{[^}]*height:100%/);
  assert.doesNotMatch(CSS, /:root:fullscreen\s*,/, '한 규칙에 묶으면 모르는 브라우저에서 통째로 무시된다');
  assert.doesNotMatch(CSS, /(fullscreen|full-screen)[^{]*#hdr/);
});

test('CSS — 지도 버튼은 공간이 모자랄 때만 왼쪽 줄로 넘긴다', () => {
  assert.match(CSS, /#map-tools\{[^}]*grid-template-rows:repeat\(auto-fit,40px\)[^}]*direction:rtl;max-height:calc\(100% - 118px\)/);
  assert.match(CSS, /#map-tools > \*\{direction:ltr;\}/);
});
