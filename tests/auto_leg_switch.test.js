/*
 * 자동 구간 전환(100m 공통 기준) · 패널 접기 테스트
 * 실행: node --test tests/*.test.js
 *
 * index.html 안의 실제 함수 소스를 잘라 와서 가짜 DOM·상태 위에서 돌린다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ROUTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.json'), 'utf8'));

/** `function name(` 부터 짝이 맞는 `}` 까지 잘라 온다 */
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

const FUNCS = [
  'haversine', 'checkArrival', 'legRemainingMeters', 'newAutoSwitchState',
  'autoSwitchStateFor', 'stepAutoLegSwitch', 'completeLeg', 'nextLeg',
  'setPanelFolded', 'renderPanelTitle',
];
const CONSTS = [
  'OFF_ROUTE_DISTANCE_M', 'AUTO_LEG_SWITCH_DISTANCE_M', 'AUTO_LEG_SWITCH_MIN_TRAVEL_RATIO',
  'AUTO_LEG_SWITCH_MOVE_STEP_M', 'AUTO_LEG_SWITCH_MAX_JUMP_M',
];

/** 앱의 전역 상태를 흉내 낸 샌드박스 */
function makeApp(legs){
  const elements = {};
  const el = id => elements[id] || (elements[id] = {
    textContent: '', title: '', attrs: {},
    classList: {
      set: new Set(),
      toggle(c, on){ (on === undefined ? !this.set.has(c) : on) ? this.set.add(c) : this.set.delete(c); },
      contains(c){ return this.set.has(c); },
    },
    setAttribute(k, v){ this.attrs[k] = v; },
  });
  const store = {};
  const src = `
    ${CONSTS.map(extractConst).join('\n')}
    const K = { panelFolded: 'nav3-panel-folded' };
    const SCENARIOS = { 강남: { a: { name: 'ㄹ자 그리드' } } };
    let loc = '강남', scKey = 'a';
    function currentSector(){ return null; }
    let legs = __legs, legIdx = 0;
    const doneSet = new Set();
    let isPlaying = true, legStartTime = null, legStartPos = null, lastPos = null;
    let routeGeoM = 0, progressM = 0, progressInit = false, activeRouteLegId = null;
    let autoSwitch = newAutoSwitchState(null);
    const spoken = [];
    function nearestIndex(){}
    nearestIndex.lastDistance = null;
    function speak(t){ spoken.push(t); }
    function toast(){}
    function renderControls(){}
    function saveCheckpoint(){}
    function lsGet(k, d){ return k in __store ? __store[k] : d; }
    function lsSet(k, v){ __store[k] = v; }
    function $(id){ return __el(id); }
    const handleViewportChange = __ctxViewport;
    // applyLeg는 화면의 "현재 구간" 표시를 갱신한다 — 접힌 상태여도 똑같이 갱신된다.
    function applyLeg(){ $('cur-idx').textContent = (legIdx + 1) + ' / ' + legs.length + ' · ' + legs[legIdx].id; }
    ${FUNCS.map(extractFunction).join('\n')}
    applyLeg();
    this.api = {
      checkArrival, setPanelFolded, renderPanelTitle, applyLeg, spoken,
      get legIdx(){ return legIdx; }, set legIdx(v){ legIdx = v; },
      get isPlaying(){ return isPlaying; }, set isPlaying(v){ isPlaying = v; },
      setRoute(o){
        if ('routeGeoM' in o) routeGeoM = o.routeGeoM;
        if ('progressM' in o) progressM = o.progressM;
        if ('progressInit' in o) progressInit = o.progressInit;
        if ('activeRouteLegId' in o) activeRouteLegId = o.activeRouteLegId;
        if ('lastDistance' in o) nearestIndex.lastDistance = o.lastDistance;
      },
    };
  `;
  const resizes = [];
  const ctx = {
    __legs: legs, __store: store, __el: el, Math, Number, Set,
    __ctxViewport: () => resizes.push('viewport'),   // 지도 크기 재계산 요청을 기록한다
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return Object.assign(ctx.api, { el, store, resizes });
}

const R = 6371000, rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
function hv(a, b){
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * 출발지 → (옆으로 비켜 간 중간점) → 도착지 경로를 stepM 간격 점으로 만든다.
 * 실제 도로처럼 경로 길이가 구간 거리(dist)와 비슷해지도록 중간점을 옆으로 민다.
 */
function drivePath(leg, stepM = 10){
  const a = leg.sLL, b = leg.eLL;
  const want = Math.max(hv(a, b), (Number(leg.dist) || 0) * 1000);
  const mid = lerp(a, b, 0.5);
  const perp = [-(b[1] - a[1]), (b[0] - a[0])];
  const len = Math.hypot(perp[0], perp[1]) || 1;
  let lo = 0, hi = 0.2;
  const via = k => [mid[0] + perp[0] / len * k, mid[1] + perp[1] / len * k];
  for (let i = 0; i < 60; i++){
    const k = (lo + hi) / 2;
    (hv(a, via(k)) + hv(via(k), b) < want) ? (lo = k) : (hi = k);
  }
  const v = via(lo), pts = [];
  for (const [p, q] of [[a, v], [v, b]]){
    const n = Math.max(1, Math.ceil(hv(p, q) / stepM));
    for (let i = 0; i < n; i++) pts.push(lerp(p, q, i / n));
  }
  pts.push(b.slice());
  return pts;
}

function regionLegs(key){
  const legs = ROUTES.customLegs[key].map(l => Object.assign({}, l));
  assert.ok(legs.length >= 2, key + ' 구간이 2개 이상이어야 합니다');
  return legs;
}

/** 경로 로딩 전(직선거리) 기준으로 첫 구간을 달리며 전환 시점을 확인한다 */
function assertSwitchAt100(key){
  const legs = regionLegs(key);
  const app = makeApp(legs);
  let switchedAtRemaining = null, minBeforeSwitch = Infinity;
  for (const p of drivePath(legs[0])){
    const rem = hv(p, legs[0].eLL);
    app.checkArrival(p[0], p[1]);
    if (app.legIdx === 1){ switchedAtRemaining = rem; break; }
    minBeforeSwitch = Math.min(minBeforeSwitch, rem);
  }
  assert.notStrictEqual(switchedAtRemaining, null, key + ': 전환되지 않았습니다');
  assert.ok(switchedAtRemaining <= 100, key + ': 100m 밖에서 전환됨 (' + switchedAtRemaining + ')');
  assert.ok(minBeforeSwitch > 100, key + ': 100m 안에 들어왔는데 전환되지 않았습니다 (' + minBeforeSwitch + ')');
  assert.ok(switchedAtRemaining > 90, key + ': 100m 진입 직후(한 스텝 안)에 전환되어야 합니다 (' + switchedAtRemaining + ')');
  assert.match(app.el('cur-idx').textContent, new RegExp('^2 / \\d+ · ' + legs[1].id + '$'));
  return app;
}

test('기준 상수는 모든 지역 공통 100m이고 지역별 분기가 없다', () => {
  assert.match(extractConst('AUTO_LEG_SWITCH_DISTANCE_M'), /= 100;/);
  assert.doesNotMatch(HTML, /ARRIVAL_DISTANCE_M/);
  const body = extractFunction('checkArrival') + extractFunction('stepAutoLegSwitch') +
               extractFunction('legRemainingMeters');
  assert.doesNotMatch(body, /강남|판교|시흥|\bloc\b/);
});

test('시흥 100m 전환', () => { assertSwitchAt100('시흥-a'); });
test('강남 100m 전환', () => { assertSwitchAt100('강남-a'); });
test('판교 100m 전환', () => { assertSwitchAt100('판교-a'); });

test('모든 지역·시나리오 첫 구간이 100m 안에서 한 번 전환된다', () => {
  Object.keys(ROUTES.customLegs).forEach(k => {
    if (ROUTES.customLegs[k].length >= 2) assertSwitchAt100(k);
  });
});

test('연속 GPS update — 100m 안에 머물러도 한 번만 넘어간다', () => {
  const app = assertSwitchAt100('강남-a');
  const legs = regionLegs('강남-a');
  const end = legs[0].eLL;
  // A 도착지(= B 출발지) 근처에서 99m, 98m ... 로 계속 측위가 들어온다
  for (let i = 0; i < 200; i++){
    const p = lerp(end, legs[1].eLL, (i % 20) / 20 * (60 / Math.max(1, hv(end, legs[1].eLL))));
    app.checkArrival(p[0], p[1]);
  }
  assert.strictEqual(app.legIdx, 1);
  assert.strictEqual(app.spoken.filter(t => t === '목적지에 도착했습니다').length, 1);
});

test('B 구간은 B 도착지까지 100m 이하가 되어야 C로 넘어간다', () => {
  const legs = regionLegs('판교-a');
  const app = makeApp(legs);
  for (const p of drivePath(legs[0])){ app.checkArrival(p[0], p[1]); if (app.legIdx === 1) break; }
  assert.strictEqual(app.legIdx, 1);
  let at = null;
  for (const p of drivePath(legs[1])){
    app.checkArrival(p[0], p[1]);
    if (app.legIdx === 2){ at = hv(p, legs[1].eLL); break; }
  }
  assert.ok(at !== null && at <= 100 && at > 90, 'B→C 전환 거리: ' + at);
});

test('출발지·도착지가 가까운 순환 구간(PG-M-BASE-08, 103m)은 출발 직후 넘어가지 않는다', () => {
  const all = ROUTES.customLegs['판교-b'].map(l => Object.assign({}, l));
  const i = all.findIndex(l => l.id === 'PG-M-BASE-08');
  assert.ok(i >= 0);
  // 이 구간이 시나리오 마지막일 수 있어, 넘어갈 다음 구간으로 첫 구간을 붙인다
  const legs = [all[i], all[0]];
  const app = makeApp(legs);
  const loop = legs[0];
  assert.ok(hv(loop.sLL, loop.eLL) < 110);
  // 출발지에서 도착지 쪽으로 조금(60m) 움직이며 측위 반복 → 직선거리가 100m 아래로 내려가도 전환되면 안 된다
  for (let k = 0; k < 30; k++){
    const p = lerp(loop.sLL, loop.eLL, (k % 10) / 10 * 0.6);
    app.checkArrival(p[0], p[1]);
  }
  assert.strictEqual(app.legIdx, 0);
  // 순환 경로를 다 돌고 오면 한 번 전환된다
  for (const p of drivePath(loop)){ app.checkArrival(p[0], p[1]); if (app.legIdx === 1) break; }
  assert.strictEqual(app.legIdx, 1);
});

test('경로를 받아 둔 구간은 경로상 남은 거리(routeGeoM - progressM) 100m 기준', () => {
  const legs = regionLegs('강남-a');
  const app = makeApp(legs);
  const L = Number(legs[0].dist) * 1000;
  const pts = drivePath(legs[0]);
  app.setRoute({ routeGeoM: L, progressInit: true, activeRouteLegId: legs[0].id, lastDistance: 5 });
  let at = null;
  for (let i = 0; i < pts.length; i++){
    const prog = L * i / (pts.length - 1);
    app.setRoute({ progressM: prog });
    app.checkArrival(pts[i][0], pts[i][1]);
    if (app.legIdx === 1){ at = L - prog; break; }
  }
  assert.ok(at !== null && at <= 100 && at > 85, '경로 기준 전환 거리: ' + at);
});

test('수동 구간 변경 — 새 구간 기준으로 다시 판정하고 충돌하지 않는다', () => {
  const legs = regionLegs('시흥-a');
  const app = makeApp(legs);
  const path0 = drivePath(legs[0]);
  // A 중간까지 달리다가 수동으로 C(인덱스 2)를 고른다
  path0.slice(0, Math.floor(path0.length / 2)).forEach(p => app.checkArrival(p[0], p[1]));
  app.legIdx = 2; app.applyLeg();
  // A 도착지 근처에 와도 C 기준이므로 넘어가지 않는다
  path0.slice(-15).forEach(p => app.checkArrival(p[0], p[1]));
  assert.strictEqual(app.legIdx, 2);
  // C를 끝까지 달리면 D로 한 번 넘어간다
  for (const p of drivePath(legs[2])){ app.checkArrival(p[0], p[1]); if (app.legIdx === 3) break; }
  assert.strictEqual(app.legIdx, 3);
});

test('일시정지 중에는 전환하지 않는다', () => {
  const legs = regionLegs('강남-b');
  const app = makeApp(legs);
  app.isPlaying = false;
  drivePath(legs[0]).forEach(p => app.checkArrival(p[0], p[1]));
  assert.strictEqual(app.legIdx, 0);
});

test('마지막 구간 완료 후 다시 시작해도 완료가 반복되지 않는다', () => {
  const legs = regionLegs('강남-a').slice(0, 1);
  const app = makeApp(legs);
  const pts = drivePath(legs[0]);
  pts.forEach(p => app.checkArrival(p[0], p[1]));
  assert.strictEqual(app.isPlaying, false);
  app.isPlaying = true;
  pts.slice(-10).forEach(p => app.checkArrival(p[0], p[1]));
  assert.strictEqual(app.spoken.filter(t => t === '모든 구간을 완료했습니다').length, 1);
});

test('패널 접기/펼치기 — 표시만 바뀌고 상태는 유지된다', () => {
  const legs = regionLegs('강남-a');
  const app = makeApp(legs);
  const panel = app.el('panel'), main = app.el('main'), btn = app.el('panel-fold');
  app.setPanelFolded(true);
  assert.ok(panel.classList.contains('folded'));
  assert.ok(main.classList.contains('panel-folded'), '지도가 넓어지도록 #main에도 표시되어야 합니다');
  assert.strictEqual(btn.textContent, '▼');
  assert.strictEqual(btn.attrs['aria-expanded'], 'false');
  assert.strictEqual(app.store['nav3-panel-folded'], true);
  assert.deepStrictEqual(app.resizes, ['viewport'], '지도가 새 크기를 반영하도록 handleViewportChange를 불러야 합니다');
  app.setPanelFolded(false);
  assert.ok(!panel.classList.contains('folded'));
  assert.ok(!main.classList.contains('panel-folded'));
  assert.strictEqual(btn.textContent, '▲');
  assert.strictEqual(app.legIdx, 0);
  assert.match(app.el('cur-idx').textContent, /^1 \//);
});

test('접은 상태에서도 자동 전환되고, 펼치면 최신 현재 구간이 보인다', () => {
  const legs = regionLegs('판교-c');
  const app = makeApp(legs);
  app.setPanelFolded(true);
  for (const p of drivePath(legs[0])){ app.checkArrival(p[0], p[1]); if (app.legIdx === 1) break; }
  assert.strictEqual(app.legIdx, 1);
  app.setPanelFolded(false);
  assert.strictEqual(app.el('cur-idx').textContent, '2 / ' + legs.length + ' · ' + legs[1].id);
});

test('접힌 헤더에는 현재 지역·시나리오·구간이 남는다', () => {
  const legs = regionLegs('강남-a');
  const app = makeApp(legs);
  app.setPanelFolded(true);
  app.renderPanelTitle();
  assert.strictEqual(app.el('panel-title').textContent, '강남 · ㄹ자 그리드 · 1/' + legs.length);
  app.legIdx = 2; app.renderPanelTitle();
  assert.strictEqual(app.el('panel-title').textContent, '강남 · ㄹ자 그리드 · 3/' + legs.length);
});

test('HTML — 접기 버튼은 패널 헤더 우측에 있고 모든 섹션이 본문 안에 있다', () => {
  const head = HTML.indexOf('id="panel-head"'), fold = HTML.indexOf('id="panel-fold"');
  const body = HTML.indexOf('id="panel-body"');
  assert.ok(head > 0 && head < fold && fold < body);
  // 선택 컨트롤부터 목록까지 모두 접히는 본문 안에 들어 있다
  const order = ['id="loc-chips"', 'id="sc-chips"', 'id="cur-card"', 'id="btn-skip"',
                 'id="steps-head"', 'id="legs-body"'].map(t => HTML.indexOf(t));
  assert.ok(order.every((v, i) => v > body && (i === 0 || v > order[i - 1])));
  assert.match(HTML, /#panel\.folded #panel-body\{display:none;\}/);
  // 세로 배치에서는 지도가 남은 자리를 가져가고, 가로 배치에서는 패널이 좁은 띠가 된다
  assert.match(HTML, /#main\.panel-folded #map-wrap\{flex:1 1 auto;\}/);
  assert.match(HTML, /#panel\.folded\{width:48px;flex:0 0 48px;/);
});
