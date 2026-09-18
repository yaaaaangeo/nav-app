/*
 * 지도 회전(Tmapv3 bearing 헤딩업) · 화면 회전(resize) · 가로 화면 레이아웃 테스트
 * 실행: node --test tests/*.test.js
 *
 * index.html 안의 실제 함수 소스를 잘라 와서 가짜 Tmapv3 지도·DOM 위에서 돌린다.
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

/**
 * 가짜 Tmapv3 지도. easeTo는 곧바로 끝난 것처럼 bearing·center를 바꾸고 호출을 기록한다.
 * opts.noEase: 내부 카메라 API가 없는 경우(공개 API로 대신 옮기는지 확인)
 */
function makeView(opts = {}){
  const calls = { resize: 0, ease: [], setCenter: [], setBearing: [], toasts: [] };
  const state = { bearing: 0, center: null };
  const cam = { easeTo(o){ calls.ease.push(JSON.parse(JSON.stringify(o))); if (o.bearing != null) state.bearing = o.bearing; if (o.center) state.center = o.center; } };
  const map = {
    resize(){ calls.resize++; },
    getBearing(){ return state.bearing; },
    setBearing(b){ calls.setBearing.push(b); state.bearing = b; },
    setCenter(ll){ calls.setCenter.push(ll); },
    getZoom(){ return 16; },
    vsmMap(){ return opts.noEase ? { getCamera(){ return {}; } } : { getCamera(){ return cam; } }; },
  };
  const btn = { innerHTML: '', title: '', classList: { toggle(){} },
    querySelector(){ return this.innerHTML ? this._svg || (this._svg = { style: {} }) : null; } };
  const car = { style: {} };
  const timers = [];
  const src = `
    ${['LOOKAHEAD_RATIO', 'LOOKAHEAD_MAX_PX', 'VIEWPORT_SETTLE_MS', 'CAMERA_EASE_MS', 'COMPASS_SVG']
      .map(extractConst).join('\n')}
    let headingUp = true, followMode = true, followPauseUntil = 0, editMode = false;
    let displayHeading = 0, lastPos = [37.5, 127.03], carHeading = 0, carIcoDeg = 0, compassDeg = 0;
    let map = __map;
    const K = { headingUp: 'k' };
    function $(id){ return id === 'btn-headup' ? __btn : { clientHeight: 400, classList: { toggle(){} } }; }
    const document = { getElementById: id => id === 'car-ico' ? __car : null };
    function LL(a, b){ return [a, b]; }
    function scheduleSectorRedraw(){}
    function lsSet(){}
    function saveCheckpoint(){}
    function toast(m){ __calls.toasts.push(m); }
    function setFollow(on){ followMode = on; followPauseUntil = 0; }
    let viewportTimer = null;
    ${['nearestAngle', 'getMapBearing', 'headingActive', 'easeCamera', 'followCamera', 'rotateMapTo',
       'applyMapRotation', 'isRotated', 'toggleHeadingUp', 'renderCompass', 'onMapBearingChanged', 'syncCarIcon',
       'handleViewportChange', 'handleOrientationChange', 'followTarget', 'metersPerPixel', 'destinationPoint']
      .map(extractFunction).join('\n')}
    this.api = {
      applyMapRotation, handleViewportChange, handleOrientationChange, followCamera, toggleHeadingUp, syncCarIcon,
      set heading(v){ displayHeading = v; carHeading = v; },
      set headingUp(v){ headingUp = v; }, get headingUp(){ return headingUp; },
      set followMode(v){ followMode = v; },
      set editMode(v){ editMode = v; }, set pausedFor(ms){ followPauseUntil = Date.now() + ms; },
      set map(v){ map = v; },
      get state(){ return { headingUp, followMode, displayHeading, lastPos, editMode }; },
    };
  `;
  const ctx = {
    __map: map, __calls: calls, __btn: btn, __car: car, Math, Number, Date, isFinite, JSON,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (id && timers[id - 1]) timers[id - 1].fn = null; },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const flush = () => { while (timers.length){ const t = timers.shift(); if (t.fn) t.fn(); } };
  return Object.assign(ctx.api, { calls, timers, flush, mapState: state, btn, car, fakeMap: map });
}

/* ─────────── 헤딩업 (Tmapv3 bearing) ─────────── */

test('헤딩업 — 따라가기 카메라가 중심과 진행 방향(bearing)을 한 번의 easeTo로 옮긴다', () => {
  const v = makeView();
  v.heading = 90;
  v.followCamera(37.5, 127.03);
  assert.strictEqual(v.calls.ease.length, 1);
  const o = v.calls.ease[0];
  assert.strictEqual(o.bearing, 90, 'bearing = 진행 방향 (90이면 동쪽이 위)');
  assert.ok(Array.isArray(o.center) && o.center[0] > 127.03, '중심은 진행 방향(동쪽) 앞쪽');
});

test('헤딩업 — 359°→1°로 넘어갈 때 반대로 한 바퀴 돌지 않는다', () => {
  const v = makeView();
  v.heading = 355; v.followCamera(37.5, 127.03);
  const a = v.mapState.bearing;
  v.heading = 3; v.followCamera(37.5, 127.03);
  assert.ok(Math.abs(v.mapState.bearing - a) <= 10, '변화량 ' + (v.mapState.bearing - a));
  for (let h = 3; h < 3 + 720; h += 20){
    const before = v.mapState.bearing; v.heading = h % 360; v.followCamera(37.5, 127.03);
    assert.ok(Math.abs(v.mapState.bearing - before) <= 20);
  }
});

test('헤딩업 — 손으로 만져 일시정지·추적 해제 중에는 방향을 건드리지 않는다 (손으로 돌린 방향 유지)', () => {
  const v = makeView();
  v.mapState.bearing = 37;          // 사용자가 두 손가락으로 돌려 둔 상태
  v.heading = 120; v.pausedFor = 10000;
  v.applyMapRotation();
  v.followCamera(37.5, 127.03);
  assert.strictEqual(v.mapState.bearing, 37);
  assert.ok(v.calls.ease.every(o => o.bearing == null));
  v.pausedFor = -1; v.followMode = false;
  v.applyMapRotation();
  assert.strictEqual(v.mapState.bearing, 37);
});

test('헤딩업 꺼짐 — 따라가기는 중심만 옮기고 방향은 그대로', () => {
  const v = makeView();
  v.headingUp = false; v.heading = 200;
  v.followCamera(37.5, 127.03);
  assert.strictEqual(v.calls.ease[0].bearing, undefined);
  assert.ok(v.calls.ease[0].center);
});

test('경로 수정 중 — GPS가 와도 돌리지 않고 북쪽으로 되돌린다', () => {
  const v = makeView();
  v.mapState.bearing = 80; v.editMode = true; v.heading = 45;
  v.applyMapRotation();
  assert.strictEqual(v.mapState.bearing, 0);
  v.followCamera(37.5, 127.03);
  assert.strictEqual(v.mapState.bearing, 0);
});

test('🧭 — 헤딩업 → 북쪽 고정 → (손으로 돌린 뒤) 북쪽으로만 → 북쪽에서 누르면 헤딩업', () => {
  const v = makeView();
  v.heading = 120; v.followCamera(37.5, 127.03);
  assert.strictEqual(v.mapState.bearing, 120);
  v.toggleHeadingUp();                               // 헤딩업 → 북쪽 고정
  assert.strictEqual(v.headingUp, false);
  assert.strictEqual(((v.mapState.bearing % 360) + 360) % 360, 0);
  v.mapState.bearing = 45;                           // 손으로 돌림
  v.toggleHeadingUp();                               // → 북쪽으로만 (헤딩업은 켜지 않음)
  assert.strictEqual(v.headingUp, false);
  assert.strictEqual(((v.mapState.bearing % 360) + 360) % 360, 0);
  v.toggleHeadingUp();                               // 북쪽 → 헤딩업
  assert.strictEqual(v.headingUp, true);
  assert.strictEqual(v.mapState.bearing, 120);
});

test('차량 아이콘 — 마커는 지도와 함께 돌지 않으므로 (진행 방향 - bearing)으로 돌린다', () => {
  const v = makeView();
  v.heading = 120; v.mapState.bearing = 120;
  v.syncCarIcon();
  assert.strictEqual(v.car.style.transform, 'rotate(0.0deg)', '헤딩업이면 항상 위');
  v.mapState.bearing = 0; v.syncCarIcon();
  assert.strictEqual(v.car.style.transform, 'rotate(120.0deg)', '북쪽 고정이면 진행 방향 그대로');
});

test('🧭 바늘 — 지도 북쪽을 가리키도록 -bearing 만큼 돈다', () => {
  const v = makeView();
  v.headingUp = false;      // 손으로 동쪽이 위가 되게 돌려 둔 상태
  v.mapState.bearing = 90;
  v.applyMapRotation();   // renderCompass 포함
  assert.match(v.btn.innerHTML, /<svg/);
  assert.match(v.btn._svg.style.transform, /rotate\(-90\.0deg\)/);
});

test('내부 카메라 API(easeTo)가 없으면 공개 API(setCenter/setBearing)로 옮긴다', () => {
  const v = makeView({ noEase: true });
  v.heading = 60; v.followCamera(37.5, 127.03);
  assert.strictEqual(v.calls.setCenter.length, 1);
  assert.deepStrictEqual(v.calls.setBearing, [60]);
});

test('Tmapv3 축척 — metersPerPixel은 512px 타일 기준 (v2 식의 절반)', () => {
  const src = extractFunction('metersPerPixel');
  assert.match(src, /78271\.51696/);
  assert.match(HTML, /const DRIVE_ZOOM\s*= 17 \+ V3_ZOOM_OFFSET;/);
  assert.match(HTML, /const V3_ZOOM_OFFSET\s*= -1;/);
});

test('CSS 회전 방식은 쓰지 않는다', () => {
  assert.doesNotMatch(CSS, /#map_div\.heading-up\s*\{/);
  assert.doesNotMatch(HTML, /--map-rot|headingCoverScale/);
});

/* ─────────── 화면 회전 · resize ─────────── */

test('화면 크기 변경 — 잠시 뒤 map.resize() 하고, 따라가는 중이면 차량 앞쪽·방향을 바로 맞춘다', () => {
  const v = makeView();
  v.heading = 30;
  v.handleViewportChange();
  assert.strictEqual(v.calls.resize, 0, '레이아웃이 바뀐 뒤에 재야 하므로 바로 부르지 않는다');
  assert.ok(v.timers[0].ms >= 100 && v.timers[0].ms <= 200);
  v.flush();
  assert.strictEqual(v.calls.resize, 1);
  assert.strictEqual(v.calls.setCenter.length, 1, '크기 변경 직후에는 애니메이션 없이 바로');
  assert.strictEqual(v.mapState.bearing, 30);
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

test('화면 크기 변경 — 따라가지 않거나 손으로 옮긴 직후에는 중심을 건드리지 않는다', () => {
  const v = makeView();
  v.followMode = false;
  v.handleViewportChange(); v.flush();
  v.followMode = true; v.pausedFor = 10000;
  v.handleViewportChange(); v.flush();
  assert.strictEqual(v.calls.setCenter.length, 0);
  assert.strictEqual(v.calls.ease.filter(o => o.center).length, 0);
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
  v.map = { setCenter(){}, getZoom(){ return 15; }, getBearing(){ return 0; }, setBearing(){}, vsmMap(){ return { getCamera(){ return {}; } }; } };
  v.handleViewportChange(); v.flush();
  v.map = { resize(){ throw new Error('x'); }, setCenter(){}, getZoom(){ return 15; }, getBearing(){ return 0; }, setBearing(){}, vsmMap(){ throw new Error('y'); } };
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
