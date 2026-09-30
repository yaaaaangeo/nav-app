/*
 * 다음 구간 미리보기 — 구간 끝 100 m 안에서 다음 구간 경로를 미리 그린다
 * 실행: node --test tests/*.test.js
 *
 * 노리는 것 두 가지
 *   ① 기사가 다음에 갈 길을 100 m 전에 본다
 *   ② 구간이 넘어갈 때 clearRoute() 로 경로가 비는 공백을 이 선이 메운다
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ROUTES = JSON.parse(fs.readFileSync(path.join(ROOT, 'routes.json'), 'utf8'));

/** `async` 까지 포함해 함수 소스를 잘라 온다 (async 를 빼면 안의 await 가 문법 오류가 된다) */
function extractFunction(name){
  const m = HTML.match(new RegExp('(async\\s+)?function ' + name + '\\s*\\('));
  assert.ok(m, name + ' 함수를 찾지 못했습니다');
  const start = m.index;
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

const FUNCS = ['haversine', 'cloneLatLngList', 'cloneRouteSteps', 'normalizeFixedRoute',
  'isActionable', 'firstActionableStep', 'turnPhrase',
  'showNextTurnBanner', 'hideNextTurnBanner', 'announceNextLeg',
  'clearNextRoutePreview', 'drawNextRoutePreview', 'maybePreviewNextRoute'];
const CONSTS = ['NEXT_ROUTE_PREVIEW_M', 'NEXT_ROUTE_COLOR'];

/** 가짜 지도 위에서 미리보기 함수만 돌리는 샌드박스 */
function makeApp(opts){
  opts = opts || {};
  const drawn = [], removed = [], fetched = [];
  const src = `
    ${CONSTS.map(extractConst).join('\n')}
    let legs = __legs, legIdx = __legIdx, editMode = __editMode;
    let nextLine = null, nextPreviewFor = null;
    const map = __map;
    const FIXED_ROUTES = __fixed;
    function currentSector(){ return __sector; }
    const spoken = [];
    function speak(t){ spoken.push(t); }
    let nextPreviewStep = null;
    // 가짜 DOM — 턴 카드 요소만 흉내 낸다
    const els = {};
    function $(id){
      return els[id] || (els[id] = {
        textContent: '',
        classList: {
          set: new Set(),
          add(c){ this.set.add(c); }, remove(c){ this.set.delete(c); },
          contains(c){ return this.set.has(c); },
          toggle(c, on){ (on === undefined ? !this.set.has(c) : on) ? this.set.add(c) : this.set.delete(c); },
        },
      });
    }
    function showTurn(on){ $('turn-overlay').classList.toggle('on', on); }
    function LL(lat, lng){ return { _lat: lat, _lng: lng }; }
    const Tmapv3 = { Polyline: function(o){
      this.o = o; __drawn.push(o);
      this.setMap = function(m){ if (m === null) __removed.push(o); };
    } };
    async function fetchLegCoords(leg){
      __fetched.push(leg.id);
      if (__fetchFails) throw new Error('HTTP 500');
      return __liveCoords;
    }
    ${FUNCS.map(extractFunction).join('\n')}
    this.api = {
      maybePreviewNextRoute, clearNextRoutePreview, drawNextRoutePreview,
      firstActionableStep, turnPhrase, spoken,
      showNextTurnBanner, hideNextTurnBanner,
      get bannerOn(){ return $('turn-next').classList.contains('on'); },
      get bannerText(){ return $('turn-next-text').textContent; },
      get cardOn(){ return $('turn-overlay').classList.contains('on'); },
      NEXT_ROUTE_PREVIEW_M, NEXT_ROUTE_COLOR,
      get previewStep(){ return nextPreviewStep; },
      get hasLine(){ return !!nextLine; },
      get previewFor(){ return nextPreviewFor; },
      set legIdx(v){ legIdx = v; },
      get legIdx(){ return legIdx; },
      resetMark(){ nextPreviewFor = null; },
    };
  `;
  const ctx = {
    __legs: opts.legs || [{ id: 'A' }, { id: 'B' }],
    __legIdx: opts.legIdx || 0,
    __editMode: !!opts.editMode,
    __map: opts.noMap ? null : { _map: true },
    __fixed: opts.fixed || {},
    __sector: opts.sector || null,
    __drawn: drawn, __removed: removed, __fetched: fetched,
    __fetchFails: !!opts.fetchFails,
    __liveCoords: opts.liveCoords || [[37.5, 127.0], [37.51, 127.01], [37.52, 127.02]],
    Math, Number, Array, isFinite, String, Object, Promise,
  };
  ctx.TURN_TYPE = {};
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return Object.assign(ctx.api, { drawn, removed, fetched });
}

const fixedRoute = coords => ({ coords, steps: [], totalM: 0, totalSec: 0 });

test('미리보기 거리는 100 m — 자동 전환 기준과 같다', () => {
  assert.strictEqual(makeApp().NEXT_ROUTE_PREVIEW_M, 100);
  const m = HTML.match(/const AUTO_LEG_SWITCH_DISTANCE_M\s*=\s*(\d+)/);
  assert.strictEqual(Number(m[1]), 100);
});

test('101 m 에서는 안 그리고, 100 m 에서 그린다', async () => {
  const app = makeApp({ fixed: { B: fixedRoute([[37.5, 127.0], [37.51, 127.01]]) } });
  await app.maybePreviewNextRoute(101);
  assert.strictEqual(app.hasLine, false);
  assert.strictEqual(app.drawn.length, 0);
  await app.maybePreviewNextRoute(100);
  assert.strictEqual(app.hasLine, true);
  assert.strictEqual(app.drawn.length, 1);
});

test('고정경로가 있으면 네트워크 없이 바로 그린다', async () => {
  const app = makeApp({ fixed: { B: fixedRoute([[37.5, 127.0], [37.51, 127.01]]) } });
  await app.maybePreviewNextRoute(80);
  assert.deepStrictEqual(Array.from(app.fetched), [], 'TMAP을 부르면 안 됩니다');
  assert.strictEqual(app.drawn.length, 1);
  assert.strictEqual(app.drawn[0].strokeColor, app.NEXT_ROUTE_COLOR);
  assert.strictEqual(app.drawn[0].path.length, 2);
});

test('고정경로가 없으면 받아서 그린다', async () => {
  const app = makeApp();
  await app.maybePreviewNextRoute(50);
  assert.deepStrictEqual(Array.from(app.fetched), ['B']);
  assert.strictEqual(app.hasLine, true);
  assert.strictEqual(app.drawn[0].path.length, 3);
});

test('한 구간에서 여러 번 측위가 와도 한 번만 요청한다', async () => {
  const app = makeApp();
  for (let i = 0; i < 20; i++) await app.maybePreviewNextRoute(90 - i);
  assert.strictEqual(app.fetched.length, 1);
  assert.strictEqual(app.drawn.length, 1);
});

test('마지막 구간에서는 미리보기가 없다', async () => {
  const app = makeApp({ legIdx: 1 });   // legs = [A, B] 중 마지막
  await app.maybePreviewNextRoute(10);
  assert.strictEqual(app.hasLine, false);
  assert.deepStrictEqual(Array.from(app.fetched), []);
  assert.strictEqual(app.previewFor, null, '마지막 구간에서는 표시도 남기지 않는다');
});

test('편집 중 · 구역 주행 · 지도 없을 때는 아무것도 안 한다', async () => {
  for (const opts of [{ editMode: true }, { sector: { name: '구역' } }, { noMap: true }]){
    const app = makeApp(opts);
    await app.maybePreviewNextRoute(10);
    assert.strictEqual(app.hasLine, false, JSON.stringify(Object.keys(opts)));
    assert.deepStrictEqual(Array.from(app.fetched), []);
  }
});

test('미리보기 요청이 실패해도 주행에 영향이 없다', async () => {
  const app = makeApp({ fetchFails: true });
  await app.maybePreviewNextRoute(40);      // throw 가 밖으로 새면 이 줄에서 실패한다
  assert.strictEqual(app.hasLine, false);
});

test('받아오는 동안 구간이 넘어가면 낡은 선을 그리지 않는다', async () => {
  const app = makeApp();
  const p = app.maybePreviewNextRoute(40);
  app.legIdx = 1;                           // 그 사이 자동 전환
  await p;
  assert.strictEqual(app.hasLine, false, '실제 경로가 그려질 자리에 낡은 미리보기를 덮으면 안 됩니다');
});

test('좌표가 1개 이하면 그리지 않는다', () => {
  const app = makeApp();
  app.drawNextRoutePreview([[37.5, 127.0]]);
  app.drawNextRoutePreview([]);
  app.drawNextRoutePreview(null);
  assert.strictEqual(app.hasLine, false);
});

test('지우면 선이 지도에서 내려간다', async () => {
  const app = makeApp({ fixed: { B: fixedRoute([[37.5, 127.0], [37.51, 127.01]]) } });
  await app.maybePreviewNextRoute(50);
  app.clearNextRoutePreview();
  assert.strictEqual(app.hasLine, false);
  assert.strictEqual(app.removed.length, 1);
});

/* ── 100m 전 첫 회전 예고 (기사가 직진해 버리는 것을 막는 핵심) ── */

/** 첫 회전이 turnM 앞에 있는 고정경로 */
const routeWithTurn = (turnM, label, road, turnType) => ({
  coords: [[37.5, 127.0], [37.51, 127.01]],
  steps: [{ lat: 37.5, lng: 127.0, turnType: turnType == null ? 12 : turnType,
            icon: '>', label: label, road: road || '', desc: '', atMeters: turnM }],
  totalM: 0, totalSec: 0,
});

test('100m 전에 다음 구간 첫 회전을 방향까지 말한다', async () => {
  const app = makeApp({ fixed: { B: routeWithTurn(12, '우회전', '압구정로') } });
  await app.maybePreviewNextRoute(100);
  assert.deepStrictEqual(Array.from(app.spoken),
    ['100미터 앞 구간 종료 — 이어서 압구정로 방면 우회전입니다']);
});

test('도로명이 없으면 회전만 말한다', async () => {
  const app = makeApp({ fixed: { B: routeWithTurn(30, '유턴', '') } });
  await app.maybePreviewNextRoute(90);
  assert.deepStrictEqual(Array.from(app.spoken), ['100미터 앞 구간 종료 — 이어서 유턴입니다']);
});

test('고정경로가 없으면 방향 없이 예고만 한다 (판교·시흥)', async () => {
  const app = makeApp();                       // FIXED_ROUTES 비어 있음
  await app.maybePreviewNextRoute(80);
  assert.deepStrictEqual(Array.from(app.spoken), ['잠시 후 구간 종료입니다']);
});

test('다음 구간 첫 안내가 목적지뿐이면 방향을 꾸며내지 않는다', async () => {
  const app = makeApp({ fixed: { B: routeWithTurn(500, '목적지 도착', '', 201) } });
  await app.maybePreviewNextRoute(70);
  assert.deepStrictEqual(Array.from(app.spoken), ['잠시 후 구간 종료입니다']);
});

test('예고는 구간마다 한 번만 — 측위가 계속 와도 반복하지 않는다', async () => {
  const app = makeApp({ fixed: { B: routeWithTurn(12, '우회전', '압구정로') } });
  for (let i = 0; i < 30; i++) await app.maybePreviewNextRoute(95 - i);
  assert.strictEqual(app.spoken.length, 1);
});

test('예고한 첫 회전을 턴 카드용으로 담아 둔다 (전환 직후 화면 공백 방지)', async () => {
  const app = makeApp({ fixed: { B: routeWithTurn(12, '우회전', '압구정로') } });
  await app.maybePreviewNextRoute(100);
  assert.ok(app.previewStep, '담아 둔 첫 회전이 없습니다');
  assert.strictEqual(app.previewStep.legId, 'B');
  assert.strictEqual(app.previewStep.step.label, '우회전');
  assert.strictEqual(app.previewStep.step.atMeters, 12);
});

test('음성만이 아니라 글씨로도 보인다 — 턴 카드에 "다음 구간 ▸ …"', async () => {
  const app = makeApp({ fixed: { B: routeWithTurn(12, '우회전', '압구정로') } });
  assert.strictEqual(app.bannerOn, false, '평소엔 숨어 있어야 한다');
  await app.maybePreviewNextRoute(100);
  assert.strictEqual(app.bannerOn, true);
  assert.strictEqual(app.bannerText, ' ▸ 압구정로 방면 우회전');
  assert.strictEqual(app.cardOn, true, '카드가 닫혀 있으면 글씨가 안 보인다');
});

test('고정경로가 없어 방향을 모르면 다음 구간 이름이라도 보여 준다', async () => {
  const app = makeApp({ legs: [{ id: 'A' }, { id: 'B', e: '봉은사역' }] });
  await app.maybePreviewNextRoute(80);
  assert.strictEqual(app.bannerText, ' ▸ 봉은사역 방면');
  assert.deepStrictEqual(Array.from(app.spoken), ['잠시 후 구간 종료입니다']);
});

test('예고 글씨를 내리면 텍스트도 비운다', async () => {
  const app = makeApp({ fixed: { B: routeWithTurn(12, '우회전', '압구정로') } });
  await app.maybePreviewNextRoute(60);
  app.hideNextTurnBanner();
  assert.strictEqual(app.bannerOn, false);
  assert.strictEqual(app.bannerText, '');
});

test('turnPhrase — 도로명 유무와 목적지 처리', () => {
  const app = makeApp();
  assert.strictEqual(app.turnPhrase({ label: '우회전', road: '압구정로', turnType: 12 }), '압구정로 방면 우회전');
  assert.strictEqual(app.turnPhrase({ label: '유턴', road: '', turnType: 14 }), '유턴');
  assert.strictEqual(app.turnPhrase({ label: '목적지 도착', road: '', turnType: 201 }), '');
  assert.strictEqual(app.turnPhrase(null), '');
});

/* ── 앱 배선 확인 — 소스에서 직접 본다 ── */

test('도착 문구 — 중간 구간은 구간 완료 + 다음 회전, 마지막만 목적지', () => {
  const body = extractFunction('checkArrival');
  assert.match(body, /legIdx >= legs\.length - 1/);
  assert.match(body, /목적지에 도착했습니다/);
  assert.match(body, /구간 완료 — 이어서/);
  assert.match(body, /turnPhrase\(firstActionableStep\(legs\[legIdx \+ 1\]\)\)/);
});

test('전환 직후 턴 카드를 미리보기 첫 회전으로 채운다', () => {
  const body = extractFunction('applyLeg');
  assert.match(body, /nextPreviewStep && nextPreviewStep\.legId === leg\.id/);
  assert.match(body, /showTurnPreview\(nextPreviewStep\.step\)/);
  assert.match(body, /nextPreviewStep = null/);
  // showTurnPreview 는 refreshGuidance 와 같은 카드 요소를 채운다
  const card = extractFunction('showTurnPreview');
  ['turn-icon', 'turn-num', 'turn-unit', 'turn-text', 'turn-road'].forEach(id =>
    assert.ok(card.includes("$('" + id + "')"), id + ' 을 채우지 않습니다'));
  assert.ok(card.includes('showTurn(true)'));
});

test('예고 줄 배선 — 마크업·CSS·숨김 지점', () => {
  assert.ok(HTML.includes('id="turn-next"'), '예고 줄 요소가 없습니다');
  assert.ok(HTML.includes('id="turn-next-text"'));
  assert.match(HTML, /#turn-next\{[^}]*display:none/, '평소엔 숨어 있어야 합니다');
  assert.match(HTML, /#turn-next\.on\{display:block;\}/);
  // 전환되면 카드 본문으로 올라가므로 예고 줄은 내린다
  assert.ok(extractFunction('applyLeg').includes('hideNextTurnBanner()'));
  // 안내 지점이 없어도 예고 줄이 떠 있으면 카드를 닫지 않는다
  assert.ok(extractFunction('refreshGuidance').includes("$('turn-next').classList.contains('on')"));
  assert.ok(extractFunction('applySector').includes('hideNextTurnBanner()'));
});

test('강남 42구간 — 첫 회전이 100m 안인 구간도 100m 전에 방향을 듣는다', () => {
  // 예고가 고정경로의 steps 에서 나오므로, 첫 회전이 12m 앞이어도 100m 전에 말할 수 있다
  const app = makeApp();
  let near = 0, announced = 0;
  for (const key of ['강남-a', '강남-b', '강남-c', '강남-d']){
    (ROUTES.customLegs[key] || []).forEach(leg => {
      const f = ROUTES.fixedRoutes[leg.id];
      if (!f) return;
      const first = (f.steps || []).find(st => st.turnType !== 200 && st.turnType !== 201);
      if (!first || first.atMeters >= 100) return;
      near++;
      if (app.turnPhrase(first)) announced++;
    });
  }
  assert.ok(near >= 5, '첫 회전이 100m 안인 구간이 ' + near + '개');
  assert.strictEqual(announced, near, '방향을 말할 수 없는 구간이 있습니다');
});

test('checkArrival 이 남은거리로 미리보기를 부른다', () => {
  assert.match(extractFunction('checkArrival'), /maybePreviewNextRoute\(remainingM\)/);
});

test('실제 경로가 그려질 때 미리보기 선을 지운다', () => {
  // drawRouteLines 는 TMAP 성공·고정경로·직선 대체 세 경로 모두에서 불린다
  assert.match(extractFunction('drawRouteLines'), /clearNextRoutePreview\(\)/);
  assert.match(extractFunction('applyFixedRoute'), /drawRouteLines\(\)/);
  assert.match(extractFunction('fallbackRoute'), /drawRouteLines\(\)/);
});

test('구간이 바뀔 때 표시만 지우고 그려 둔 선은 남긴다 (지도 공백 방지)', () => {
  const body = extractFunction('applyLeg');
  assert.match(body, /nextPreviewFor = null/);
  assert.doesNotMatch(body, /clearNextRoutePreview/,
    'applyLeg 에서 선을 지우면 새 경로가 오기까지 지도가 빈다');
  // clearRoute 도 선을 건드리면 안 된다 (fetchTmapRoute 가 요청 전에 부른다)
  assert.doesNotMatch(extractFunction('clearRoute'), /clearNextRoutePreview/);
  assert.doesNotMatch(extractFunction('clearMapLayers'), /clearNextRoutePreview/);
});

test('구역 주행·전체 보기로 넘어갈 때는 미리보기를 지운다', () => {
  assert.match(extractFunction('applySector'), /clearNextRoutePreview\(\)/);
  assert.match(HTML.slice(HTML.indexOf('overviewOn = true')), /clearNextRoutePreview\(\)/);
});

test('강남 42구간은 다음 구간 미리보기가 네트워크 없이 뜬다', () => {
  // 고정경로가 다 있으므로 미리보기도 즉시 그려진다
  const missing = [];
  for (const key of ['강남-a', '강남-b', '강남-c', '강남-d']){
    (ROUTES.customLegs[key] || []).forEach((leg, i, arr) => {
      if (i === arr.length - 1) return;             // 마지막 구간은 다음이 없다
      const next = arr[i + 1];
      if (!(ROUTES.fixedRoutes || {})[next.id]) missing.push(key + ' ' + (i + 2) + '번 ' + next.id);
    });
  }
  assert.deepStrictEqual(missing, [], '고정경로가 없어 미리보기에 네트워크가 필요한 구간:\n  ' + missing.join('\n  '));
});
