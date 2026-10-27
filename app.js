import { ADE_SIDEWALK, ADE_OBSTACLE, PARAMS, grade, effectiveRatio, assistedRatio } from './rule.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), photo: $('photo'), overlay: $('overlay'), busy: $('busy'), busyText: $('busy-text'),
  busyBar: $('busy-bar'), retry: $('retry'), paint: $('t-paint'), erase: $('t-erase'), clear: $('t-clear'),
  hint: $('hint'), examples: $('examples'), file: $('file'), swap: $('t-swap'), pick: $('pick'),
  num: $('r-num'), pct: $('r-pct'), grade: $('r-grade'),
  form: $('req'), place: $('f-place'), when: $('f-when'), memo: $('f-memo'), err: $('f-err'),
  sheetWrap: $('sheet-wrap'), sheet: $('sheet'), basis: $('basis'), actMsg: $('act-msg'),
};

// 화면 문구(명사구로 끝낸다)
const T = {
  hintPaint: '지나갈 보도 칠하기, 막은 차와 짐까지 함께',
  hintExample: '미리 칠해 둔 예시 구간, 지우고 다시 칠하기 가능',
  hintNoSidewalk: '보도 인식 부족. 보도가 화면 아래쪽에 오게 다시 촬영하거나 보도 직접 칠하기',
  hintSmall: '칠한 보도 부족. 막힌 곳 앞뒤 보도까지 넓게 칠하기',
  before: '칠하기 전', unknown: '판정 불가', working: '보도 찾는 중', failed: '분석 실패',
  busyPrep: '분석 준비 중', busyFind: '보도 찾는 중',
  failModel: '분석 실패. 연결 상태 확인 후 다시 시도, 예시 사진은 계속 사용 가능',
  failPhoto: '사진 열기 실패. JPG나 PNG 사진 선택',
  failMeta: '화면 자료 불러오기 실패. 새로고침 필요',
  errPaint: '지나갈 보도 칠하기 필요', errPlace: '위치 입력 필요. 도로명, 건물명, 가까운 정류장 등',
  copied: '요청 문구 복사 완료', copyBlocked: '복사 차단. 미리보기 글을 길게 눌러 복사',
  saved: '표시 사진 저장 완료',
  legend: '노랑 통행 가능 / 빗금 막힘 / 점선 보도 후보',
};
let baseHint = T.hintPaint;
function setHint(text) { els.hint.textContent = text; }

const IS_OBS = new Uint8Array(256);
for (const c of ADE_OBSTACLE) IS_OBS[c] = 1;

const state = {
  meta: null, source: null, example: null,
  lab: null, W: 0, H: 0,           // 작업 해상도 라벨 지도
  photoCanvas: null,               // 화면에 띄운 사진(긴 변 960 이하)
  region: null,                    // 작업 해상도 칠하기 캔버스
  tool: null, result: null, autoS: 0, lastMs: null,
};

// ---------- 공통 ----------
function fmt(v, d = 3) { return Number(v).toFixed(d).replace(/0+$/, '').replace(/\.$/, ''); }
function nowLocal() {
  const d = new Date(); d.setSeconds(0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function loadImage(src) {
  return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = src; });
}
function nextFrame() { return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }

// ---------- 사진·라벨 ----------
function setPhotoCanvas(cv) {
  state.photoCanvas = cv;
  els.photo.width = cv.width; els.photo.height = cv.height;
}

async function showExample(ex) {
  state.source = 'example'; state.example = ex;
  busy(false);
  for (const b of els.examples.querySelectorAll('.ex')) b.setAttribute('aria-pressed', String(b.dataset.id === ex.id));
  const [im, labIm] = await Promise.all([loadImage(ex.photo), loadImage(ex.labels)]);
  const cv = document.createElement('canvas'); cv.width = im.naturalWidth; cv.height = im.naturalHeight;
  cv.getContext('2d').drawImage(im, 0, 0);
  setPhotoCanvas(cv);
  els.photo.src = ex.photo; els.photo.alt = `${ex.place} 보도 사진`;
  const [W, H] = ex.work;
  const lc = document.createElement('canvas'); lc.width = W; lc.height = H;
  const lctx = lc.getContext('2d', { willReadFrequently: true });
  lctx.drawImage(labIm, 0, 0);
  const px = lctx.getImageData(0, 0, W, H).data;
  const lab = new Uint8Array(W * H);
  for (let i = 0; i < lab.length; i++) lab[i] = px[i * 4];
  setLabels(lab, W, H);
  drawPolygon(ex.region);
  setTool(null);
  baseHint = T.hintExample;
  recompute();
  if (state.meta) renderBasis();
}

function setLabels(lab, W, H) {
  state.lab = lab; state.W = W; state.H = H;
  els.overlay.width = W; els.overlay.height = H;
  const rc = document.createElement('canvas'); rc.width = W; rc.height = H;
  rc.getContext('2d', { willReadFrequently: true });
  state.region = rc;
  const auto = effectiveRatio(lab, W, H);
  state.autoS = auto.S;
}

function drawPolygon(poly) {
  const ctx = state.region.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x * state.W, y * state.H));
  ctx.closePath(); ctx.fill();
}

function regionMask() {
  const { W, H } = state;
  const a = state.region.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  let n = 0;
  for (let i = 0; i < m.length; i++) if (a[i * 4 + 3] > 0) { m[i] = 1; n++; }
  return { m, n };
}

// ---------- 계산·그리기 ----------
let pending = false;
function recompute() {
  if (pending) return; pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const { lab, W, H } = state;
    if (!lab) return;
    const { m, n } = regionMask();
    const res = n ? assistedRatio(lab, W, H, m) : null;
    state.result = res ? { ratio: res.ratio, grade: grade(res.ratio), painted: n } : { ratio: null, grade: null, painted: 0 };
    drawOverlay(m, res ? res.bMask : null);
    renderResult();
  });
}

function drawOverlay(m, bMask) {
  const { lab, W, H } = state;
  const ctx = els.overlay.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const SW = ADE_SIDEWALK;
  // 보도 후보의 가장자리: 반경 3 안에 보도가 아닌 화소가 있는 보도 화소(사진 테두리는 가장자리로 보지 않는다)
  const edge = (x, y) => {
    for (let dy = -3; dy <= 3; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= H) continue;
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= W) continue;
        if (lab[yy * W + xx] !== SW) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    if (m[i]) {
      if (bMask && bMask[i]) {
        // 막은 것: 아스팔트색 사선 빗금, 빗금 사이는 사진 그대로
        const k = (x + y) % 8;
        if (k < 3) { d[o] = 36; d[o + 1] = 39; d[o + 2] = 43; d[o + 3] = 230; }
        else if (k === 3) { d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = 150; }
        else d[o + 3] = 0;
      } else { d[o] = 242; d[o + 1] = 194; d[o + 2] = 0; d[o + 3] = 120; }
    } else if (lab[i] === SW && ((((x / 7) | 0) + ((y / 7) | 0)) & 1) && edge(x, y)) {
      d[o] = 242; d[o + 1] = 194; d[o + 2] = 0; d[o + 3] = 255;
    } else { d[o + 3] = 0; }
  }
  ctx.putImageData(img, 0, 0);
}

function renderResult() {
  const r = state.result;
  if (!r || r.ratio === null) {
    els.num.textContent = ''; els.pct.hidden = true; els.grade.dataset.g = '';
    els.grade.textContent = r && r.painted ? T.unknown : T.before;
    if (state.autoS < PARAMS.MIN_AREA_FRAC * state.W * state.H) setHint(T.hintNoSidewalk);
    else setHint(r && r.painted ? T.hintSmall : baseHint);
    return;
  }
  els.num.textContent = String(Math.floor(r.ratio)); els.pct.hidden = false;
  els.grade.textContent = r.grade; els.grade.dataset.g = r.grade;
  setHint(baseHint);
}

// ---------- 칠하기 ----------
function setTool(t) {
  state.tool = t;
  els.paint.setAttribute('aria-pressed', String(t === 'paint'));
  els.erase.setAttribute('aria-pressed', String(t === 'erase'));
  els.stage.classList.toggle('painting', !!t);
  if (t) { baseHint = T.hintPaint; if (state.result && state.result.ratio !== null) setHint(baseHint); }
}
els.paint.addEventListener('click', () => setTool(state.tool === 'paint' ? null : 'paint'));
els.erase.addEventListener('click', () => setTool(state.tool === 'erase' ? null : 'erase'));
els.clear.addEventListener('click', () => {
  if (!state.region) return;
  state.region.getContext('2d').clearRect(0, 0, state.W, state.H);
  setTool('paint');
  recompute();
});
els.swap.addEventListener('click', () => {
  const open = els.pick.hidden;
  els.pick.hidden = !open;
  els.swap.setAttribute('aria-expanded', String(open));
});

let last = null;
function toWorkXY(e) {
  const r = els.overlay.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * state.W, (e.clientY - r.top) / r.height * state.H];
}
function stroke(a, b) {
  const ctx = state.region.getContext('2d');
  ctx.save();
  ctx.globalCompositeOperation = state.tool === 'erase' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#000';
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(8, Math.round(0.09 * Math.max(state.W, state.H)));
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0] + 0.01, b[1]); ctx.stroke();
  ctx.restore();
  recompute();
}
els.overlay.addEventListener('pointerdown', (e) => {
  if (!state.tool || !state.lab) return;
  e.preventDefault();
  els.overlay.setPointerCapture(e.pointerId);
  last = toWorkXY(e); stroke(last, last);
});
els.overlay.addEventListener('pointermove', (e) => {
  if (!last) return;
  const p = toWorkXY(e); stroke(last, p); last = p;
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) els.overlay.addEventListener(ev, () => { last = null; });

// ---------- 모델 ----------
let sessionP = null;
async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  if (!res.body) { const b = await res.arrayBuffer(); onBytes(b.byteLength); return b; }
  const reader = res.body.getReader(); const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onBytes(value.length);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}
function loadScript(src) {
  return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error(src)); document.head.appendChild(s); });
}
function getSession() {
  if (sessionP) return sessionP;
  sessionP = (async () => {
    const m = state.meta;
    const total = m.model.bytes + m.runtime.wasm_bytes;
    let got = 0;
    const tick = (n) => {
      got += n;
      if (els.busy.hidden || !els.retry.hidden) return;
      els.busyBar.style.transform = `scaleX(${Math.min(1, got / total).toFixed(3)})`;
      els.busyText.textContent = `${T.busyPrep} ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)}MB, 처음 한 번만`;
    };
    await loadScript('vendor/ort/ort.wasm.min.js');
    const [wasm, model] = await Promise.all([
      fetchWithProgress('vendor/ort/ort-wasm-simd-threaded.wasm', tick),
      fetchWithProgress(m.model.file, tick),
    ]);
    const ort = window.ort;
    ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
    ort.env.wasm.wasmBinary = wasm;
    ort.env.wasm.numThreads = 1;
    els.busyText.textContent = T.busyPrep;
    return ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  })();
  sessionP.catch(() => { sessionP = null; });
  return sessionP;
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
async function segment(cv) {
  const sess = await getSession();
  const ort = window.ort;
  els.busyText.textContent = T.busyFind; els.busyBar.style.transform = 'scaleX(1)';
  await nextFrame();
  const t0 = performance.now();
  const S = 512;
  const c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cv, 0, 0, S, S);
  const px = ctx.getImageData(0, 0, S, S).data;
  const x = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let ch = 0; ch < 3; ch++) x[ch * S * S + i] = (px[i * 4 + ch] / 255 - MEAN[ch]) / STD[ch];
  const feeds = { [sess.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) };
  const out = await sess.run(feeds);
  const lg = out[sess.outputNames[0]];
  const [, C, h, w] = lg.dims;
  // 로짓을 작업 해상도로 쌍선형 확대(화소 중심 정렬)하며 argmax
  const s = PARAMS.WORK_LONG / Math.max(cv.width, cv.height);
  const W = Math.max(1, Math.round(cv.width * s)), H = Math.max(1, Math.round(cv.height * s));
  const lab = argmaxUpsample(lg.data, C, h, w, W, H);
  state.lastMs = performance.now() - t0;
  return { lab, W, H };
}

function axis(n, src) {
  const i0 = new Int32Array(n), i1 = new Int32Array(n), f = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let p = (k + 0.5) * src / n - 0.5; if (p < 0) p = 0;
    let a = Math.floor(p); if (a > src - 1) a = src - 1;
    const b = Math.min(a + 1, src - 1);
    i0[k] = a; i1[k] = b; f[k] = p - a;
  }
  return { i0, i1, f };
}
function argmaxUpsample(data, C, h, w, W, H) {
  const ax = axis(W, w), ay = axis(H, h);
  const best = new Float32Array(W * H).fill(-Infinity);
  const lab = new Uint8Array(W * H);
  const plane = h * w;
  for (let c = 0; c < C; c++) {
    const base = c * plane;
    for (let y = 0; y < H; y++) {
      const r0 = base + ay.i0[y] * w, r1 = base + ay.i1[y] * w, fy = ay.f[y];
      for (let x = 0; x < W; x++) {
        const a = ax.i0[x], b = ax.i1[x], fx = ax.f[x];
        const top = data[r0 + a] + (data[r0 + b] - data[r0 + a]) * fx;
        const bot = data[r1 + a] + (data[r1 + b] - data[r1 + a]) * fx;
        const v = top + (bot - top) * fy;
        const i = y * W + x;
        if (v > best[i]) { best[i] = v; lab[i] = c; }
      }
    }
  }
  return lab;
}

// ---------- 내 사진 ----------
function busy(on, text) {
  els.busy.hidden = !on; els.retry.hidden = true;
  if (text) els.busyText.textContent = text;
  if (on) els.busyBar.style.transform = 'scaleX(0)';
}
function fail(msg) {
  els.busy.hidden = false; els.retry.hidden = false;
  els.busyBar.style.transform = 'scaleX(0)';
  els.busyText.textContent = msg;
}

let lastFile = null;
async function useFile(file) {
  lastFile = file;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try { bmp = await loadImage(URL.createObjectURL(file)); } catch { fail(T.failPhoto); return; }
  }
  const bw = bmp.width || bmp.naturalWidth, bh = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, 960 / Math.max(bw, bh));
  const cv = document.createElement('canvas'); cv.width = Math.round(bw * s); cv.height = Math.round(bh * s);
  const cctx = cv.getContext('2d'); cctx.imageSmoothingQuality = 'high'; cctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  setPhotoCanvas(cv);
  els.photo.src = cv.toDataURL('image/jpeg', 0.88); els.photo.alt = '올린 보도 사진';
  els.overlay.getContext('2d').clearRect(0, 0, els.overlay.width, els.overlay.height);
  els.overlay.classList.remove('reveal');
  for (const b of els.examples.querySelectorAll('.ex')) b.setAttribute('aria-pressed', 'false');
  state.source = 'upload'; state.example = null; state.lab = null; state.result = null;
  els.num.textContent = ''; els.pct.hidden = true; els.grade.dataset.g = ''; els.grade.textContent = T.working;
  els.pick.hidden = true; els.swap.setAttribute('aria-expanded', 'false');
  busy(true, T.busyPrep);
  try {
    const { lab, W, H } = await segment(cv);
    setLabels(lab, W, H);
    busy(false);
    setTool('paint');
    recompute();
    requestAnimationFrame(() => els.overlay.classList.add('reveal'));
    renderBasis();
  } catch (e) {
    console.warn(e);
    fail(T.failModel);
    els.grade.textContent = T.failed;
  }
}
els.file.addEventListener('change', () => { const f = els.file.files && els.file.files[0]; if (f) useFile(f); els.file.value = ''; });
els.retry.addEventListener('click', () => { if (lastFile) useFile(lastFile); });
// 올리기를 누르는 순간 모델 받기를 미리 시작한다(파일을 고르는 동안 시간을 번다)
document.querySelector('label.upload').addEventListener('click', () => { if (state.meta) getSession().catch(() => {}); });

// ---------- 요청서 ----------
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function composite(maxLong = 960) {
  const pc = state.photoCanvas;
  const s = Math.min(1, maxLong / Math.max(pc.width, pc.height));
  const c = document.createElement('canvas'); c.width = Math.round(pc.width * s); c.height = Math.round(pc.height * s);
  const ctx = c.getContext('2d');
  ctx.drawImage(pc, 0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(els.overlay, 0, 0, c.width, c.height);
  return c;
}
function whenText(v) {
  if (!v) return '';
  const d = new Date(v);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const ASK = '보도가 차량과 물건으로 막혀 보행보조기, 휠체어, 유모차 통행이 어려운 구간. 현장 확인과 주정차 계도, 적치물 정리, 시설 정비 등 개선 조치 요청';
function toText(to) {
  return to === 'gu' ? '관할 시·군·구청 보행환경(도로, 교통) 담당 부서' : '안전신문고(행정안전부) 신고 첨부';
}
function requestText() {
  const r = state.result; const to = els.form.elements.to.value;
  return [
    '[보도 통행 불편 개선 요청]',
    `제출처: ${toText(to)}`,
    `위치: ${els.place.value.trim()}`,
    `확인 일시: ${whenText(els.when.value)}`,
    `통행 가능 비율: ${Math.floor(r.ratio)}% (${r.grade}, 사진에서 칠한 구간 중 막히지 않은 면적 비율)`,
    `요청 내용: ${ASK}`,
    els.memo.value.trim() ? `현장 메모: ${els.memo.value.trim()}` : '',
    to === 'sinmungo' ? '첨부: 표시 사진 1장' : '',
  ].filter(Boolean).join('\n');
}
function photoCredit() {
  const ex = state.example;
  return ex ? `사진 ${esc(ex.author)}, ${esc(ex.license)}, 위키미디어 공용` : '사진 요청인 촬영';
}
function buildSheet() {
  const r = state.result; const to = els.form.elements.to.value;
  const img = composite(1200).toDataURL('image/jpeg', 0.9);
  const G = PARAMS.GRADE_GOOD, Wn = PARAMS.GRADE_WARN;
  const memo = els.memo.value.trim();
  els.sheet.innerHTML = `
    <h3>보도 통행 불편 개선 요청</h3>
    <table>
      <tr><th scope="row">제출처</th><td>${esc(toText(to))}</td></tr>
      <tr><th scope="row">위치</th><td>${esc(els.place.value.trim())}</td></tr>
      <tr><th scope="row">확인 일시</th><td>${esc(whenText(els.when.value))}</td></tr>
      <tr><th scope="row">통행 가능 비율</th><td><b>${Math.floor(r.ratio)}%</b> ${esc(r.grade)}
        <span class="note">칠한 구간에서 차, 사람, 기둥, 물건 면적을 뺀 비율. ${G}% 이상 양호, ${Wn}% 이상 ${G}% 미만 주의, ${Wn}% 미만 단절. 도구 설계 기준, 법정 기준과 별개</span></td></tr>
      <tr><th scope="row">사진</th><td><figure><img src="${img}" alt="막힌 구간이 표시된 보도 사진">
        <figcaption>${T.legend}. ${photoCredit()}</figcaption></figure></td></tr>
      <tr><th scope="row">요청 내용</th><td class="ask"><p>${ASK}</p>${memo ? `<p>현장 메모: ${esc(memo)}</p>` : ''}</td></tr>
    </table>
    <p class="closing">위와 같이 보도 통행 불편 개선 요청</p>
    <div class="sign"><span>${esc(whenText(nowLocal()))}</span><span>요청인 ________________ (서명)</span></div>
    <p class="tool">작성 도구 RoadPush. 연락처는 접수 창구에 직접 입력</p>`;
}
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  els.err.hidden = true;
  if (!state.result || state.result.ratio === null) { els.err.textContent = T.errPaint; els.err.hidden = false; return; }
  if (!els.place.value.trim()) { els.err.textContent = T.errPlace; els.err.hidden = false; els.place.focus(); return; }
  buildSheet();
  els.sheetWrap.hidden = false;
  els.actMsg.textContent = '';
  els.sheetWrap.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
$('do-print').addEventListener('click', () => window.print());
$('do-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(requestText()); els.actMsg.textContent = T.copied; }
  catch { els.actMsg.textContent = T.copyBlocked; }
});
$('do-save').addEventListener('click', () => {
  composite(1600).toBlob((b) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(b);
    a.download = `roadpush_${els.when.value.replace(/[-:T]/g, '').slice(0, 12) || 'photo'}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
    els.actMsg.textContent = T.saved;
  }, 'image/jpeg', 0.9);
});

// ---------- 자세히 ----------
function renderBasis() {
  const n = state.meta.numbers;
  const iou = n.rp_iou_q8_pooled, dum = n.rp_iou_dummy_pooled, N = n.rp_eval_n.value;
  const kc = n.rp_syn_ac_r_kappa_q8, kx = n.rp_syn_ax_r_kappa_q8;
  const G = PARAMS.GRADE_GOOD, Wn = PARAMS.GRADE_WARN;
  const ex = state.example;
  const credit = ex
    ? `${esc(ex.desc.replace(/\s*\(.*\)$/, ''))}. 촬영 ${esc(ex.author)}, ${esc(ex.license)}, <a href="${ex.source}" rel="noopener">위키미디어 공용 원본</a>`
    : '요청인이 올린 사진, 이 기기 안에서만 처리';
  els.basis.innerHTML = `
    <div><h3>등급 기준</h3>
      <p>통행 가능 비율: 칠한 구간 중 장애물이 아닌 면적 ÷ 칠한 구간 면적. ${G}% 이상 양호, ${Wn}% 이상 ${G}% 미만 주의, ${Wn}% 미만 단절.
      이 도구의 설계 기준, 법정 보도 유효폭 기준과 별개. 미터 단위 폭이 아닌 면적 비율</p></div>
    <div><h3>성능 근거</h3>
      <ul>
        <li>보도 찾기 정확도 IoU ${fmt(iou.value)}(95% 구간 ${fmt(iou.ci[0])}~${fmt(iou.ci[1])}), 기준선(사진 아래 3분의 1을 보도로 가정) ${fmt(dum.value)}. ADE20K 검증 사진 ${N}장, 해외 공개 데이터</li>
        <li>칠한 구간 안 장애물 판정의 등급 일치도(카파) ${fmt(kc.value, 2)}(넓게 칠한 경우, 95% 구간 ${fmt(kc.ci[0], 2)}~${fmt(kc.ci[1], 2)}), ${fmt(kx.value, 2)}(정확히 칠한 경우, 95% 구간 ${fmt(kx.ci[0], 2)}~${fmt(kx.ci[1], 2)}). 다른 사진의 차량과 사람을 잘라 붙인 합성 시험, 칠한 구간은 정답 보도 영역으로 만든 모의 입력</li>
        <li>모델 ${fmt(n.rp_model_mb_q8.value, 1)}MB, PC CPU 1스레드 1장 중앙값 ${fmt(n.rp_time_q8_1thread_s.value, 2)}초(10~90% 범위 ${fmt(n.rp_time_q8_1thread_p10_s.value, 2)}~${fmt(n.rp_time_q8_1thread_p90_s.value, 2)}초, 휴대폰은 미측정)${state.lastMs ? `, 이 기기 실측 ${(state.lastMs / 1000).toFixed(1)}초` : ''}</li>
      </ul></div>
    <div><h3>한계</h3>
      <ul>
        <li>사진만으로 매긴 자동 등급은 시험 기준 미달. 그래서 지나갈 보도 구간은 사람이 칠하고, 그 안에서 막은 물체를 AI가 찾는 방식</li>
        <li>한국 보도 사진 정량 평가는 다음 단계. 예시 사진은 눈으로 확인한 결과</li>
        <li>합성 시험은 실제 불법주차 성능이 아니며, 단절 사례는 검증 전</li>
        <li>눈 덮인 보도, 차도와 높이 차가 없는 보도는 보도 후보 누락 사례. 노점 매대는 장애물 판정 대상 밖</li>
      </ul></div>
    <div><h3>사진 출처</h3><p>${credit}</p></div>
    <div><h3>라이선스</h3>
      <p>${esc(state.meta.model.name)}, ${esc(state.meta.model.license)}. 실행기 ${esc(state.meta.runtime.name)} ${esc(state.meta.runtime.version)}(${esc(state.meta.runtime.license)}).
      글꼴 SUIT Variable(SIL OFL 1.1). <a href="licenses/LICENSES.html">전체 라이선스와 사진 출처</a></p></div>`;
}

// ---------- 시작 ----------
async function init() {
  els.when.value = nowLocal();
  try {
    state.meta = await (await fetch('data/meta.json')).json();
  } catch {
    setHint(T.failMeta); return;
  }
  renderBasis();
  for (const ex of state.meta.examples) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ex'; b.dataset.id = ex.id; b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `예시 사진 ${ex.place}`);
    b.innerHTML = `<img src="${ex.thumb}" alt="" width="88" height="62" loading="lazy">`;
    b.addEventListener('click', () => { history.replaceState(null, '', `#${ex.id}`); showExample(ex); });
    els.examples.appendChild(b);
  }
  const want = location.hash.slice(1);
  const first = state.meta.examples.find((e) => e.id === want) || state.meta.examples[0];
  await showExample(first);
}
init();

// 화면 점검용: 예시 사진을 브라우저 모델로 다시 돌려 미리 계산한 값과 비교(사용자 동선에는 쓰지 않음)
window.__roadpushCheck = async () => {
  const ex = state.example; if (!ex) return null;
  const pre = state.lab.slice();
  const { lab, W, H } = await segment(state.photoCanvas);
  let same = 0; for (let i = 0; i < lab.length; i++) if (lab[i] === pre[i]) same++;
  const { m } = regionMask();
  const live = assistedRatio(lab, W, H, m).ratio;
  return { agree: same / lab.length, live, pre: ex.py_assisted_ratio, ms: state.lastMs , W, H };
};
