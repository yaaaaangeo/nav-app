/*
 * 사전 음성 안내 거리(500 / 200 / 100 / 50 m) 테스트
 * 실행: node --test tests/*.test.js
 *
 * index.html 안의 실제 refreshGuidance 소스를 잘라 와서 가짜 DOM·상태 위에서 돌린다.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

const FUNCS  = ['fmtDist', 'refreshGuidance', 'showTurn'];
const CONSTS = ['OFF_ROUTE_DISTANCE_M', 'GUIDE_ANNOUNCE_M', 'GUIDE_SOON_M'];

const OFF_ROUTE_OVER = 10000;   // OFF_ROUTE_DISTANCE_M 보다 확실히 큰 이탈 거리

/** vm 안에서 만들어진 배열은 프로토타입이 달라 deepStrictEqual 을 통과하지 못한다 — 바깥 배열로 옮긴다 */
const said = (app, prefix) =>
  Array.from(app.spoken).filter(t => !prefix || t.startsWith(prefix));

/** 안내 지점을 두고 남은 거리를 좁혀 가는 샌드박스 */
function makeApp(steps){
  const elements = {};
  const el = id => elements[id] || (elements[id] = {
    textContent: '',
    classList: {
      set: new Set(),
      toggle(c, on){ (on === undefined ? !this.set.has(c) : on) ? this.set.add(c) : this.set.delete(c); },
      contains(c){ return this.set.has(c); },
    },
  });
  const src = `
    ${CONSTS.map(extractConst).join('\n')}
    let routeSteps = __steps, curStepIdx = 0, progressM = 0;
    let announced = {}, isPlaying = true, progressInit = true;
    function nearestIndex(){}
    nearestIndex.lastDistance = 0;
    const spoken = [];
    function speak(t){ spoken.push(t); }
    function renderStepsList(){}
    function $(id){ return __el(id); }
    ${FUNCS.map(extractFunction).join('\n')}
    this.api = {
      spoken,
      get curStepIdx(){ return curStepIdx; },
      /** 차를 경로 m 지점까지 옮기고 안내를 갱신한다 */
      driveTo(m){ progressM = m; refreshGuidance(); },
      setOffRouteDistance(d){ nearestIndex.lastDistance = d; },
      set isPlaying(v){ isPlaying = v; },
    };
  `;
  const ctx = { __steps: steps, __el: el, Math, Number, Set, isFinite };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return Object.assign(ctx.api, { el });
}

/** 좌회전 안내 지점 하나가 1000 m 지점에 있는 경로 */
const turnAt1000 = () => [{
  lat: 37.5, lng: 127.0, turnType: 12, label: '좌회전', icon: '↰',
  road: '테헤란로', desc: '', atMeters: 1000,
}];

test('500 · 200 · 100 · 50 m 네 번 모두 안내한다', () => {
  const app = makeApp(turnAt1000());
  for (let m = 0; m <= 980; m += 10) app.driveTo(m);   // 10 m 씩 접근
  assert.deepStrictEqual(said(app), [
    '500미터 앞 테헤란로 방면 좌회전',
    '200미터 앞 테헤란로 방면 좌회전',
    '100미터 앞 테헤란로 방면 좌회전',
    '50미터 앞 테헤란로 방면 좌회전',
  ]);
});

test('100 m 안내는 남은 거리가 100 m 이하로 떨어질 때 나온다', () => {
  const app = makeApp(turnAt1000());
  app.driveTo(1000 - 101);                     // 남은 101 m — 아직 아니다
  assert.ok(!app.spoken.some(t => t.startsWith('100미터')));
  app.driveTo(1000 - 100);                     // 남은 100 m — 여기서 발화
  assert.ok(app.spoken.includes('100미터 앞 테헤란로 방면 좌회전'));
});

test('같은 안내 지점에서 100 m 안내를 두 번 하지 않는다', () => {
  const app = makeApp(turnAt1000());
  for (let m = 890; m <= 945; m += 5) app.driveTo(m);   // 남은 110 → 55 m 를 촘촘히
  assert.strictEqual(said(app, '100미터').length, 1);
});

test('신호가 끊겨 100 m 안으로 건너뛰면 500·200 m 는 건너뛰고 100 m 만 말한다', () => {
  const app = makeApp(turnAt1000());
  app.driveTo(910);                            // 남은 90 m 로 한 번에 점프
  assert.deepStrictEqual(said(app), ['100미터 앞 테헤란로 방면 좌회전']);
  app.driveTo(960);                            // 남은 40 m — 거리를 말하지 않고 "곧"
  assert.deepStrictEqual(said(app), [
    '100미터 앞 테헤란로 방면 좌회전',
    '곧 테헤란로 방면 좌회전',
  ]);
});

test('회전 지점에 붙어 있으면 거리를 말하지 않고 "곧"이라고 한다', () => {
  // 구간이 넘어간 직후 첫 회전이 12 m 앞인 경우 — "50미터 앞"은 거짓이다
  const app = makeApp([{
    lat: 37.5, lng: 127.0, turnType: 12, label: '우회전', icon: '→',
    road: '압구정로', desc: '', atMeters: 1000,
  }]);
  app.driveTo(1000 - 12);
  assert.deepStrictEqual(said(app), ['곧 압구정로 방면 우회전']);
});

test('GUIDE_SOON_M(40m)보다 멀면 임계값 거리를 말한다', () => {
  const app = makeApp(turnAt1000());
  app.driveTo(1000 - 41);                      // 남은 41 m — 아직 "곧"이 아니다
  assert.deepStrictEqual(said(app), ['50미터 앞 테헤란로 방면 좌회전']);
});

test('목적지도 가까우면 "곧 목적지입니다"', () => {
  const app = makeApp([{
    lat: 37.5, lng: 127.0, turnType: 201, label: '목적지', icon: 'F',
    road: '', desc: '', atMeters: 1000,
  }]);
  app.driveTo(1000 - 20);
  assert.deepStrictEqual(said(app), ['곧 목적지입니다']);
});

test('목적지(turnType 201)는 100 m 에서도 목적지 문구로 말한다', () => {
  const app = makeApp([{
    lat: 37.5, lng: 127.0, turnType: 201, label: '목적지', icon: '🏁',
    road: '', desc: '', atMeters: 1000,
  }]);
  app.driveTo(1000 - 100);
  assert.deepStrictEqual(said(app), ['100미터 앞 목적지입니다']);
});

test('경로를 벗어난 상태에서는 100 m 안내를 하지 않는다', () => {
  const app = makeApp(turnAt1000());
  app.setOffRouteDistance(OFF_ROUTE_OVER);
  app.driveTo(1000 - 100);
  assert.deepStrictEqual(said(app), []);
});

test('일시정지 중에는 100 m 안내를 하지 않는다', () => {
  const app = makeApp(turnAt1000());
  app.isPlaying = false;
  app.driveTo(1000 - 100);
  assert.deepStrictEqual(said(app), []);
});

test('다음 안내 지점에서도 100 m 안내가 다시 나온다', () => {
  const app = makeApp([
    { lat: 37.5, lng: 127.0, turnType: 12, label: '좌회전', icon: '↰', road: 'A로', desc: '', atMeters: 1000 },
    { lat: 37.6, lng: 127.1, turnType: 13, label: '우회전', icon: '↱', road: 'B로', desc: '', atMeters: 2000 },
  ]);
  for (let m = 0; m <= 1980; m += 10) app.driveTo(m);
  assert.strictEqual(app.curStepIdx, 1);
  assert.deepStrictEqual(said(app, '100미터'), [
    '100미터 앞 A로 방면 좌회전',
    '100미터 앞 B로 방면 우회전',
  ]);
});

test('화면 남은 거리 표시는 100 m 추가와 무관하게 그대로다', () => {
  const app = makeApp(turnAt1000());
  app.driveTo(1000 - 100);
  assert.strictEqual(app.el('turn-num').textContent, '100');
  assert.strictEqual(app.el('turn-unit').textContent, ' m 앞');
  assert.strictEqual(app.el('turn-text').textContent, '좌회전');
  assert.strictEqual(app.el('turn-road').textContent, '테헤란로');
});

test('연속된 턴이 500 m 안에 붙어 있어도 실제 거리로 안내한다', () => {
  const app = makeApp([
    { lat: 37.5, lng: 127.0, turnType: 12, label: '좌회전', icon: '↰', road: 'A로', desc: '', atMeters: 1000 },
    { lat: 37.6, lng: 127.1, turnType: 13, label: '우회전', icon: '↱', road: 'B로', desc: '', atMeters: 1200 },
  ]);
  for (let m = 0; m <= 1180; m += 10) app.driveTo(m);
  // 두 번째 턴은 처음 현재 지점이 될 때 이미 200 m 안이다 — "500미터 앞" 이라고 말하면 안 된다.
  assert.deepStrictEqual(said(app).filter(t => t.includes('B로')), [
    '200미터 앞 B로 방면 우회전',
    '100미터 앞 B로 방면 우회전',
    '50미터 앞 B로 방면 우회전',
  ]);
});

test('GUIDE_ANNOUNCE_M 은 100 을 포함한 내림차순이어야 한다 (루프가 뒤에서부터 검사한다)', () => {
  const m = HTML.match(/const GUIDE_ANNOUNCE_M\s*=\s*\[([^\]]+)\]/);
  const arr = m[1].split(',').map(s => Number(s.trim()));
  assert.deepStrictEqual(arr, [500, 200, 100, 50]);
  for (let i = 1; i < arr.length; i++) assert.ok(arr[i] < arr[i - 1], '내림차순이 아닙니다');
});
