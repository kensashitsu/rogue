// 3D 版の音。テーマ（ASCII だけでどこまで現実的な空間を表せるか）に合わせ、音も「現実の聞こえ方」に寄せる。
//   - 鳴らすもの: 自分の足音・怪物の足音（見えていない怪物も。2026-11-22 ユーザー指定で「鳴らして遊んでから考える」）・
//     振る・当たる・殴られる・炎・凍る・階段・テレポート・燭台のはぜる音・地下の空気
//   - 聞こえ方: 距離で小さく・遠いほど高い音が抜ける・向きで左右（HRTF）・壁越しはこもる・
//     自分のいる所の広さで響き（狭い通路は短く詰まった響き、部屋は広さに応じて長く）
//   - 消音でもゲーム性は変わらない作り: 音でしか分からない合図は作らない（音は今のところ試し）
//   - 音はすべてその場で合成する（ファイルを読まない）。操作が止まって少したったら音の処理を眠らせる（電池）
//   - iPhone は消音スイッチに従う（audioSession 'ambient'）
const W = 80;
const DIRS = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];
const KEY = 'rogue3d-sound';
const IDLE_MS = 6000;     // 操作が止まってからこれだけたったら、空気・燭台の音を下げて処理を眠らせる
const HEAR_MAX = 18;      // これより遠い音は鳴らさない（どうせ聞こえない。処理を減らす）
const CELL_M = 1.6;       // 1 マスの大きさ（m）。響きの早さ（壁までの往復）に使う

let scene = null;         // r3d.soundScene
let ctx = null, master = null, dry = null, wetA = null, wetB = null, convA = null, convB = null, useA = true;
let ambGain = null, torchVoices = [];
let enabled = true;
try { enabled = localStorage.getItem(KEY) !== '0'; } catch {}
let unlocked = false, activeAt = 0, sleeping = false, idleTimer = 0;
let lastPos = null, lastLevel = null, skipStep = false, lastStepAt = 0;
let prevMons = null;
let envKey = '';
const irCache = new Map();
const stats = { played: 0, last: [] };   // 確かめ用

export const isOn = () => enabled;
export function setOn(on) {
  enabled = !!on;
  try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch {}
  if (!ctx) return;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setTargetAtTime(enabled ? 1 : 0, t, 0.05);
  if (enabled) wake(); else setTimeout(() => { if (!enabled && ctx.state === 'running') ctx.suspend(); }, 300);
}

export function init(r3dScene) {
  scene = r3dScene;
  try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch {}   // iPhone: 消音スイッチで鳴らない・ほかの音楽を止めない
  // iPhone は触ったときにしか音を始められない。最初に触ったときに作る（以後も、眠っていたら触って起こす）
  const unlock = () => {
    if (!enabled || !(window.AudioContext || window.webkitAudioContext)) return;   // 音の仕組みが無いブラウザでは鳴らさないだけ
    if (!ctx) { try { build(); } catch (e) { console.warn(e); enabled = false; return; } }
    if (ctx.state !== 'running') ctx.resume();
    if (!unlocked) {   // 無音を一度鳴らして iOS の鍵を外す
      const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start();
      unlocked = true;
    }
    wake();
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) addEventListener(ev, unlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden && ctx && ctx.state === 'running') ctx.suspend(); });
  window.__snd = { stats, envKey: () => envKey, ctx: () => ctx, master: () => master, beepUp: d => beepUp(d), amb: () => ambGain, torch: () => torchVoices, step };
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------
function build() {
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC({ latencyHint: 'interactive' });
  master = ctx.createGain(); master.gain.value = enabled ? 1 : 0;
  // 大きな音が重なっても割れないように
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
  master.connect(comp); comp.connect(ctx.destination);
  dry = ctx.createGain(); dry.connect(master);
  // 響き: 2 つの響きを用意し、場所が変わったら新しい響きを空いた側に入れて入れ替える（切り替えで音がぶつっと切れないように）
  convA = ctx.createConvolver(); convB = ctx.createConvolver();
  wetA = ctx.createGain(); wetB = ctx.createGain(); wetA.gain.value = 0; wetB.gain.value = 0;
  convA.connect(wetA); convB.connect(wetB); wetA.connect(master); wetB.connect(master);
  setListener(true);
  startAmbient();
  envKey = ''; updateEnv();
}

// 音の出どころ 1 つ: 位置（マス）→ 壁越しのこもり → 向きと距離（HRTF）→ そのまま / 響きへ
function voice(y, x, { h = 0.5, occl = true, send = 0.5, model = 'HRTF' } = {}) {
  const now = ctx.currentTime;
  const inp = ctx.createGain();
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
  const p = scene().player, dist = p ? Math.hypot(y - p[0], x - p[1]) : 0;
  const block = occl && p ? blocked(p[0], p[1], y, x) : 0;
  // 空気で高い音が先に減る（遠いほどこもる）＋ 壁越しは大きくこもって小さくなる
  let cut = 16000 * Math.exp(-dist / 14);
  let g = 1;
  if (block) { cut = Math.min(cut, block === 1 ? 900 : 450); g = block === 1 ? 0.5 : 0.3; }
  lp.frequency.setValueAtTime(Math.max(200, cut), now);
  inp.gain.setValueAtTime(g, now);
  const pan = ctx.createPanner();
  pan.panningModel = model; pan.distanceModel = 'inverse';
  pan.refDistance = 1; pan.rolloffFactor = 0.8; pan.maxDistance = 60;
  setPos(pan, x + 0.5, h, y + 0.5);
  inp.connect(lp); lp.connect(pan); pan.connect(dry);
  // 響きへは、こもった後の音を距離に関係なく送る（遠くの音ほど響きの割合が増えて「遠く」に聞こえる）
  const s = ctx.createGain(); s.gain.value = send * g;
  lp.connect(s); s.connect(convA); s.connect(convB);
  return { inp, dist, block };
}
function setPos(pan, x, y, z) {
  if (pan.positionX) { pan.positionX.value = x; pan.positionY.value = y; pan.positionZ.value = z; }
  else pan.setPosition(x, y, z);
}

// 聞く人（自分）の位置と向き。向きを変えると音の左右も回る（カメラの回りに合わせて少しなめらかに）
function setListener(jump) {
  if (!ctx || !scene) return;
  const { player: p, facing } = scene();
  if (!p) return;
  const L = ctx.listener, t = ctx.currentTime, tc = jump ? 0 : 0.05;
  const [dy, dx] = DIRS[facing];
  const n = Math.hypot(dx, dy), fx = dx / n, fz = dy / n;
  const set = (param, v) => { if (tc) param.setTargetAtTime(v, t, tc); else param.setValueAtTime(v, t); };
  if (L.positionX) {
    set(L.positionX, p[1] + 0.5); set(L.positionY, 0.55); set(L.positionZ, p[0] + 0.5);
    set(L.forwardX, fx); set(L.forwardY, 0); set(L.forwardZ, fz);
    set(L.upX, 0); set(L.upY, 1); set(L.upZ, 0);
  } else {
    L.setPosition(p[1] + 0.5, 0.55, p[0] + 0.5);
    L.setOrientation(fx, 0, fz, 0, 1, 0);
  }
}

// 自分から音の出どころまでの間にある壁・岩の数（0 = 見通せる、1 = 壁 1 枚、2 = それ以上）
// 部屋の壁と、分かっている岩は 1 枚ずつ数える。知らない所（地図に無い所）は、岩か、まだ歩いていない通路か分からない
// （地図の外の本当の形は 3D 版も知らない）ので、3 マスで 1 枚と数える（闇の通路の向こうの足音が、岩の中ほどこもらないように）
function blocked(y0, x0, y1, x1) {
  const sc = scene(), g = sc.grid;
  if (!g) return 0;
  const n = Math.max(Math.abs(y1 - y0), Math.abs(x1 - x0));
  let k = 0, unk = 0;
  for (let i = 1; i < n; i++) {
    const y = y0 + Math.round((y1 - y0) * i / n), x = x0 + Math.round((x1 - x0) * i / n);
    const c = g[y] && g[y][x] ? g[y][x][0] : ' ';
    if (c === ' ' && !sc.isRock(y * W + x)) { if (++unk % 3 === 0) k++; }
    else if (c === '-' || c === '|' || c === ' ') k++;
    if (k >= 2) return 2;
  }
  return k;
}

// ---------------------------------------------------------------------------
// 響き（場所の広さ）
// ---------------------------------------------------------------------------
function roomAt(y, x) {
  for (const r of scene().rooms) if (y >= r.top && y <= r.bottom && x >= r.left && x <= r.right) return r;
  return null;
}
function updateEnv() {
  const p = scene().player;
  if (!ctx || !p) return;
  const r = roomAt(p[0], p[1]);
  let key, make;
  if (r) {
    const w = r.right - r.left - 1, h = r.bottom - r.top - 1;
    const onEdge = p[0] === r.top || p[0] === r.bottom || p[1] === r.left || p[1] === r.right;   // 扉の口
    const qw = Math.max(1, Math.round(w / 3) * 3), qh = Math.max(1, Math.round(h / 3) * 3);
    key = `room${qw}x${qh}${onEdge ? 'd' : ''}`;
    make = () => roomIR(qw, qh, onEdge);
  } else {
    key = 'corr';
    make = corridorIR;
  }
  if (key === envKey) return;
  envKey = key;
  if (!irCache.has(key)) irCache.set(key, make());
  const [buf, level] = irCache.get(key);
  // 空いている側に入れて、0.25 秒かけて入れ替える
  const t = ctx.currentTime;
  const [inC, inG, outG] = useA ? [convB, wetB, wetA] : [convA, wetA, wetB];
  useA = !useA;
  inC.buffer = buf;
  inG.gain.cancelScheduledValues(t); outG.gain.cancelScheduledValues(t);
  inG.gain.setTargetAtTime(level, t, 0.08); outG.gain.setTargetAtTime(0, t, 0.08);
}

// 部屋の響き: 壁の往復で決まる早い反射 ＋ 広さで長さの変わる余韻（高い音から先に消える）
function roomIR(w, h, door) {
  const sr = ctx.sampleRate;
  const area = w * h;
  const t60 = Math.min(1.6, 0.35 + area * 0.006);   // 小さな部屋 0.4 秒前後 → 大きな部屋 1.6 秒まで
  const len = Math.ceil(sr * (t60 + 0.05));
  const buf = ctx.createBuffer(2, len, sr);
  const refl = [w, h, w * 2, h * 2, w + h].map(d => d * CELL_M / 343);   // 壁までの往復
  for (let ch = 0; ch < 2; ch++) {
    const a = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.pow(10, -3 * t / t60);
      // 時間がたつほど高い音を落とす（石の部屋でも高い音は先に吸われる）
      const k = Math.min(0.92, 0.25 + t / t60 * 0.7);
      lp = lp * k + (Math.random() * 2 - 1) * (1 - k);
      a[i] = lp * env * (t < 0.008 ? t / 0.008 : 1) * 2.2;
    }
    for (const [j, rt] of refl.entries()) {
      const i = Math.floor((rt + (ch ? 0.0013 : 0)) * sr);
      if (i < len) a[i] += (j < 2 ? 0.5 : 0.28) * (Math.random() < 0.5 ? -1 : 1) * Math.pow(10, -3 * rt / t60);
    }
  }
  // 扉の口に立つと、片側（部屋）からだけ響きが返る → 響きを少し弱く
  return [buf, (door ? 0.55 : 0.8) * (0.7 + Math.min(0.5, area / 200))];
}
// 通路の響き: 両側の岩の壁が近く、細かい往復（ばたつき）がすぐ消える。長さは短く、こもる
function corridorIR() {
  const sr = ctx.sampleRate;
  const t60 = 0.32, len = Math.ceil(sr * 0.4);
  const buf = ctx.createBuffer(2, len, sr);
  const flutter = CELL_M / 343;   // 両側の壁の往復 ≒ 4.7ms
  for (let ch = 0; ch < 2; ch++) {
    const a = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr, env = Math.pow(10, -3 * t / t60);
      lp = lp * 0.75 + (Math.random() * 2 - 1) * 0.25;
      a[i] = lp * env * 1.2;
    }
    for (let k = 1; k * flutter < 0.12; k++) {
      const i = Math.floor((k * flutter + (ch ? 0.0007 : 0)) * sr);
      if (i < len) a[i] += 0.45 * Math.pow(0.72, k) * (k % 2 ? -1 : 1);
    }
  }
  return [buf, 0.5];
}

// ---------------------------------------------------------------------------
// 音のもと（その場で作る）
// ---------------------------------------------------------------------------
let noiseBuf = null;
function noise() {
  if (noiseBuf) return noiseBuf;
  const len = ctx.sampleRate * 2;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const a = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) a[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
// 雑音を帯域で切って、短い山の形で鳴らす
function burst(out, t, { f = 1500, q = 1, type = 'bandpass', dur = 0.06, gain = 0.5, attack = 0.002, f2 = null } = {}) {
  const s = ctx.createBufferSource(); s.buffer = noise();
  s.playbackRate.value = 0.8 + Math.random() * 0.4;
  const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
  if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  s.connect(fl); fl.connect(g); g.connect(out);
  s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.02);
}
// 低い「ずん」（足の裏・打撃の重さ）
function thump(out, t, { f = 90, dur = 0.08, gain = 0.6, drop = 0.6 } = {}) {
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * drop, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
}

const rnd = (a, b) => a + Math.random() * (b - a);

// 金属の「ちん・からん」: 倍音が整数倍にならない（鐘や金属片の響き）。f が低いほど大きな金物
function tink(out, t, { f = 3000, dur = 0.25, gain = 0.2, parts = [1, 2.76, 5.4, 8.93] } = {}) {
  parts.forEach((m, i) => {
    if (f * m > 16000) return;   // 聞こえない高さの倍音は作らない
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * m * rnd(0.99, 1.01);
    const g = ctx.createGain(), d = dur / (1 + i * 0.7);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain / (1 + i * 0.8), t + 0.002); g.gain.exponentialRampToValueAtTime(0.0003, t + d);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + d + 0.02);
  });
}
// ガラス: 高く澄んだ短い響き（瓶どうし・瓶を床に置く）
const glass = (out, t, gain = 0.15, f = 2400) => tink(out, t, { f: f * rnd(0.95, 1.05), dur: 0.35, gain, parts: [1, 2.32, 4.25] });
// 紙: 細かく乾いたかさかさ（巻物）
function rustle(out, t, { n = 8, span = 0.4, gain = 0.25 } = {}) {
  for (let i = 0; i < n; i++) burst(out, t + Math.random() * span, { f: rnd(2500, 7000), q: rnd(0.8, 2), dur: rnd(0.015, 0.05), gain: gain * rnd(0.4, 1) });
}
// 革のきしみ: 低めの帯域でざらっとこすれる
function creak(out, t, { dur = 0.25, gain = 0.3 } = {}) {
  burst(out, t, { f: rnd(500, 800), q: 4, dur, gain, attack: dur * 0.4, f2: rnd(350, 600) });
}
// 金貨: 数枚がぶつかり合う
function coins(out, t, n = 5, gain = 0.12) {
  for (let i = 0; i < n; i++) tink(out, t + i * rnd(0.02, 0.07), { f: rnd(3200, 4800), dur: 0.18, gain: gain * rnd(0.6, 1) });
}
// 物の種類ごとの「床に当たる・手に取る」音。soft: 手でそっと扱う（拾う・置く）
function thing(out, t, ch, w, soft) {
  const k = soft ? 0.6 : 1;
  if (ch === '*') coins(out, t, soft ? 6 : 4, 0.13 * k);
  else if (ch === ')') {   // 武器: 弓は木、ほかは金物
    if (w === 2) { thump(out, t, { f: 180, dur: 0.06, gain: 0.25 * k, drop: 0.8 }); burst(out, t, { f: 900, q: 3, dur: 0.04, gain: 0.2 * k }); }
    else if (w === 3 || w === 6) { tink(out, t, { f: 2600, dur: 0.1, gain: 0.08 * k }); burst(out, t, { f: 2000, q: 2, dur: 0.03, gain: 0.12 * k }); }   // 矢・ダーツ: 軽い
    else { tink(out, t, { f: w === 0 ? 700 : w === 5 ? 520 : 1100, dur: 0.45, gain: 0.16 * k }); thump(out, t, { f: 150, dur: 0.05, gain: 0.2 * k }); }
  } else if (ch === ']') {   // 鎧: 革はどさっ、金属はがしゃっ
    thump(out, t, { f: 90, dur: 0.12, gain: 0.35 * k });
    if (w === 0 || w === 2) creak(out, t, { dur: 0.15, gain: 0.25 * k });
    else for (let i = 0; i < 5; i++) tink(out, t + i * rnd(0.01, 0.04), { f: rnd(1500, 2600), dur: 0.15, gain: 0.07 * k });
  } else if (ch === '!') glass(out, t, 0.14 * k);
  else if (ch === '?') rustle(out, t, { n: 5, span: 0.2, gain: 0.18 * k });
  else if (ch === ':') { thump(out, t, { f: 130, dur: 0.07, gain: 0.3 * k }); burst(out, t, { f: 600, q: 1, dur: 0.05, gain: 0.15 * k }); }   // 食料: 包みがぽふっ
  else if (ch === '=' || ch === ',') tink(out, t, { f: 3800, dur: 0.3, gain: 0.08 * k });   // 指輪・魔除け: 小さな金物
  else if (ch === '/') { thump(out, t, { f: 240, dur: 0.05, gain: 0.2 * k, drop: 0.8 }); burst(out, t, { f: 1200, q: 3, dur: 0.03, gain: 0.15 * k }); }   // 杖: 木の棒がこつん
  else burst(out, t, { f: 1200, q: 1, dur: 0.05, gain: 0.15 * k });
}
function note(kind) { stats.played++; stats.last.push(kind); if (stats.last.length > 20) stats.last.shift(); }

// 足音。surface: 部屋の床（'.'）・通路（'#' 砂利まじり）・扉の口（'+' 木の敷居）
function step(y, x, { weight = 1, surface = '.', self = false, at = 0 } = {}) {
  const t = ctx.currentTime + 0.005 + at;
  const v = self ? voice(y, x, { h: 0.05, occl: false, send: 0.35, model: 'equalpower' }) : voice(y, x, { h: 0.05, send: 0.55 });
  const o = v.inp, g = (self ? 0.42 : 0.6) * rnd(0.8, 1.1);
  const heavy = weight > 1.3, light = weight < 0.7;
  thump(o, t, { f: heavy ? 55 : light ? 160 : 95, dur: heavy ? 0.16 : 0.07, gain: g * (heavy ? 1.3 : light ? 0.3 : 0.7) });
  if (surface === '#') {   // 通路: 砂利のざりっ
    burst(o, t, { f: rnd(2200, 3200), q: 0.8, dur: 0.09, gain: g * 0.55 * weight });
    burst(o, t + 0.03, { f: rnd(4000, 5500), q: 1.2, dur: 0.05, gain: g * 0.25 * weight });
  } else if (surface === '+') {   // 扉の口: 木
    thump(o, t + 0.003, { f: 210, dur: 0.06, gain: g * 0.5, drop: 0.8 });
    burst(o, t, { f: 900, q: 3, dur: 0.05, gain: g * 0.3 });
  } else {   // 石の床: 乾いたこつっ
    burst(o, t, { f: rnd(1400, 1900) / (heavy ? 1.6 : 1), q: 1.4, dur: light ? 0.03 : 0.05, gain: g * 0.45 * weight });
  }
}
// 怪物の歩き方
const GAIT = {
  heavy: new Set(['C', 'D', 'G', 'J', 'Q', 'T', 'U', 'Y']),   // ケンタウロス・ドラゴン・グリフィン・ジャバウォック・クアッガ・トロル・ユニコーン・イエティ
  wing: new Set(['B', 'K']),
  slither: new Set(['S', 'R']),   // 蛇
  light: new Set(['E', 'L', 'N', 'P', 'W']),   // エミュー・レプラコーン・ニンフ・ファントム・レイス（ほかは人ほどの足音）
};
function monStep(y, x, letter, at) {
  const t0 = at || 0;
  if (GAIT.wing.has(letter)) {   // 羽ばたき 2 回
    const v = voice(y, x, { h: 0.7, send: 0.5 });
    const t = ctx.currentTime + 0.01 + t0;
    burst(v.inp, t, { f: 500, type: 'lowpass', dur: 0.09, gain: 1.6, attack: 0.02 });
    burst(v.inp, t + 0.12, { f: 450, type: 'lowpass', dur: 0.09, gain: 1.3, attack: 0.02 });
    return;
  }
  if (GAIT.slither.has(letter)) {   // 這う: しゅるっ
    const v = voice(y, x, { h: 0.05, send: 0.5 });
    burst(v.inp, ctx.currentTime + 0.01 + t0, { f: 3500, q: 0.7, dur: 0.28, gain: 0.7, attack: 0.08, f2: 5000 });
    return;
  }
  const g = scene().grid, c = g && g[y] && g[y][x] ? g[y][x][0] : '.';
  const surface = c === '#' ? '#' : c === '+' ? '+' : '.';
  const weight = GAIT.heavy.has(letter) ? 1.6 : GAIT.light.has(letter) ? 0.8 : 1;
  step(y, x, { weight, surface: surface === '.' && !roomAt(y, x) ? '#' : surface, at: t0 });
  if (GAIT.heavy.has(letter)) step(y, x, { weight, surface, at: t0 + 0.18 });   // 大きい足は 2 歩ぶんの重さ
}

// ---------------------------------------------------------------------------
// 空気と燭台（鳴りっぱなしの音。操作が止まると眠らせる）
// ---------------------------------------------------------------------------
function startAmbient() {
  // 地下の空気: ごく低いうなり（茶色い雑音を低く切る）
  const len = ctx.sampleRate * 4, b = ctx.createBuffer(1, len, ctx.sampleRate), a = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; a[i] = last * 3.5; }
  const s = ctx.createBufferSource(); s.buffer = b; s.loop = true;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
  ambGain = ctx.createGain(); ambGain.gain.value = 0.05;
  s.connect(lp); lp.connect(ambGain); ambGain.connect(dry);
  const send = ctx.createGain(); send.gain.value = 0.3; ambGain.connect(send); send.connect(convA); send.connect(convB);
  s.start();
  // 燭台は松明（2026-11-22 ユーザー確認。蝋燭ではない）。はぜる音（4 秒をくり返す）。近い燭台 2 つに音を置く
  const cb = ctx.createBuffer(1, len, ctx.sampleRate), c = cb.getChannelData(0);
  let hiss = 0;
  for (let i = 0; i < len; i++) { hiss = hiss * 0.9 + (Math.random() * 2 - 1) * 0.1; c[i] = hiss * 0.15; }
  for (let k = 0; k < 70; k++) {   // ぱちっ
    const at = Math.floor(Math.random() * (len - 2000)), amp = Math.random() < 0.15 ? 0.9 : rnd(0.15, 0.45), n = Math.floor(rnd(80, 600));
    for (let i = 0; i < n; i++) c[at + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / (n / 5));
  }
  for (let j = 0; j < 2; j++) {
    const src = ctx.createBufferSource(); src.buffer = cb; src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
    const gn = ctx.createGain(); gn.gain.value = 0;
    const pan = ctx.createPanner(); pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = 0.6; pan.rolloffFactor = 1.6;
    src.connect(hp); hp.connect(gn); gn.connect(pan); pan.connect(dry);
    src.start(0, j * 1.7);
    torchVoices.push({ gn, pan, key: -1 });
  }
}
// 近い燭台（明かりの届く 3 マスほど）に音を置く。遠い燭台は鳴らさない
function updateTorches() {
  const sc = scene(), p = sc.player;
  if (!p || !torchVoices.length) return;
  const near = sc.sconces.map(s => ({ s, d: Math.hypot(s.x - (p[1] + 0.5), s.z - (p[0] + 0.5)) })).filter(o => o.d < 3.2).sort((a, b) => a.d - b.d).slice(0, 2);
  const t = ctx.currentTime;
  torchVoices.forEach((v, i) => {
    const o = near[i];
    if (!o) { v.gn.gain.setTargetAtTime(0, t, 0.3); v.key = -1; return; }
    const key = Math.round(o.s.x * 100) * 10000 + Math.round(o.s.z * 100);
    if (key !== v.key) { setPos(v.pan, o.s.x, 0.75, o.s.z); v.key = key; }
    v.gn.gain.setTargetAtTime(0.32, t, 0.3);
  });
}

function wake() {
  activeAt = performance.now();
  if (!ctx || !enabled) return;
  if (ctx.state !== 'running' && unlocked) ctx.resume();
  if (sleeping) { sleeping = false; ambGain.gain.setTargetAtTime(0.05, ctx.currentTime, 0.4); updateTorches(); }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!ctx || performance.now() - activeAt < IDLE_MS - 50) return;
    sleeping = true;
    const t = ctx.currentTime;
    ambGain.gain.setTargetAtTime(0, t, 0.5);
    torchVoices.forEach(v => v.gn.gain.setTargetAtTime(0, t, 0.5));
    setTimeout(() => { if (sleeping && ctx.state === 'running') ctx.suspend(); }, 2500);   // 鳴りやんでから止める
  }, IDLE_MS);
}
const ready = () => ctx && enabled && ctx.state !== 'closed' && unlocked;

// ---------------------------------------------------------------------------
// ゲームから（app.js が呼ぶ）
// ---------------------------------------------------------------------------
// 画面が描き直されたとき（歩いた・向きを変えた）
export function update() {
  if (!scene) return;
  const sc = scene(), p = sc.player;
  if (!p) return;
  if (ready()) { wake(); setListener(false); updateEnv(); updateTorches(); }
  watchXpLevel(sc.grid);
  const moved = lastPos && (lastPos[0] !== p[0] || lastPos[1] !== p[1]);
  const sameLevel = lastLevel === sc.level;
  if (moved && sameLevel && !skipStep && ready()) {
    const d = Math.max(Math.abs(lastPos[0] - p[0]), Math.abs(lastPos[1] - p[1]));
    const now = performance.now();
    if (d <= 3 && now - lastStepAt > 60) {   // iPhone で 2 歩分まとめて描かれたときは 2 歩鳴らす
      const under = surfaceAt(p[0], p[1]);
      for (let i = 0; i < d; i++) step(p[0], p[1], { self: true, surface: under, at: i * 0.11 });
      lastStepAt = now; note('step');
    }
  }
  if (moved || !lastPos) skipStep = false;
  lastPos = [p[0], p[1]]; lastLevel = sc.level;
}
// レベルアップ: 状態行の「経験:レベル/経験値」（英語は Exp:）でレベルが上がったのを見る。状態行が書き換わる＝画面に出た時に鳴る。
// 現実の音ではない出来事なので、ダンジョンの中の音（響き・向き）にはせず、端末のスピーカーが鳴らすピポパの音にする
// （読み込み・死んだときのエラー表示など、ゲームの仕組みの出来事は端末らしさで見せている方針に合わせた）。
// 下がったとき（レイス・ヴァンパイアに吸い取られた）は、同じ音を逆の順（ド・ソ・ミ・ド）で鳴らす（2026-11-22 ユーザー指定）
let xpLevel = null;
function watchXpLevel(grid) {
  const row = grid && grid[23];
  if (!row) return;
  const m = row.filter(Boolean).map(c => c[0]).join('').match(/(?:Exp|経験):\s*(\d+)\//);
  if (!m) return;
  const lv = +m[1];
  if (xpLevel !== null && lv !== xpLevel && ready()) beepUp(lv < xpLevel);
  xpLevel = lv;
}
function beepUp(down = false) {
  const t = ctx.currentTime + 0.05;
  const notes = [523, 659, 784, 1047];   // ド・ミ・ソ・ド（四角い波を少し丸めた PC のスピーカーの音）。下がったときは逆の順
  (down ? notes.reverse() : notes).forEach((f, i) => {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3500;
    const g = ctx.createGain(), at = t + i * 0.09, d = i === 3 ? 0.22 : 0.07;
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.05, at + 0.004); g.gain.setValueAtTime(0.05, at + d - 0.01); g.gain.linearRampToValueAtTime(0, at + d);
    o.connect(lp); lp.connect(g); g.connect(master); o.start(at); o.stop(at + d + 0.02);
  });
  note(down ? 'leveldown' : 'levelup');
}
// 自分の足元: 地図の字は @ なので、部屋の中か・扉か・通路かで決める
function surfaceAt(y, x) {
  const r = roomAt(y, x);
  if (!r) return '#';
  if (y === r.top || y === r.bottom || x === r.left || x === r.right) return '+';
  return '.';
}

// ゲームからの知らせ（effect）
export function effect(d) {
  if (d.type === 'teleport' || d.type === 'newlevel') skipStep = true;
  if (d.type === 'newlevel') prevMons = null;
  if (d.type === 'mons') { monsMoved(d.mons); return; }
  if (!ready()) return;
  wake();
  const p = scene().player;
  const t = ctx.currentTime;
  if (d.type === 'swing') {   // 振る: ひゅっ（当たれば当たる音は 'hit' で）
    const v = voice(p[0], p[1], { h: 0.6, occl: false, send: 0.3, model: 'equalpower' });
    burst(v.inp, t + 0.03, { f: 700, q: 1.5, dur: 0.2, gain: 1.4, attack: 0.08, f2: 2600 });
    note('swing');
  } else if (d.type === 'hit') {   // 当たる: どすっ（倒したら崩れ落ちる音）
    const v = voice(d.y, d.x, { h: 0.5, send: 0.5 });
    const at = t + 0.15;
    thump(v.inp, at, { f: 120, dur: 0.12, gain: 0.3 });
    burst(v.inp, at, { f: 900, q: 0.8, dur: 0.08, gain: 0.35 });
    if (d.killed) {
      thump(v.inp, at + 0.22, { f: 70, dur: 0.25, gain: 0.3 });
      for (let i = 0; i < 4; i++) burst(v.inp, at + 0.25 + i * rnd(0.04, 0.09), { f: rnd(1500, 3000), q: 2, dur: 0.04, gain: 0.25 });
    }
    note('hit');
  } else if (d.type === 'mattack') {   // 殴りかかってくる: 踏み込む・当たれば自分に響く
    const v = voice(d.y, d.x, { h: 0.5, send: 0.5 });
    burst(v.inp, t + 0.02, { f: 500, q: 1.2, dur: 0.18, gain: 1.0, attack: 0.06, f2: 1600 });
    note('mattack');
  } else if (d.type === 'hurt') {   // くらった: 自分の体に響く鈍い音（どこから来たかは殴った怪物の音で分かる）
    const v = voice(p[0], p[1], { h: 0.5, occl: false, send: 0.25, model: 'equalpower' });
    thump(v.inp, t + 0.1, { f: 75, dur: 0.18, gain: 0.45, drop: 0.5 });
    burst(v.inp, t + 0.1, { f: 400, type: 'lowpass', dur: 0.12, gain: 0.5 });
    note('hurt');
  } else if (d.type === 'breath') {   // ドラゴンの炎: ごおっ
    const v = voice(d.y, d.x, { h: 0.6, send: 0.7 });
    burst(v.inp, t, { f: 300, type: 'lowpass', q: 0.5, dur: 0.9, gain: 4.5, attack: 0.15, f2: 1400 });
    burst(v.inp, t + 0.1, { f: 2500, q: 0.6, dur: 0.7, gain: 1.5, attack: 0.2 });
    note('breath');
  } else if (d.type === 'freeze') {   // 凍る: ぴきぴき
    const v = voice(p[0], p[1], { h: 0.6, occl: false, send: 0.4, model: 'equalpower' });
    for (let i = 0; i < 7; i++) burst(v.inp, t + 0.1 + i * rnd(0.03, 0.08), { f: rnd(4000, 7000), q: 4, dur: 0.03, gain: 0.3 });
    note('freeze');
  } else if (d.type === 'gaze') {   // にらみ: 低くうなる
    const v = voice(d.y, d.x, { h: 0.7, send: 0.6 });
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(110, t); o.frequency.linearRampToValueAtTime(70, t + 0.8);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.25, t + 0.2); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.9);
    o.connect(g); g.connect(v.inp); o.start(t); o.stop(t + 1);
    note('gaze');
  } else if (d.type === 'throw') {   // 投げる・放つ（飛んでいく音は missile で、道筋に沿って動かす）
    lastThrow = { at: performance.now(), w: d.w, ch: d.ch, fired: !!d.fired };
    const v = voice(p[0], p[1], { h: 0.6, occl: false, send: 0.3, model: 'equalpower' });
    if (d.fired) {   // 弓の弦: 引き絞って（きりっ）放つ（びぃん）
      creak(v.inp, t, { dur: 0.18, gain: 0.25 });
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.setValueAtTime(140, t + 0.22); o.frequency.exponentialRampToValueAtTime(105, t + 0.5);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t + 0.22); g.gain.linearRampToValueAtTime(0.35, t + 0.225); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.55);
      o.connect(g); g.connect(v.inp); o.start(t + 0.22); o.stop(t + 0.6);
      burst(v.inp, t + 0.22, { f: 1800, q: 2, dur: 0.04, gain: 0.3 });
    } else burst(v.inp, t + 0.05, { f: 600, q: 1.2, dur: 0.18, gain: 0.8, attack: 0.08, f2: 1500 });   // 腕を振る
    note('throw');
  } else if (d.type === 'descend') {   // 階段: 段を下りる・上る足音／落とし穴: ひゅっ → どさっ
    const v = voice(p[0], p[1], { h: 0.1, occl: false, send: 0.6, model: 'equalpower' });
    if (d.how === 'fall') {
      burst(v.inp, t, { f: 600, q: 0.7, dur: 0.5, gain: 0.3, attack: 0.2, f2: 1800 });
      thump(v.inp, t + 0.62, { f: 60, dur: 0.3, gain: 0.45 });
    } else {
      for (let i = 0; i < 4; i++) { thump(v.inp, t + i * 0.2, { f: 100 - i * 6, dur: 0.07, gain: 0.25 }); burst(v.inp, t + i * 0.2, { f: 1600, q: 1.4, dur: 0.04, gain: 0.5 }); }
    }
    note('descend');
  } else if (d.type === 'teleport') {   // テレポート: 空気が引き裂かれる
    const v = voice(p[0], p[1], { h: 0.6, occl: false, send: 0.6, model: 'equalpower' });
    burst(v.inp, t, { f: 6000, q: 2, dur: 0.5, gain: 0.3, attack: 0.05, f2: 400 });
    note('teleport');
  } else if (d.type === 'secretdoor') {   // 隠し扉が開く: 留め金が外れる → 石の戸が重くずれる → 砂がこぼれる（扉の場所から）
    for (const [y, x] of d.cells || []) {
      const v = voice(y, x, { h: 0.6, occl: false, send: 0.7 });
      const o = v.inp;
      thump(o, t, { f: 260, dur: 0.05, gain: 0.25, drop: 0.7 });   // かちっ
      burst(o, t, { f: 3200, q: 3, dur: 0.03, gain: 0.5 });
      const t1 = t + 0.18;
      thump(o, t1, { f: 48, dur: 0.9, gain: 0.35, drop: 0.8 });   // ごご…: 低いうなりに、ざらついたこすれを細かく重ねる
      for (let i = 0; i < 14; i++) burst(o, t1 + i * 0.055 + rnd(0, 0.02), { f: rnd(250, 520), q: 1.2, dur: 0.12, gain: rnd(0.9, 1.6), attack: 0.02 });
      thump(o, t1 + 0.8, { f: 70, dur: 0.18, gain: 0.45 });   // ずん（止まる）
      for (let i = 0; i < 6; i++) burst(o, t1 + 0.9 + i * rnd(0.05, 0.14), { f: rnd(3000, 6000), q: 2.5, dur: 0.03, gain: rnd(0.12, 0.3) });   // ぱらぱら
    }
    note('secretdoor');
  } else if (d.type === 'bolt') {   // 次に飛ぶのは杖の光線（missile で鳴らす）
    pendingBolt = { at: performance.now(), name: d.name };
    return;
  } else if (d.type === 'land') {   // 投げた物が落ちた・割れた（落ちた所から）
    const v = voice(d.y, d.x, { h: 0.05, send: 0.6 });
    const at = t + 0.02;
    if (d.broke) {   // 瓶が割れる: ぱりん＋破片＋しぶき
      for (let i = 0; i < 4; i++) glass(v.inp, at + i * rnd(0, 0.03), 0.4, rnd(2600, 4200));
      burst(v.inp, at, { f: 5000, q: 0.8, dur: 0.12, gain: 0.6 });
      for (let i = 0; i < 6; i++) burst(v.inp, at + 0.08 + i * rnd(0.02, 0.06), { f: rnd(4000, 8000), q: 3, dur: 0.02, gain: 0.2 });
      burst(v.inp, at + 0.03, { f: 900, q: 0.7, dur: 0.2, gain: 0.25, attack: 0.02 });
    } else {
      thing(v.inp, at, d.ch, d.w, false);
      if (d.ch === ')' && d.w !== 2) thing(v.inp, at + rnd(0.12, 0.2), d.ch, d.w, true);   // 金物は一度はねる
    }
    note('land');
  } else if (d.type === 'act') {   // 自分の手元の動作
    const v = voice(p[0], p[1], { h: 0.6, occl: false, send: 0.3, model: 'equalpower' });
    const o = v.inp;
    act(o, t, d);
    note('act:' + d.what);
  }
}

// 手元の動作の音（どれも画面のメッセージで分かることだけ。音でしか分からないことは鳴らし分けない）
function act(o, t, d) {
  const w = d.w;
  if (d.what === 'pickup') {   // 拾う: 床から取り上げて袋へ（物ごとの音・最後に袋がさっ）
    (d.chs || []).slice(0, 4).forEach((ch, i) => thing(o, t + i * 0.12, ch, -1, true));
    burst(o, t + 0.15 + Math.min(4, (d.chs || []).length) * 0.12, { f: 700, q: 0.8, dur: 0.12, gain: 0.25, attack: 0.03 });
  } else if (d.what === 'drop') {   // 置く: 袋から出して足元へ
    burst(o, t, { f: 700, q: 0.8, dur: 0.1, gain: 0.2, attack: 0.03 });
    thing(o, t + 0.15, d.ch, w, true);
  } else if (d.what === 'eat') {   // 食べる: かじる → 数回噛む → 飲み込む。粘菌はやわらかく湿った音、食料（乾パン）は乾いて固い
    const slime = w === 1;
    for (let i = 0; i < 6; i++) {
      const at = t + 0.1 + i * rnd(0.2, 0.26);
      if (slime) { burst(o, at, { f: rnd(500, 900), q: 2, dur: 0.09, gain: 0.25, attack: 0.02 }); thump(o, at, { f: 110, dur: 0.06, gain: 0.12 }); }
      else { for (let j = 0; j < 3; j++) burst(o, at + j * 0.015, { f: rnd(1800, 4000), q: 1.5, dur: 0.025, gain: i ? 0.18 : 0.3 }); thump(o, at, { f: 90, dur: 0.05, gain: 0.15 }); }
    }
    gulp(o, t + 1.55, 0.3);
  } else if (d.what === 'quaff') {   // 飲む: 栓を抜く（ぽん）→ ごくごく → 瓶を下ろす
    pop(o, t);
    for (let i = 0; i < 3; i++) gulp(o, t + 0.25 + i * 0.22, 0.25);
    glass(o, t + 0.95, 0.06);
  } else if (d.what === 'read') {   // 読む: 巻物を広げる（ばさっ→かさかさ）
    burst(o, t, { f: 2000, q: 0.6, dur: 0.12, gain: 0.25, attack: 0.03 });
    rustle(o, t + 0.05, { n: 12, span: 0.45, gain: 0.22 });
  } else if (d.what === 'wield') {   // 持つ: 剣は鞘から抜く（しゃりーん）、弓は木がこつ、棍棒・槍は柄を握る
    if (w === 1 || w === 4 || w === 5) {
      burst(o, t, { f: 3000, q: 4, dur: 0.35, gain: 0.25, attack: 0.25, f2: 6000 });
      tink(o, t + 0.34, { f: w === 5 ? 900 : 1500, dur: 0.6, gain: 0.1 });
    } else if (w === 2) { creak(o, t, { dur: 0.2, gain: 0.25 }); thump(o, t + 0.15, { f: 200, dur: 0.05, gain: 0.2 }); }
    else { burst(o, t, { f: 600, q: 1.2, dur: 0.1, gain: 0.2 }); thump(o, t + 0.05, { f: 160, dur: 0.06, gain: 0.25 }); }
  } else if (d.what === 'sheathe') {   // しまう: 剣は鞘に納める（しゃっ→かちん）
    if (w === 1 || w === 4 || w === 5) { burst(o, t, { f: 5000, q: 4, dur: 0.25, gain: 0.2, attack: 0.05, f2: 2800 }); tink(o, t + 0.26, { f: 1200, dur: 0.15, gain: 0.12 }); }
    else burst(o, t, { f: 700, q: 0.8, dur: 0.12, gain: 0.2, attack: 0.03 });
  } else if (d.what === 'wear' || d.what === 'takeoff') {   // 着る・脱ぐ: 革はきしみと留め具、金属鎧はじゃらじゃら
    const leather = w === 0 || w === 2, n = d.what === 'wear' ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const at = t + i * rnd(0.18, 0.28);
      if (leather) creak(o, at, { dur: 0.2, gain: 0.25 });
      else for (let j = 0; j < 4; j++) tink(o, at + j * rnd(0.01, 0.03), { f: rnd(1600, 2800), dur: 0.12, gain: 0.06 });
      burst(o, at, { f: 800, q: 0.8, dur: 0.12, gain: 0.15, attack: 0.04 });
    }
    tink(o, t + n * 0.24, { f: 2200, dur: 0.12, gain: 0.08 });   // 留め具がかちっ
  } else if (d.what === 'puton') tink(o, t + 0.05, { f: 3600, dur: 0.25, gain: 0.07 });   // 指輪: 指に通すときの小さな金物
  else if (d.what === 'remove') tink(o, t + 0.05, { f: 3300, dur: 0.2, gain: 0.06 });
  else if (d.what === 'zap') {   // 杖を振る: 細い木の棒がひゅっ（剣より軽く高い）
    burst(o, t, { f: 1500, q: 2, dur: 0.12, gain: 0.6, attack: 0.05, f2: 3500 });
  }
}
// 栓を抜く: ぽん
function pop(out, t) {
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(350, t + 0.05);
  const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.07);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.1);
  burst(out, t, { f: 1500, q: 1, dur: 0.03, gain: 0.2 });
}
// 飲み込む: のどがごくっ
function gulp(out, t, gain) {
  const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.09);
  const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.15);
  burst(out, t, { f: 400, type: 'lowpass', dur: 0.08, gain: gain * 0.5 });
}

// 飛んでいく物の音: 道筋に沿って音の出どころを動かす（横を飛べば左右に流れて聞こえる）
let lastThrow = null, pendingBolt = null;
export function missile(m) {
  if (!ready() || !m.path || !m.path.length) return;
  const p = scene().player;
  if (!p) return;
  wake();
  const now = performance.now(), t = ctx.currentTime + 0.01, dur = m.step * m.path.length / 1000;
  const bolt = pendingBolt && now - pendingBolt.at < 3000 ? pendingBolt.name : null;
  pendingBolt = null;
  const th = !bolt && lastThrow && now - lastThrow.at < 3000 ? lastThrow : null;
  // 動く音の出どころ（HRTF。壁越しにはならない: 見えている道筋を飛ぶ）
  const inp = ctx.createGain();
  const pan = ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 1; pan.rolloffFactor = 0.8;
  const pts = [p, ...m.path];
  if (pan.positionX) {
    pts.forEach(([y, x], i) => {
      const at = t + i * m.step / 1000;
      if (i === 0) { pan.positionX.setValueAtTime(x + 0.5, at); pan.positionZ.setValueAtTime(y + 0.5, at); pan.positionY.setValueAtTime(0.55, at); }
      else { pan.positionX.linearRampToValueAtTime(x + 0.5, at); pan.positionZ.linearRampToValueAtTime(y + 0.5, at); }
    });
  } else { const [y, x] = pts[pts.length >> 1]; pan.setPosition(x + 0.5, 0.55, y + 0.5); }
  inp.connect(pan); pan.connect(dry);
  const s = ctx.createGain(); s.gain.value = 0.4; inp.connect(s); s.connect(convA); s.connect(convB);
  const D = Math.max(0.08, dur);
  if (bolt === 'fire') {   // 炎の光線: ごおっと燃えながら飛ぶ
    burst(inp, t, { f: 400, type: 'lowpass', q: 0.5, dur: D + 0.3, gain: 1.3, attack: 0.05, f2: 1200 });
    burst(inp, t, { f: 2500, q: 0.6, dur: D + 0.2, gain: 0.4, attack: 0.05 });
  } else if (bolt === 'cold') {   // 冷気: 空気が凍るしゃりしゃり
    burst(inp, t, { f: 6000, q: 1, dur: D + 0.2, gain: 1.5, attack: 0.05 });
    for (let i = 0; i < 10; i++) burst(inp, t + Math.random() * D, { f: rnd(5000, 9000), q: 4, dur: 0.02, gain: 0.6 });
  } else if (bolt === 'electric') {   // 稲妻: ばりっと裂ける音とごろごろ
    for (let i = 0; i < 8; i++) burst(inp, t + Math.random() * D * 0.6, { f: rnd(2000, 7000), q: 0.7, dur: 0.03, gain: 0.7 });
    thump(inp, t + 0.02, { f: 55, dur: D + 0.6, gain: 0.5, drop: 0.7 });
  } else if (bolt) {   // 魔法の矢など: 空気を押しのけるしゅうっ
    burst(inp, t, { f: 1200, q: 1.5, dur: D + 0.1, gain: 1.0, attack: 0.03, f2: 2400 });
  } else if (th && (th.w === 3 || th.w === 6 || th.w === 7 || th.w === 8 || th.w === 4)) {   // 矢・ダーツ・手裏剣・槍・短剣: 空を切る
    burst(inp, t, { f: th.w === 7 ? 3500 : 2200, q: th.w === 7 ? 6 : 3, dur: D, gain: 0.7, attack: D * 0.3 });
  } else {   // ほかの物: かすかな風
    burst(inp, t, { f: 800, q: 1, dur: D, gain: 0.3, attack: D * 0.3 });
  }
  note(bolt ? 'bolt:' + bolt : 'fly');
}


// 怪物が動いた: 同じ並び（ゲームのモンスターの並び）で前と比べ、1〜2 マス動いたものに足音
function monsMoved(mons) {
  const prev = prevMons;
  prevMons = mons;
  if (!prev || prev.length !== mons.length || !ready()) return;
  const p = scene().player;
  if (!p) return;
  let n = 0;
  mons.forEach((m, i) => {
    const o = prev[i];
    const [y, x, , , letter] = m;
    const d = Math.max(Math.abs(o[0] - y), Math.abs(o[1] - x));
    if (d < 1 || d > 2) return;   // 動いていない・遠くへ飛んだ
    if (Math.hypot(y - p[0], x - p[1]) > HEAR_MAX) return;
    if (n >= 6) return;   // 一度にたくさん鳴らさない（宝物部屋など）
    for (let k = 0; k < d; k++) monStep(y, x, letter || '?', n * 0.035 + k * 0.12);
    n++;
  });
  if (n) { wake(); note('mon' + n); }
}
