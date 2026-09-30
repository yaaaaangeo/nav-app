/*
 * 지정 경유점 보존 — sanitizeWaypoints 가 정상 코스의 경유점을 버리지 않는지
 * 실행: node --test tests/*.test.js
 *
 * 왕복·순환 코스는 반환점에서 180도 가까이 꺾는 것이 정상이다. 방위만 보고 걸러내면
 * 그 반환점을 버려서 지정 노선이 통째로 최단경로로 바뀐다 (시흥 ㄹ자 8번).
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

const FUNCS = ['haversine', 'bearing', 'bearingDiff',
  'waypointPathMeters', 'plannedMetersFor', 'sanitizeWaypoints', 'trimWaypoints'];
const CONSTS = ['WAYPOINT_PLAN_TOLERANCE', 'TMAP_MAX_PASS_POINTS'];

const api = (() => {
  const src = `
    ${CONSTS.map(extractConst).join('\n')}
    let legs = [];
    ${FUNCS.map(extractFunction).join('\n')}
    this.api = {
      haversine, waypointPathMeters, sanitizeWaypoints, trimWaypoints, plannedMetersFor,
      WAYPOINT_PLAN_TOLERANCE, TMAP_MAX_PASS_POINTS,
      setLegs(v){ legs = v; },
    };
  `;
  const ctx = { Math, Number, Array, isFinite };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.api;
})();

const plannedM = leg => (Number(leg.dist) || 0) * 1000;

/** 실제 앱과 같은 순서로 passList 에 실릴 경유점을 만든다 */
const passList = leg => api.trimWaypoints(
  api.sanitizeWaypoints(leg.sLL, leg.eLL, ROUTES.waypoints[leg.id] || [], plannedM(leg)),
  api.TMAP_MAX_PASS_POINTS);

/** 경유점이 하나라도 등록된 모든 구간 */
function legsWithWaypoints(){
  const out = [];
  for (const key of Object.keys(ROUTES.customLegs)){
    (ROUTES.customLegs[key] || []).forEach((leg, i) => {
      if ((ROUTES.waypoints[leg.id] || []).length) out.push({ key, no: i + 1, leg });
    });
  }
  assert.ok(out.length >= 50, '경유점이 있는 구간이 너무 적습니다: ' + out.length);
  return out;
}

const legOf = (key, id) => {
  const leg = (ROUTES.customLegs[key] || []).find(l => l.id === id);
  assert.ok(leg, key + ' 에 ' + id + ' 구간이 없습니다');
  return leg;
};

test('시흥 ㄹ자 8번 — 왕복 코스의 반환점 경유점이 살아 있다', () => {
  const leg = legOf('시흥-a', 'SH-L-BASE-8');
  const raw = ROUTES.waypoints[leg.id];
  assert.strictEqual(raw.length, 1);
  // 출발지와 도착지는 659m 인데 지정 거리는 6.6km — 3km 밖으로 나갔다 돌아오는 코스다.
  const direct = api.haversine(leg.sLL[0], leg.sLL[1], leg.eLL[0], leg.eLL[1]);
  assert.ok(direct < 700, '출발·도착 직선거리: ' + direct);
  assert.ok(plannedM(leg) > direct * 8, '지정 거리가 직선거리보다 훨씬 길어야 합니다');
  // 경유점이 빠지면 TMAP이 659m 최단경로를 돌려준다 — 반드시 남아야 한다.
  assert.deepStrictEqual(Array.from(passList(leg)), raw);
});

test('시흥 ㄹ자 7번 — 출발 직후 서쪽으로 빠지는 경유점도 살아 있다', () => {
  const leg = legOf('시흥-a', 'SH-L-BASE-7');
  assert.strictEqual(passList(leg).length, ROUTES.waypoints[leg.id].length);
});

test('등록된 모든 구간의 경유점이 하나도 버려지지 않는다', () => {
  const dropped = legsWithWaypoints()
    .map(({ key, no, leg }) => {
      const raw = ROUTES.waypoints[leg.id];
      const kept = api.sanitizeWaypoints(leg.sLL, leg.eLL, raw, plannedM(leg)).length;
      return kept < raw.length ? (key + ' ' + no + '번 ' + leg.id + ' ' + raw.length + '→' + kept) : null;
    })
    .filter(Boolean);
  assert.deepStrictEqual(dropped, [], '경유점이 버려진 구간:\n  ' + dropped.join('\n  '));
});

test('경유점을 이은 길이는 구간에 적힌 거리 안에 들어온다 (순서가 맞다는 뜻)', () => {
  const over = legsWithWaypoints()
    .map(({ key, no, leg }) => {
      const ratio = api.waypointPathMeters(leg.sLL, leg.eLL, ROUTES.waypoints[leg.id]) / plannedM(leg);
      return ratio > api.WAYPOINT_PLAN_TOLERANCE ? (key + ' ' + no + '번 ' + leg.id + ' 비율 ' + ratio.toFixed(2)) : null;
    })
    .filter(Boolean);
  assert.deepStrictEqual(over, [], '적힌 거리를 넘는 구간:\n  ' + over.join('\n  '));
});

test('순서가 뒤바뀐 경유점은 여전히 걸러낸다 — 거리 검사를 넘기면 방위 필터가 받는다', () => {
  const leg = legOf('시흥-a', 'SH-L-BASE-04');
  const raw = ROUTES.waypoints[leg.id];
  assert.ok(raw.length >= 2);
  // 도착지 뒤편 멀리에 경유점을 하나 끼워 넣으면 이은 길이가 적힌 거리를 넘는다.
  const far = [leg.eLL[0] + 0.09, leg.eLL[1] + 0.09];
  const broken = [far].concat(raw);
  const ratio = api.waypointPathMeters(leg.sLL, leg.eLL, broken) / plannedM(leg);
  assert.ok(ratio > api.WAYPOINT_PLAN_TOLERANCE, '이 경유점 배치는 거리 검사를 통과해 버립니다: ' + ratio);
  const kept = api.sanitizeWaypoints(leg.sLL, leg.eLL, broken, plannedM(leg));
  assert.ok(kept.length < broken.length, '되돌아가는 경유점이 걸러지지 않았습니다');
});

test('지정 거리가 없으면(0) 예전처럼 방위 필터만으로 판정한다', () => {
  const leg = legOf('시흥-a', 'SH-L-BASE-8');
  const raw = ROUTES.waypoints[leg.id];
  assert.strictEqual(api.sanitizeWaypoints(leg.sLL, leg.eLL, raw, 0).length, 0);
  assert.strictEqual(api.sanitizeWaypoints(leg.sLL, leg.eLL, raw).length, 0);
});

test('빈 목록은 그대로 빈 목록', () => {
  const leg = legOf('시흥-a', 'SH-L-BASE-8');
  assert.deepStrictEqual(Array.from(api.sanitizeWaypoints(leg.sLL, leg.eLL, [], plannedM(leg))), []);
  assert.deepStrictEqual(Array.from(api.sanitizeWaypoints(leg.sLL, leg.eLL, null, plannedM(leg))), []);
});

test('plannedMetersFor — 구간 id 로 적힌 거리를 m 로 찾는다', () => {
  api.setLegs([{ id: 'X-1', dist: 6.6 }, { id: 'X-2' }]);
  assert.strictEqual(api.plannedMetersFor('X-1'), 6600);
  assert.strictEqual(api.plannedMetersFor('X-2'), 0);   // dist 없음 → 방위 필터로 넘어간다
  assert.strictEqual(api.plannedMetersFor('없는-id'), 0);
  api.setLegs([]);
});

test('경유점을 이은 길이 계산 — 출발·경유점·도착을 순서대로 더한다', () => {
  const s = [37.0, 127.0], w = [37.01, 127.0], e = [37.02, 127.0];
  const direct = api.haversine(s[0], s[1], e[0], e[1]);
  assert.ok(Math.abs(api.waypointPathMeters(s, e, [w]) - direct) < 1, '일직선이면 직선거리와 같다');
  // 밖으로 나갔다 돌아오면 직선거리보다 훨씬 길어진다
  const out = [37.05, 127.05];
  assert.ok(api.waypointPathMeters(s, e, [out]) > direct * 3);
});

test('실제 앱 호출부 — 경로 요청과 미리보기 모두 지정 거리를 넘긴다', () => {
  const body = extractFunction('fetchTmapRoute');
  assert.match(body, /sanitizeWaypoints\(sLL, eLL, raw, plannedMetersFor\(legId\)\)/);
  // 경유점이 걸러지면 화면에 알린다 (조용히 엉뚱한 노선으로 가지 않게)
  assert.match(body, /safe\.length < raw\.length/);
  assert.match(extractFunction('fetchLegCoords'),
    /sanitizeWaypoints\(leg\.sLL, leg\.eLL, raw, \(Number\(leg\.dist\) \|\| 0\) \* 1000\)/);
  // 편집 화면의 🧹 자동 정리 버튼은 사용자가 직접 누른 것이므로 거리 검사 없이 필터를 돌린다
  assert.match(extractFunction('autoFixEditWaypoints'), /sanitizeWaypoints\(editSLL, editELL, editWps\)/);
});
