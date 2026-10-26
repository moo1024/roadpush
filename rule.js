// RoadPush 유효 보도 비율 산식 (브라우저용 참조 구현)
// 정본 규칙: analysis/00_질문.md 「유효 보도 비율 산식」, Python 판: analysis/03_scripts/rp_rule.py
// 두 판이 같은 값을 내는지 03_model.py 가 대조한다(05_results/rp_js_parity.json).
//
// 입력 라벨 지도: transformers.js image-segmentation 결과가 아니라 로짓 argmax 지도를 쓴다.
//   모델  : Xenova/segformer-b0-finetuned-ade-512-512, dtype 'q8'(WASM 기본, onnx/model_quantized.onnx)
//   전처리: 512x512 쌍선형, /255, mean [0.485,0.456,0.406], std [0.229,0.224,0.225]
//   후처리: 로짓 [1,150,128,128] 을 원본 크기로 쌍선형 확대 후 argmax (0 기준 id)
// 그 다음 toWork() 로 긴 변 512 로 줄여 넣는다.
//
// 권장 흐름(model_card.md 「도구화」): 보조 입력 모드
//   1) effectiveRatio() 의 보도 화소(초록)를 처음 제안으로 보여 준다
//   2) 사용자가 막힌 구간의 보도를 손가락으로 칠한다(캔버스 경로 채우기 → getImageData 알파 > 0 을 region 으로)
//   3) assistedRatio(lab, W, H, region) 의 ratio(면적 비율)와 grade 를 주 결과로 띄운다
// 합성 시험에서 통과 기준을 넘은 조합은 보조 입력 + 면적 비율뿐이다(사후 선택이라는 점은 model_card 에 적었다).

export const ADE_SIDEWALK = 11;
export const ADE_OBSTACLE = [12, 20, 80, 83, 102, 116, 127, 126, 93, 87, 43, 136, 138, 41, 111, 112, 115,
  125, 17, 69, 19, 15, 110, 88];
// person car bus truck van minibike bicycle animal pole streetlight signboard traffic-light ashcan box
// barrel basket bag pot plant bench chair table stool booth  (tree·fence·railing 은 넣지 않는다)

export const PARAMS = {
  WORK_LONG: 512, MIN_COMP_FRAC: 0.0005, BAND_FRAC: 0.02, MIN_BAND_PX: 10,
  CONTACT_SHARE: 0.5, MIN_AREA_FRAC: 0.01, GRADE_GOOD: 70, GRADE_WARN: 40,
  ROW_MIN_FRAC: 0.02, ROW_WIN_FRAC: 0.02,
};

export function toWork(lab, w, h) {
  const s = PARAMS.WORK_LONG / Math.max(h, w);
  const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(Math.floor((y + 0.5) * h / nh), h - 1);
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(Math.floor((x + 0.5) * w / nw), w - 1);
      out[y * nw + x] = lab[sy * w + sx];
    }
  }
  return { lab: out, w: nw, h: nh };
}

export function grade(r) {
  if (r === null) return '불가';
  return r >= PARAMS.GRADE_GOOD ? '양호' : (r >= PARAMS.GRADE_WARN ? '주의' : '단절');
}

export function effectiveRatio(lab, W, H, sid = ADE_SIDEWALK, obstacle = ADE_OBSTACLE) {
  const N = W * H;
  const isObs = new Uint8Array(256);
  for (const c of obstacle) isObs[c] = 1;
  const bMask = new Uint8Array(N);
  let sCnt = 0;
  const first = new Int32Array(W).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lab[y * W + x] === sid) { sCnt++; if (first[x] < 0) first[x] = y; }
  }
  if (sCnt > 0) {
    // 보도 윗선: 보도 없는 열은 선형 보간, 양끝 밖은 가장 가까운 값
    const xsHave = [];
    for (let x = 0; x < W; x++) if (first[x] >= 0) xsHave.push(x);
    const top = new Float64Array(W);
    let j = 0;
    for (let x = 0; x < W; x++) {
      if (x <= xsHave[0]) { top[x] = first[xsHave[0]]; continue; }
      if (x >= xsHave[xsHave.length - 1]) { top[x] = first[xsHave[xsHave.length - 1]]; continue; }
      while (xsHave[j + 1] < x) j++;
      const a = xsHave[j], b = xsHave[j + 1];
      top[x] = first[a] + (first[b] - first[a]) * (x - a) / (b - a);
    }
    // 8방향 연결 성분
    const comp = new Int32Array(N);
    const k = Math.max(2, Math.round(PARAMS.BAND_FRAC * H));
    const minPx = PARAMS.MIN_COMP_FRAC * H * W;
    let label = 0;
    const stack = new Int32Array(N);
    for (let p0 = 0; p0 < N; p0++) {
      if (!isObs[lab[p0]] || comp[p0]) continue;
      label++;
      let sp = 0; stack[sp++] = p0; comp[p0] = label;
      const pix = [];
      let x0 = W, x1 = -1, y0 = H, y1 = -1;
      while (sp) {
        const p = stack[--sp]; pix.push(p);
        const py = (p / W) | 0, px = p - py * W;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const ny = py + dy, nx = px + dx;
          if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
          const q = ny * W + nx;
          if (!comp[q] && isObs[lab[q]]) { comp[q] = label; stack[sp++] = q; }
        }
      }
      if (pix.length < minPx) continue;
      // 밑띠: 열마다 가장 아래 화소 바로 밑 k 화소, 장애물 아닌 화소만
      const yb = new Int32Array(W).fill(-1);
      for (const p of pix) { const py = (p / W) | 0, px = p - py * W; if (py > yb[px]) yb[px] = py; }
      let nBand = 0, nSide = 0;
      for (let x = x0; x <= x1; x++) {
        if (yb[x] < 0) continue;
        for (let y = yb[x] + 1; y < Math.min(H, yb[x] + 1 + k); y++) {
          const v = lab[y * W + x];
          if (isObs[v]) continue;
          nBand++; if (v === sid) nSide++;
        }
      }
      if (nBand < PARAMS.MIN_BAND_PX) {
        // 둘레 k 화소 고리(정사각 이웃)
        nBand = 0; nSide = 0;
        const ry0 = Math.max(0, y0 - k), ry1 = Math.min(H, y1 + 1 + k);
        const rx0 = Math.max(0, x0 - k), rx1 = Math.min(W, x1 + 1 + k);
        const bw = rx1 - rx0, bh = ry1 - ry0;
        const full = new Uint8Array(bw * bh);
        for (const p of pix) { const py = (p / W) | 0, px = p - py * W; full[(py - ry0) * bw + (px - rx0)] = 1; }
        const tmp = new Uint8Array(bw * bh), dil = new Uint8Array(bw * bh);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          let m = 0; for (let d = Math.max(0, x - k); d <= Math.min(bw - 1, x + k) && !m; d++) m = full[y * bw + d];
          tmp[y * bw + x] = m;
        }
        for (let x = 0; x < bw; x++) for (let y = 0; y < bh; y++) {
          let m = 0; for (let d = Math.max(0, y - k); d <= Math.min(bh - 1, y + k) && !m; d++) m = tmp[d * bw + x];
          dil[y * bw + x] = m;
        }
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          if (!dil[y * bw + x] || full[y * bw + x]) continue;
          const v = lab[(y + ry0) * W + (x + rx0)];
          if (isObs[v]) continue;
          nBand++; if (v === sid) nSide++;
        }
      }
      if (nBand === 0) continue;
      if (nSide / nBand >= PARAMS.CONTACT_SHARE) {
        for (const p of pix) { const py = (p / W) | 0, px = p - py * W; if (py >= top[px]) bMask[p] = 1; }
      }
    }
  }
  let bCnt = 0; for (let i = 0; i < N; i++) bCnt += bMask[i];
  const ratio = (sCnt + bCnt < PARAMS.MIN_AREA_FRAC * N) ? null : 100 * sCnt / (sCnt + bCnt);
  const width = widthRatio(lab, W, H, sid, bMask, sCnt + bCnt);
  // 자동 모드 결과. 평가에서 등급 판정 기준을 못 넘었으므로 화면에서는 「참고값」으로만 쓴다(model_card.md).
  return { width, widthGrade: grade(width), ratio, grade: grade(ratio), S: sCnt, B: bCnt, bMask };
}

// 병목 폭 비율 Wr: 행마다 보도로 남은 비율을 구해 이동평균한 뒤 가장 낮은 값(00_질문.md 사전등록 변경 2)
export function widthRatio(lab, W, H, sid, bMask, sbTotal) {
  if (sbTotal < PARAMS.MIN_AREA_FRAC * W * H) return null;
  const r = [];
  for (let y = 0; y < H; y++) {
    let s = 0, b = 0;
    for (let x = 0; x < W; x++) { const p = y * W + x; if (lab[p] === sid) s++; if (bMask[p]) b++; }
    if (s + b >= PARAMS.ROW_MIN_FRAC * W) r.push(s / (s + b));
  }
  const w = Math.max(3, Math.round(PARAMS.ROW_WIN_FRAC * H));
  if (r.length < w) return null;
  const h = Math.floor(w / 2);
  const c = [0]; for (const v of r) c.push(c[c.length - 1] + v);
  let mn = Infinity;
  for (let i = 0; i < r.length; i++) {
    const lo = Math.max(0, i - h), hi = Math.min(r.length, i + h + 1);
    const v = (c[hi] - c[lo]) / (hi - lo); if (v < mn) mn = v;
  }
  return mn * 100;
}

// 보조 입력 모드(사전등록 변경 3): 사용자가 손가락으로 그린 보도 영역 region(Uint8Array, 1=영역) 안에서
// 장애물 클래스 화소를 B', 나머지를 S' 로 본다. 접지 규칙·윗선 자르기는 쓰지 않는다.
export function assistedRatio(lab, W, H, region, obstacle = ADE_OBSTACLE) {
  const isObs = new Uint8Array(256);
  for (const c of obstacle) isObs[c] = 1;
  const N = W * H;
  const bMask = new Uint8Array(N), sLab = new Uint8Array(N);
  let s = 0, b = 0;
  for (let i = 0; i < N; i++) {
    if (!region[i]) continue;
    if (isObs[lab[i]]) { bMask[i] = 1; b++; } else { sLab[i] = 1; s++; }
  }
  const ratio = (s + b < PARAMS.MIN_AREA_FRAC * N) ? null : 100 * s / (s + b);
  const width = widthRatio(sLab, W, H, 1, bMask, s + b);
  return { width, widthGrade: grade(width), ratio, grade: grade(ratio), S: s, B: b, bMask };
}
