/*
 * 강남 고정경로 — routes.json 의 fixedRoutes 가 앱에서 그대로 쓰이는지
 * 실행: node --test tests/*.test.js
 *
 * 강남 4개 시나리오(ㄹ자·M자·링·링역방향) 42구간은 TMAP 재요청 없이
 * 저장된 좌표를 재생한다. 그러려면 아래가 모두 성립해야 한다.
 *   · 42구간 전부 fixedRoutes 에 있고 normalizeFixedRoute 를 통과한다
 *   · 고정경로 양끝이 구간 끝점과 맞는다 (핀 연결 한도 150m 안)
 *   · 앞 구간 도착점 = 다음 구간 출발점 (자동 전환의 전제)
 *   · 구간에 적힌 주행거리(dist)로 자동 전환 최소주행을 채울 수 있다
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ROUTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.json'), 'utf8'));

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

const GN = ['강남-a', '강남-b', '강남-c', '강남-d'];
const CONSTS = ['AUTO_LEG_SWITCH_DISTANCE_M', 'AUTO_LEG_SWITCH_MIN_TRAVEL_RATIO', 'SNAP_JOIN_MAX_M'];

/** 앱의 정규화·측정 함수를 그대로 쓴다 */
const api = (() => {
  const src = `
    const SNAP_JOIN_MAX_M = 150;   // parseTmapRoute 안의 핀 연결 한도와 같은 값
    ${['AUTO_LEG_SWITCH_DISTANCE_M', 'AUTO_LEG_SWITCH_MIN_TRAVEL_RATIO'].map(extractConst).join('\n')}
    let routeCoords = [], routeCum = [];
    ${['haversine', 'cloneLatLngList', 'cloneRouteSteps', 'normalizeFixedRoute',
       'buildCumulative', 'isActionable', 'resolveTurn'].map(extractFunction).join('\n')}
    this.api = {
      haversine, normalizeFixedRoute, isActionable,
      SNAP_JOIN_MAX_M, AUTO_LEG_SWITCH_DISTANCE_M, AUTO_LEG_SWITCH_MIN_TRAVEL_RATIO,
      /** 좌표열의 실제 길이(m) — buildCumulative 와 같은 계산 */
      measure(coords){ routeCoords = coords; buildCumulative(); return routeCum[routeCum.length - 1] || 0; },
    };
  `;
  const ctx = { Math, Number, Array, isFinite, String, Object };
  vm.createContext(ctx);
  vm.runInContext(extractConst('TURN_TYPE').replace(/^const TURN_TYPE = /, 'const TURN_TYPE = ') , ctx);
  vm.runInContext(src, ctx);
  return ctx.api;
})();

const gnLegs = () => {
  const out = [];
  for (const key of GN){
    const legs = ROUTES.customLegs[key];
    assert.ok(Array.isArray(legs) && legs.length, key + ' 구간이 없습니다');
    legs.forEach((leg, i) => out.push({ key, no: i + 1, leg, prev: i > 0 ? legs[i - 1] : null }));
  }
  assert.strictEqual(out.length, 42, '강남 구간 수가 42개가 아닙니다: ' + out.length);
  return out;
};

test('강남 42구간 전부 fixedRoutes 에 있고 정규화를 통과한다', () => {
  const missing = gnLegs()
    .filter(({ leg }) => !api.normalizeFixedRoute((ROUTES.fixedRoutes || {})[leg.id]))
    .map(({ key, no, leg }) => key + ' ' + no + '번 ' + leg.id);
  assert.deepStrictEqual(missing, [], '고정경로가 없거나 정규화 실패:\n  ' + missing.join('\n  '));
});

test('고정경로 양끝이 구간 끝점과 맞는다 (핀 연결 한도 150m 안)', () => {
  const bad = [];
  gnLegs().forEach(({ key, no, leg }) => {
    const f = api.normalizeFixedRoute(ROUTES.fixedRoutes[leg.id]);
    const c = f.coords;
    const gs = api.haversine(c[0][0], c[0][1], leg.sLL[0], leg.sLL[1]);
    const ge = api.haversine(c[c.length - 1][0], c[c.length - 1][1], leg.eLL[0], leg.eLL[1]);
    if (Math.max(gs, ge) > api.SNAP_JOIN_MAX_M)
      bad.push(key + ' ' + no + '번 ' + leg.id + ' 출발 ' + gs.toFixed(0) + 'm 도착 ' + ge.toFixed(0) + 'm');
  });
  assert.deepStrictEqual(bad, [], '끝점과 어긋난 고정경로:\n  ' + bad.join('\n  '));
});

test('앞 구간 도착점 = 다음 구간 출발점 (자동 전환의 전제)', () => {
  const gaps = gnLegs()
    .filter(({ prev, leg }) => prev && api.haversine(prev.eLL[0], prev.eLL[1], leg.sLL[0], leg.sLL[1]) > 1)
    .map(({ key, no, prev, leg }) => key + ' ' + no + '번 ' + leg.id + ' — 앞 구간과 ' +
      api.haversine(prev.eLL[0], prev.eLL[1], leg.sLL[0], leg.sLL[1]).toFixed(0) + 'm');
  assert.deepStrictEqual(gaps, [], '구간이 끊긴 곳:\n  ' + gaps.join('\n  '));
});

test('적힌 주행거리로 자동 전환 최소주행을 채울 수 있다', () => {
  // stepAutoLegSwitch: minTravelM = max(100, max(dist*1000, 고정경로길이) * 0.5)
  // 달릴 수 있는 거리는 고정경로 길이뿐이므로, dist 가 과하게 크면 영원히 전환되지 않는다.
  const stuck = [];
  gnLegs().forEach(({ key, no, leg }) => {
    const f = api.normalizeFixedRoute(ROUTES.fixedRoutes[leg.id]);
    const routeM = api.measure(f.coords.map(p => p.slice()));
    const legLengthM = Math.max((Number(leg.dist) || 0) * 1000, routeM);
    const minTravelM = Math.max(api.AUTO_LEG_SWITCH_DISTANCE_M,
                                legLengthM * api.AUTO_LEG_SWITCH_MIN_TRAVEL_RATIO);
    if (routeM < minTravelM)
      stuck.push(key + ' ' + no + '번 ' + leg.id + ' — 지정 ' + leg.dist +
        'km, 경로 ' + (routeM / 1000).toFixed(2) + 'km, 최소주행 ' + (minTravelM / 1000).toFixed(2) + 'km');
  });
  assert.deepStrictEqual(stuck, [], '자동 전환이 안 되는 구간:\n  ' + stuck.join('\n  '));
});

test('적힌 주행거리가 고정경로 실제 길이와 맞는다 (0.1km 이내)', () => {
  const off = [];
  gnLegs().forEach(({ key, no, leg }) => {
    const f = api.normalizeFixedRoute(ROUTES.fixedRoutes[leg.id]);
    const km = api.measure(f.coords.map(p => p.slice())) / 1000;
    if (Math.abs(km - (Number(leg.dist) || 0)) > 0.1)
      off.push(key + ' ' + no + '번 ' + leg.id + ' 지정 ' + leg.dist + 'km vs 경로 ' + km.toFixed(2) + 'km');
  });
  assert.deepStrictEqual(off, [], '주행거리가 어긋난 구간:\n  ' + off.join('\n  '));
});

test('고정경로마다 턴바이턴 안내 지점이 있다', () => {
  const noSteps = gnLegs()
    .filter(({ leg }) => api.normalizeFixedRoute(ROUTES.fixedRoutes[leg.id]).steps.filter(api.isActionable).length === 0)
    .map(({ key, no, leg }) => key + ' ' + no + '번 ' + leg.id);
  assert.deepStrictEqual(noSteps, [], '안내 지점이 없는 구간:\n  ' + noSteps.join('\n  '));
});

test('고정경로가 있으면 TMAP을 호출하지 않는다 (코드 경로 확인)', () => {
  const body = extractFunction('fetchTmapRoute');
  // 경로 요청보다 먼저 고정경로를 적용하고 즉시 반환한다
  const fixedAt = body.indexOf('applyFixedRoute(FIXED_ROUTES[legId]');
  const fetchAt = body.indexOf('await fetch(TMAP.routes');
  assert.ok(fixedAt >= 0, 'applyFixedRoute 분기가 없습니다');
  assert.ok(fetchAt > fixedAt, '고정경로 분기가 TMAP 호출보다 앞에 있어야 합니다');
  assert.match(body.slice(fixedAt, fixedAt + 200), /return;/);
  // routes.json 의 fixedRoutes 를 읽어 FIXED_ROUTES 에 넣는다
  assert.match(extractFunction('loadRoutesJson'), /d\.fixedRoutes/);
});

test('routes.json 은 기기 수정본보다 먼저 적용된다 (기기 상태를 덮지 않는다)', () => {
  const i = HTML.indexOf('await routesReady');
  const j = HTML.indexOf('applyRouteEdits()', i);
  assert.ok(i >= 0 && j > i, 'routesReady 다음에 applyRouteEdits 가 와야 합니다');
});

test('강남 외 지역은 고정경로를 넣지 않았다 (TMAP 추천 유지)', () => {
  const ids = Object.keys(ROUTES.fixedRoutes || {});
  assert.strictEqual(ids.length, 42, '고정경로 수: ' + ids.length);
  const outside = ids.filter(id => !/^GN-/.test(id));
  assert.deepStrictEqual(outside, [], '강남이 아닌 고정경로: ' + outside.join(', '));
});
