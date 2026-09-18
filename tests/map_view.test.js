/*
 * 지도 회전(헤딩업) · 화면 회전(resize) · 가로 화면 레이아웃 테스트
 * 실행: node --test tests/*.test.js
 *
 * index.html 안의 실제 함수 소스를 잘라 와서 가짜 지도·DOM 위에서 돌린다.
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

function extractConst(name){
  const m = HTML.match(new RegExp('const ' + name + '\\s*=\\s*([^;]+);'));
  assert.ok(m, name + ' 상수를 찾지 못했습니다');
  return 'const ' + name + ' = ' + m[1] + ';';
}

/** 지도·DOM·타이머를 흉내 낸 샌드박스 */
function makeView(){
  const el = {
    clientWidth: 430, clientHeight: 400, style: { props: {}, setProperty(k, v){ this.props[k] = v; } },
    classList: { set: new Set(),
      toggle(c, on){ on ? this.set.add(c) : this.set.delete(c); }, contains(c){ return this.set.has(c); } },
  };
  const timers = [];
  const calls = { resize: 0, setCenter: [], sectorRedraw: 0 };
  const map = {
    resize(){ calls.resize++; },
    setCenter(ll){ calls.setCenter.push(ll); },
    getZoom(){ return 17; },
  };
  const src = `
    ${['HEADING_SCALE_PAD', 'HEADING_SCALE_MAX', 'LOOKAHEAD_RATIO', 'LOOKAHEAD_MAX_PX', 'VIEWPORT_SETTLE_MS']
      .map(extractConst).join('\n')}
    let headingUp = true, followMode = true, followPauseUntil = 0, editMode = false;
    let displayHeading = 0, lastPos = [37.5, 127.03];
    let map = __map;
    function $(){ return __el; }
    function LL(a, b){ return [a, b]; }
    function beginProgrammaticMove(){}
    function scheduleSectorRedraw(){ __calls.sectorRedraw++; }
    let mapRotDeg = 0;
    let viewportTimer = null;
    ${['headingCoverScale', 'applyMapRotation', 'handleViewportChange', 'handleOrientationChange',
       'followTarget', 'metersPerPixel', 'destinationPoint'].map(extractFunction).join('\n')}
    this.api = {
      applyMapRotation, handleViewportChange, handleOrientationChange,
      set heading(v){ displayHeading = v; },
      set headingUp(v){ headingUp = v; }, set followMode(v){ followMode = v; },
      set editMode(v){ editMode = v; }, set pausedFor(ms){ followPauseUntil = Date.now() + ms; },
      set map(v){ map = v; },
      get state(){ return { headingUp, followMode, displayHeading, lastPos, editMode }; },
    };
  `;
  const ctx = {
    __el: el, __map: map, __calls: calls, Math, Number, Date, isFinite,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (id && timers[id - 1]) timers[id - 1].fn = null; },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const flush = () => { while (timers.length){ const t = timers.shift(); if (t.fn) t.fn(); } };
  const rot = () => parseFloat(el.style.props['--map-rot']);
  return Object.assign(ctx.api, { el, calls, timers, flush, rot, fakeMap: map });
}

/* ─────────── 헤딩업 ─────────── */

test('헤딩업 — 진행 방향 반대로 돌려 진행 방향이 화면 위로 온다', () => {
  const v = makeView();
  v.heading = 90; v.applyMapRotation();
  assert.ok(v.el.classList.contains('heading-up'));
  assert.strictEqual(v.rot(), -90);
  assert.ok(parseFloat(v.el.style.props['--map-scale']) > 1, '회전으로 드러나는 모서리를 확대로 덮는다');
});

test('헤딩업 — 359°→1°로 넘어갈 때 반대로 한 바퀴 돌지 않는다', () => {
  const v = makeView();
  v.heading = 355; v.applyMapRotation();
  const a = v.rot();
  v.heading = 3; v.applyMapRotation();
  const b = v.rot();
  assert.ok(Math.abs(b - a) <= 10, '회전 변화량이 8°여야 하는데 ' + (b - a) + '°');
  // 계속 같은 방향으로 돌아도 매번 가까운 쪽으로 이어진다
  for (let h = 3; h < 3 + 720; h += 20){ const before = v.rot(); v.heading = h % 360; v.applyMapRotation(); assert.ok(Math.abs(v.rot() - before) <= 20); }
});

test('헤딩업 — 북쪽 고정으로 돌렸다가 다시 켜면 0°에서 가까운 쪽으로 시작한다', () => {
  const v = makeView();
  for (let h = 0; h <= 700; h += 20){ v.heading = h % 360; v.applyMapRotation(); }   // 누적 회전각이 커진 상태
  v.headingUp = false; v.applyMapRotation();
  assert.ok(!v.el.classList.contains('heading-up'));
  assert.strictEqual(v.rot(), 0);
  v.headingUp = true; v.heading = 350; v.applyMapRotation();
  assert.strictEqual(v.rot(), 10, '350°는 -350°가 아니라 +10°로 돌아야 한다');
});

test('헤딩업 — 손으로 만지는 동안(추적 일시정지)·추적 해제 시에는 북쪽 고정', () => {
  const v = makeView();
  v.heading = 120; v.applyMapRotation();
  v.pausedFor = 10000; v.applyMapRotation();
  assert.ok(!v.el.classList.contains('heading-up'));
  v.pausedFor = -1; v.followMode = false; v.applyMapRotation();
  assert.ok(!v.el.classList.contains('heading-up'));
  v.followMode = true; v.applyMapRotation();
  assert.ok(v.el.classList.contains('heading-up'));
});

test('헤딩업 — 경로 수정 중에는 GPS가 들어와도 다시 돌리지 않는다', () => {
  const v = makeView();
  v.editMode = true; v.heading = 45; v.applyMapRotation();
  assert.ok(!v.el.classList.contains('heading-up'));
  assert.strictEqual(v.rot(), 0);
  assert.strictEqual(v.el.style.props['--map-scale'], '1');
  v.editMode = false; v.applyMapRotation();
  assert.strictEqual(v.rot(), -45);
});

/* ─────────── 화면 회전 · resize ─────────── */

test('화면 크기 변경 — 잠시 뒤 map.resize() 후 회전 배율을 새 크기로 다시 계산한다', () => {
  const v = makeView();
  v.heading = 30; v.applyMapRotation();
  const portraitScale = v.el.style.props['--map-scale'];
  v.el.clientWidth = 900; v.el.clientHeight = 330;             // 가로로 돌림
  v.handleViewportChange();
  assert.strictEqual(v.calls.resize, 0, '레이아웃이 바뀐 뒤에 재야 하므로 바로 부르지 않는다');
  assert.ok(v.timers[0].ms >= 100 && v.timers[0].ms <= 200);
  v.flush();
  assert.strictEqual(v.calls.resize, 1);
  assert.strictEqual(v.calls.sectorRedraw, 1);
  assert.notStrictEqual(v.el.style.props['--map-scale'], portraitScale);
  assert.strictEqual(v.rot(), -30, '헤딩업 회전은 그대로');
});

test('화면 크기 변경 — 연속 이벤트는 한 번으로 묶는다', () => {
  const v = makeView();
  for (let i = 0; i < 10; i++) v.handleViewportChange();
  v.flush();
  assert.strictEqual(v.calls.resize, 1);
});

test('기기 회전 — 즉시 한 번, 늦게 바뀌는 브라우저를 위해 한 번 더 확인한다', () => {
  const v = makeView();
  v.handleOrientationChange();
  v.flush();
  assert.strictEqual(v.calls.resize, 2);
});

test('화면 크기 변경 — 따라가는 중이면 차량 앞쪽으로 다시 맞추고, 아니면 중심을 건드리지 않는다', () => {
  const v = makeView();
  v.handleViewportChange(); v.flush();
  assert.strictEqual(v.calls.setCenter.length, 1);
  v.followMode = false;
  v.handleViewportChange(); v.flush();
  assert.strictEqual(v.calls.setCenter.length, 1, '추적을 끈 상태에서는 사용자가 보던 곳을 유지');
  v.followMode = true; v.pausedFor = 10000;
  v.handleViewportChange(); v.flush();
  assert.strictEqual(v.calls.setCenter.length, 1, '손으로 옮긴 직후(일시정지)에도 유지');
});

test('화면 크기 변경 — 주행 상태를 바꾸지 않는다', () => {
  const v = makeView();
  v.heading = 200;
  const before = JSON.stringify(v.state);
  v.handleOrientationChange(); v.flush();
  assert.strictEqual(JSON.stringify(v.state), before);
});

test('화면 크기 변경 — 지도가 아직 없거나 resize가 없어도 오류 없이 넘어간다', () => {
  const v = makeView();
  v.map = null;
  v.handleViewportChange(); v.flush();
  v.map = { setCenter(){}, getZoom(){ return 15; } };
  v.handleViewportChange(); v.flush();
  v.map = { resize(){ throw new Error('x'); }, setCenter(){}, getZoom(){ return 15; } };
  assert.doesNotThrow(() => { v.handleViewportChange(); v.flush(); });
});

test('이벤트 연결 — resize·orientationchange·screen.orientation(지원할 때만)', () => {
  assert.match(HTML, /window\.addEventListener\('resize', handleViewportChange\)/);
  assert.match(HTML, /window\.addEventListener\('orientationchange', handleOrientationChange\)/);
  assert.match(HTML, /screen\.orientation && typeof screen\.orientation\.addEventListener === 'function'/);
  assert.doesNotMatch(HTML, /addEventListener\('resize', applyMapRotation\)/);
  assert.match(extractFunction('setPanelFolded'), /handleViewportChange\(\)/);
});

/* ─────────── 가로 화면 레이아웃 (CSS) ─────────── */

function landscapeBlock(){
  const start = CSS.indexOf('@media (orientation:landscape) and (max-height:600px)');
  assert.ok(start > 0, '가로 화면 미디어 쿼리가 없습니다');
  let depth = 0;
  for (let i = CSS.indexOf('{', start); i < CSS.length; i++){
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) return { start, body: CSS.slice(start, i + 1) };
  }
}

test('가로 화면 — 방향+높이로 판단하고, 세로·PC 규칙보다 뒤에 있어 덮어쓴다', () => {
  const { start, body } = landscapeBlock();
  assert.ok(start > CSS.indexOf('@media(max-width:860px)'));
  assert.ok(start > CSS.indexOf('@media(min-width:861px)'));
  assert.match(body, /#main\{flex-direction:row;\}/);
  assert.match(body, /#map-wrap\{flex:1 1 auto;min-width:0;\}/);
  assert.match(body, /width:clamp\(240px, 38vw, 340px\)/);
});

test('가로 화면 — 패널 접으면 오른쪽 세로 띠만 남고 지도가 넓어진다', () => {
  const { body } = landscapeBlock();
  assert.match(body, /#panel\.folded\{\s*width:calc\(44px \+ env\(safe-area-inset-right\)\)/);
  assert.match(body, /#main\.panel-folded #map-wrap\{flex:1 1 auto;\}/);
  assert.match(body, /#panel\.folded #panel-title\{display:none;\}/);
});

test('가로 화면 — 노치·홈 인디케이터를 피하고 지도 버튼은 36px(터치 가능한 크기)', () => {
  const { body } = landscapeBlock();
  assert.match(body, /env\(safe-area-inset-right\)/);
  assert.match(body, /#turn-overlay\{[^}]*env\(safe-area-inset-left\)/);
  assert.match(body, /#map-tools\{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(body, /\.map-btn\{width:36px;height:36px;/);
  assert.match(CSS, /#hdr\{[\s\S]*?env\(safe-area-inset-left\)[\s\S]*?\}/);
});

test('manifest — 화면 방향을 잠그지 않는다', () => {
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.strictEqual(mf.orientation, 'any');
});
