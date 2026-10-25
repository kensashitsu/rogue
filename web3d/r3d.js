// 3D 表示（試作）: ゲームが送ってくる 80×24 の画面から、プレイヤーが知っている地図を立体にして一人称で描く。
// ゲームの中身には手を入れない。見えているもの・覚えているものは 2D 版の画面と同じ
//   - 描き方は ASCII だけ: 場面を升目の粗さで描いて、升目ごとに端末の字へ置き換える（drawTerm）
//   - 壁（- |）・岩・床・通路（#）・扉（+）・天井・下り階段の段・罠は、面の種類として書き出し、字の濃さで描く
//   - モンスターとアイテムは、その字で編んだ形（ART）を升目に重ねる
//   - 向きはこちらで持つ（8 方向）。前へ進むボタンは、向いている方向のキー（h j k l y u b n）に直して送る

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const W = 80, MAP_TOP = 1, MAP_BOT = 22;
const DIRS = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];   // 北から右回り (dy, dx)
const KEYS = ['k', 'u', 'l', 'n', 'j', 'b', 'h', 'y'];
const PALETTE = ['#0b0d0f', '#ff6a5c', '#7fd17a', '#f0c652', '#6f9df2', '#d58cf0', '#6cc6d6', '#c8ccd1'];
const EYE = 0.55;

let facing = 0;
try { facing = +localStorage.getItem('rogue3d-facing') || 0; } catch {}
export const getFacing = () => facing;
export const keyFor = rel => KEYS[(facing + rel + 8) % 8];   // rel: 0 = 前、2 = 右、4 = 後ろ、6 = 左

// ---------------------------------------------------------------------------
// 場面
// ---------------------------------------------------------------------------
let renderer, scene, camera, cv;
const MAX = W * (MAP_BOT - MAP_TOP + 1);
let hwalls, vwalls, rocks, floors, dirts, doors, ceils;
let meshes = {}, tcv, tctx;
const DECALS = { '^': { mesh: 'traps', color: '#d58cf0' } };   // 床に描く字: 罠（色は 2D の画面の色に合わせる）
let stairsColor = '#6cc6d6';   // 階段の色（2D の画面の % の色に合わせる）
const STEPS = 4, STEP_DROP = 0.22;   // 下り階段の段の数と、1 段で下がる高さ
const DIM_AHEAD = 0.16;   // まだ分からない 1 マス先を描く暗さ（覚えている所は 0.38、見えている所は 1）
const flying = new Set();   // 飛んでいる最中の物（投げた物）
// 隠し扉の場所（ゲームが階ごとに知らせる）。近くで見ると、その壁の点描にかすかなひび（,）が混じる。
// 原作では見つけるまで見分けがつかない。ユーザーの指定による意図的な改変（2026-10-22）
let secretCells = new Set();
const SECRET_NEAR = 2.6;   // この距離より近いときだけ違って見える
// まだ見つけていない罠の場所と、モンスターの様子（ゲームが知らせる）。これも 3D 版だけの意図的な改変（2026-10-22）
//   - 罠: 近くで見ると、その床の . が , に見える（遠くでは普通の床）
//   - 眠っているモンスター: 目を閉じて（* の代わりに -）、頭の上に z
//   - 傷ついたモンスター: 体力が半分を切ると、形の升が欠けていく
let trapCells = new Set(), monState = new Map(), monList = [];
// 部屋（壁の上下左右と、暗い部屋か）。明るい部屋の壁には燭台を灯す。暗い部屋には燭台を置かない（火の消えた燭台があると、灯せそうに見える。2026-10-23 ユーザー指定）
let rooms = [], sconces = [];
const SCONCE_GAP = 4;   // 燭台を置く間隔（マス）
// アミュレットを持っている間は、階段を上り階段に描く（段が北へ上っていき、天井に口が開いて上の階へ抜ける）
let upStairs = false;
let stairAt = { level: '', cell: -1 };
const STEP_RISE = 0.25;   // 上り階段の 1 段の高さ（4 段で天井に届く）
let edgeSegs = [], edgeBright = [];   // 壁の輪郭の線分（x, y, z の組を 2 つずつ）と、その明るさ
const glyphGroup = new THREE.Group();   // モンスター・アイテムの位置（描くのは drawTerm。札そのものは見せない）
const dummy = new THREE.Object3D();
const color = new THREE.Color();
const SPRITE_MAT = new THREE.SpriteMaterial({ visible: false });

function instanced(geo) {
  const m = new THREE.InstancedMesh(geo, undefined, MAX);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.count = 0; m.frustumCulled = false;   // 置く場所を毎回変えるので、まとめての見切り判定はしない
  scene.add(m); return m;
}

export function init(canvas) {
  cv = canvas;
  cv.style.visibility = 'hidden';   // 3D の画面は升目の粗さで裏に描くだけ。見せるのは字の画面
  tcv = document.createElement('canvas');
  tcv.id = 'v3t'; tcv.setAttribute('aria-hidden', 'true');
  canvas.after(tcv);
  tctx = tcv.getContext('2d');
  initFx(canvas);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(72, 1, 0.05, 40);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const ceil = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
  // 材質は「何の面か」を書き出すだけ（kindMat の番号: 1 壁、3 岩、4 床、5 通路、6 扉、7 天井、8 階段の段、9 罠）
  meshes = {
    hwalls: instanced(box), vwalls: instanced(box), rocks: instanced(box),
    floors: instanced(plane), dirts: instanced(plane), doors: instanced(box),   // doors: 戸口の枠と開いた扉の板
    ceils: instanced(ceil), traps: instanced(plane), secrets: instanced(box),   // secrets: 隠し扉の壁
    hintF: instanced(plane), hintC: instanced(plane),   // 見つけていない罠の床（部屋 / 通路）
    steps: instanced(box), pits: instanced(box),   // 下り階段の段と、穴の内側の壁
    voids: instanced(box),   // まだ分からない所（部屋の外）: 何も描かないが、向こうを隠す
  };
  const kinds = { secrets: 2, hwalls: 1, vwalls: 1, rocks: 3, floors: 4, dirts: 5, doors: 6, ceils: 7, traps: 9, steps: 8, pits: 1, hintF: 10, hintC: 11 };
  for (const [name, mesh] of Object.entries(meshes)) mesh.material = name === 'voids' ? VOID_MAT : kindMat(kinds[name]);
  ({ hwalls, vwalls, rocks, floors, dirts, doors, ceils } = meshes);
  scene.add(glyphGroup);
  resize();
}

export function resize() {
  if (!renderer) return;
  const w = cv.parentElement.clientWidth, h = cv.parentElement.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  sizeTerm(w, h);
  sizeFx(w, h);
  draw();
}

// ---------------------------------------------------------------------------
// 画面（grid[y][x] = [字, スタイル] / null）から地図を組み直す
// ---------------------------------------------------------------------------
const TERRAIN = new Set(['-', '|', '.', '#', '+', ' ']);
let player = null, lastSig = '', lastGrid = null;

function cellAt(grid, y, x) {
  if (y < MAP_TOP || y > MAP_BOT || x < 0 || x >= W) return [' ', 0];
  return grid[y][x] || [' ', 0];
}

// 確かに岩だと分かっているマス。原作では自分の隣の 8 マスは必ず見えるので、隣にいて何も出ていなかった所は岩。
// まだ隣に立ったことのない所は分からないので、岩にせず闇のままにする（通路の先が行き止まりに見えないように）。
// 階ごとに覚え、続きから遊ぶときのために端末に残す
let rock = new Set(), rockLevel = '';
try { const r = JSON.parse(localStorage.getItem('rogue3d-rock') || '{}'); rockLevel = r.level || ''; rock = new Set(r.cells || []); } catch {}
// 歩いたマス（通路の燭台は、歩いた所にだけ灯っている）。階ごとに覚え、端末に残す
let walked = new Set();
try { const r = JSON.parse(localStorage.getItem('rogue3d-walked') || '{}'); if (r.level === rockLevel) walked = new Set(r.cells || []); } catch {}
const saveWalked = () => { try { localStorage.setItem('rogue3d-walked', JSON.stringify({ level: rockLevel, cells: [...walked] })); } catch {} };
export function forgetRock() {   // 新しく始めるとき（前の冒険の同じ階の岩を引き継がない）
  rock.clear(); rockLevel = '';
  seen.clear(); walked.clear();
  try { localStorage.removeItem('rogue3d-rock'); localStorage.removeItem('rogue3d-seen'); localStorage.removeItem('rogue3d-walked'); } catch {}
}

// 地図に載せるマス: 3D の画面に映った所だけ（前を向いて見た所と、自分の隣）。振り向いて見回すと地図が埋まる。
// 原作は明るい部屋に入ると部屋全体が地図に出る。3D 版だけの意図的な改変（2026-10-22。ユーザー指定）。
// 魔法の地図の巻物を読んだときは、そのとき分かっている所を全部載せる。階ごとに覚え、端末に残す
let seen = new Set();
try { const r = JSON.parse(localStorage.getItem('rogue3d-seen') || '{}'); if (r.level === rockLevel) seen = new Set(r.cells || []); } catch {}
export const isSeen = (y, x) => seen.has(y * W + x);
const saveSeen = () => { try { localStorage.setItem('rogue3d-seen', JSON.stringify({ level: rockLevel, cells: [...seen] })); } catch {} };
function look(grid) {
  if (!player || !camera) return;
  const n0 = seen.size, [py, px] = player;
  for (const [dy, dx] of [[0, 0], ...DIRS]) seen.add((py + dy) * W + px + dx);
  // 画面の横の画角に、少しゆとりを持たせて光線を飛ばす。壁・岩・闇に当たったら、そのマスまで
  const half = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect) + 0.05;
  const [fy, fx] = DIRS[facing], base = Math.atan2(fy, fx);
  for (let a = -half; a <= half; a += 0.012) {
    const dy = Math.sin(base + a), dx = Math.cos(base + a);
    for (let t = 0.3; t < 24; t += 0.08) {
      const y = Math.floor(py + 0.5 + dy * t), x = Math.floor(px + 0.5 + dx * t);
      if (y < MAP_TOP || y > MAP_BOT || x < 0 || x >= W) break;
      seen.add(y * W + x);
      const c = cellAt(grid, y, x)[0];
      if (c === '-' || c === '|' || c === ' ') break;
    }
  }
  if (seen.size !== n0) saveSeen();
}
function learnRock(grid, pos) {
  const status = (grid[23] || []).filter(Boolean).map(c => c[0]).join('');
  const lv = (status.match(/(?:階|Level):\s*(\d+)/) || [])[1];
  if (!lv || !pos) return false;
  let changed = false;
  if (lv !== rockLevel) { rockLevel = lv; rock.clear(); seen.clear(); saveSeen(); walked.clear(); changed = true; }
  const pk = pos[0] * W + pos[1];
  if (!walked.has(pk)) { walked.add(pk); saveWalked(); if (tune.corrGap) changed = true; }
  if (/盲目|Blind/.test(status)) return changed;   // 目が見えないときは隣も見えない
  for (const [dy, dx] of DIRS) {
    const y = pos[0] + dy, x = pos[1] + dx, k = y * W + x;
    if (cellAt(grid, y, x)[0] === ' ' && !rock.has(k)) { rock.add(k); changed = true; }
  }
  if (changed) try { localStorage.setItem('rogue3d-rock', JSON.stringify({ level: rockLevel, cells: [...rock] })); } catch {}
  return changed;
}

export function update(grid, pos) {
  if (!renderer) return;
  const sig = grid.slice(MAP_TOP, MAP_BOT + 1).map(r => r.map(c => c ? c[0] + (c[1] & 512 ? '_' : '') : '').join('')).join('\n');
  const moved = !player || !pos || player[0] !== pos[0] || player[1] !== pos[1];
  const prev = player;
  if (pos) player = pos;
  const lvBefore = rockLevel;
  const learned = learnRock(grid, pos);
  findReveals(grid, lvBefore === rockLevel);
  lastGrid = grid;
  watchHp(grid);
  watchStatus(grid);
  if (sig !== lastSig || learned) { lastSig = sig; build(grid); }
  // 始めたときや、階段・テレポートで遠くへ移ったときは、いちばん先まで歩ける方向を向く
  // テレポートしたかは、ゲームからの知らせ（effect 'teleport'）で見る。位置の飛び方で推し量ると、iPhone で画面が重く
  // 2 歩分がまとめて描かれた時にも遠くへ移ったとみなし、テレポートの演出が出て向きも変わってしまっていた（2026-10-24）
  const teleported = pendingWarp && !!pos && !!prev && (pos[0] !== prev[0] || pos[1] !== prev[1]);
  if (teleported) pendingWarp = false;
  const jumped = pos && (!cam || !prev || teleported);
  if (cam && (teleported || lvBefore !== rockLevel)) {   // 新しい階に着いた（暗転から明ける。落ちてきたなら揺れる）か、同じ階でテレポートした
    const now = performance.now();
    if (trans.how) { if (trans.how === 'fall') fx.shakeT0 = now; trans.how = null; trans.fadeT0 = now; startFx(); }
    else if (teleported && lvBefore === rockLevel) { trans.warpT0 = now; startFx(); }
  }
  if (jumped || lvBefore !== rockLevel) faceOpen(grid);
  look(grid);
  if (moved) startMove();
  draw();
}

// モンスター（大文字）は立たせ、それ以外（アイテム）は床の近くに。描くのは drawTerm（字で編んだ形）。det: 探知で見えている物
function addGlyph(c, s, x, y, det) {
  const fg = (s & 15) ? PALETTE[(s & 15) - 1] : '#c8ccd1';
  const mon = c >= 'A' && c <= 'Z';
  const size = mon ? 0.78 : 0.42;
  const sp = new THREE.Sprite(SPRITE_MAT);
  sp.userData = { ch: c, col: fg, dim: !!(s & 512), cell: y * W + x, det };
  sp.scale.set(size, size, 1);
  sp.position.set(x + 0.5, mon ? 0.42 : 0.24, y + 0.5);
  glyphGroup.add(sp);
}

// ---------------------------------------------------------------------------
// 移り変わりの演出: 階段を下りる（段を下りて暗転）・落とし穴（床を抜けて落ちて暗転、着いたら揺れる）・
// テレポート（同じ階で遠くへ移った直後に、景色の字が乱れて落ち着く）。新しい階は暗転から明ける
// ---------------------------------------------------------------------------
const DESCEND_MS = { stairs: 900, fall: 650, up: 900, win: 1300 }, FADEIN_MS = 400, WARP_MS = 600;
const BRIGHT_TRANS = new Set(['up', 'win']);   // 上るときは白く明るくなって、上の階が白から明ける
const WARP_CHARS = '#%&*+=~:;!?';
// 字の大きさは約 3% 刻みの段に丸める。近さに合わせて連続した大きさで描くと、WebKit が大きさごとに字体のデータを作って溜め、
// iPhone でメモリが足りなくなって落ちた（2026-10-24。1 分で 4700 通り以上の大きさを使っていた）
const fpx = s => Math.round(Math.exp(Math.round(Math.log(Math.max(1, s)) / 0.03) * 0.03) * 10) / 10;
const trans = { how: null, t0: 0, fadeT0: -1e9, warpT0: -1e9, col: '#000' };
let pendingWarp = false;   // ゲームからテレポートの知らせが来て、まだ飛んだ先を描いていない
const transActive = now => (trans.how && now - trans.t0 < DESCEND_MS[trans.how] + 3000) || now - trans.fadeT0 < FADEIN_MS || now - trans.warpT0 < WARP_MS;
// 階段・落とし穴の途中の視点（null なら普段どおり）
function transCamera(now) {
  if (trans.how && now - trans.t0 > DESCEND_MS[trans.how] + 3000) trans.how = null;   // 着いた知らせが来なかったときの戻し
  if (!trans.how || !cam) return null;
  const k = Math.min(1, (now - trans.t0) / DESCEND_MS[trans.how]);
  if (trans.how === 'fall') {   // 床を抜けて、だんだん速く落ちる
    return { x: cam.x, z: cam.z, y: EYE - 2.4 * k * k, yaw: cam.yaw, pitch: 0.25 * k };
  }
  // 階段: 北（段の下りていく・上っていく向き）へ向き直りながら、段を下りる（上る）
  const turnK = Math.min(1, k / 0.35), e = Math.max(0, (k - 0.2) / 0.8);
  const dYaw = ((0 - cam.yaw) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  const up = BRIGHT_TRANS.has(trans.how) ? 1 : -1;
  return { x: cam.x, z: cam.z + 0.3 - e * 1.1, y: EYE + up * e * 1.0, yaw: cam.yaw + dYaw * turnK, pitch: 0.2 * up * e };
}
// 暗さ（0〜1）: 下りる終わりに暗くなり、新しい階で明ける
function transDark(now) {
  if (trans.how) {
    const k = Math.min(1, (now - trans.t0) / DESCEND_MS[trans.how]);
    return Math.max(0, (k - 0.5) / 0.5);
  }
  return Math.max(0, 1 - (now - trans.fadeT0) / FADEIN_MS);
}

// 燭台: 部屋の壁の内側に、角と扉を避けて SCONCE_GAP マスおきに。見えている（画面に出ている）壁にだけ
function buildSconces(grid) {
  sconces = [];
  const wall = (y, x) => '-|'.includes(cellAt(grid, y, x)[0]);
  for (const r of rooms) {
    if (r.dark) continue;
    const add = (y, x, px, pz) => { if (wall(y, x)) sconces.push({ x: px, z: pz, dark: r.dark }); };
    for (let x = r.left + 2; x <= r.right - 2; x += SCONCE_GAP) {
      add(r.top, x, x + 0.5, r.top + 1.03); add(r.bottom, x, x + 0.5, r.bottom - 0.03);
    }
    for (let y = r.top + 2; y <= r.bottom - 2; y += SCONCE_GAP) {
      add(y, r.left, r.left + 1.03, y + 0.5); add(y, r.right, r.right - 0.03, y + 0.5);
    }
  }
  // 通路: 歩いた所の岩の壁に、tune.corrGap マスおきに燭台（歩いて灯してきた明かり。まだ歩いていない通路は闇のまま）
  const gap = tune.corrGap;
  if (!gap) return;
  for (const k of walked) {
    const y = Math.floor(k / W), x = k % W;
    if (cellAt(grid, y, x)[0] !== '#' || (x + y) % gap) continue;
    for (const [dy, dx, px, pz] of [[-1, 0, x + 0.5, y + 0.03], [1, 0, x + 0.5, y + 0.97], [0, -1, x + 0.03, y + 0.5], [0, 1, x + 0.97, y + 0.5]]) {
      if (!rock.has((y + dy) * W + x + dx)) continue;
      sconces.push({ x: px, z: pz, dark: false, corr: true });
      break;
    }
  }
}

function faceOpen(grid) {
  let best = -1;
  for (let f = 0; f < 8; f += 2) {   // 斜めは扉を通れないので、上下左右から選ぶ
    const [dy, dx] = DIRS[f];
    let n = 0, y = player[0], x = player[1];
    for (;;) {
      y += dy; x += dx;
      const c = cellAt(grid, y, x)[0];
      if (c === '-' || c === '|' || c === ' ' || n > 40) break;
      n++;
    }
    if (n > best) { best = n; facing = f; }
  }
  try { localStorage.setItem('rogue3d-facing', facing); } catch {}
}

function build(grid) {
  const ch = (y, x) => cellAt(grid, y, x)[0];
  const walk = c => !TERRAIN.has(c) || c === '.' || c === '#' || c === '+';
  const counts = Object.fromEntries(Object.keys(meshes).map(k => [k, 0]));
  const put = (mesh, name, x, y, z, bright, yaw = 0, sx = 1, sy = 1, sz = 1, at = false) => {
    dummy.position.set(at ? x : x + 0.5, y, at ? z : z + 0.5); dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(sx, sy, sz); dummy.updateMatrix();
    const i = counts[name]++;
    mesh.setMatrixAt(i, dummy.matrix);
    color.r = bright; color.g = cellRoom; color.b = cellMask / 16;
    mesh.setColorAt(i, color);
  };
  let cellRoom = 0, cellMask = 0;
  // 明るい部屋のマス（壁・扉も含む）
  const litRoom = new Uint8Array(W * 24);
  if (tune.roomLight) for (const r of rooms) if (!r.dark) for (let y = r.top; y <= r.bottom; y++) for (let x = r.left; x <= r.right; x++) litRoom[y * W + x] = 1;
  const isWall = (y, x) => { const c = ch(y, x); return c === '-' || c === '|' || (c === ' ' && rock.has(y * W + x)); };
  glyphGroup.clear();
  const solid = new Float32Array(W * 24);   // 壁・岩のマス（値は明るさ）。輪郭線を引くのに使う
  const stairCells = [], doorCells = [];
  const aheadRocks = new Set();   // 1 マス先へ延ばした通路の脇の岩
  // まだ分からない所（部屋の外）。何もないとして素通しにすると、通路の先の闇越しに遠くの明るい部屋が見えてしまった（2026-10-26）。
  // 本当は岩の中なので、見えない「ふた」を置いて向こうを隠す。部屋の中（暗い部屋のまだ見ていない床）は今までどおり開けておく
  const voidCells = [];
  const inRoom = new Uint8Array(W * 24);
  for (const r of rooms) for (let y = r.top; y <= r.bottom; y++) for (let x = r.left; x <= r.right; x++) inRoom[y * W + x] = 1;
  for (let y = MAP_TOP; y <= MAP_BOT; y++) {
    for (let x = 0; x < W; x++) {
      let [c, s] = cellAt(grid, y, x);
      cellRoom = litRoom[y * W + x];
      cellMask = tune.ao ? (isWall(y - 1, x) ? 1 : 0) + (isWall(y + 1, x) ? 2 : 0) + (isWall(y, x - 1) ? 4 : 0) + (isWall(y, x + 1) ? 8 : 0) : 0;
      // 階段の上に立っている間も、足もとの階段を描く（画面では @ に隠れるので、見えたときの場所を覚えておく）
      if (c === '%') stairAt = { level: rockLevel, cell: y * W + x };
      let onStairs = false;
      if (c === '@' && stairAt.level === rockLevel && stairAt.cell === y * W + x) { c = '%'; s = 0; onStairs = true; }
      const bright = s & 512 && !cellRoom ? 0.38 : 1;   // 覚えているだけの所は暗く（明るい部屋は離れても灯ったまま）
      if ((c === '-' || c === '|') && secretCells.has(y * W + x)) { put(meshes.secrets, 'secrets', x, 0.5, y, bright); solid[y * W + x] = bright; continue; }
      if (c === '-') { put(hwalls, 'hwalls', x, 0.5, y, bright); solid[y * W + x] = bright; continue; }
      if (c === '|') { put(vwalls, 'vwalls', x, 0.5, y, bright); solid[y * W + x] = bright; continue; }
      if (c === ' ') {
        // 何もない所: 隣に立って確かめた岩だけを岩にする（通路の壁）。まだ分からない所や、暗い部屋のまだ見ていない床は闇のまま
        if (!rock.has(y * W + x)) {
          let ahead = false;
          // まだ分からない 1 マス先: 隣の歩いた床と同じ床・天井を暗く描き、通路なら両脇の岩も暗く延ばす。
          // 闇へうっすら続いて見せるだけで、本当の地形は使わない（行き止まりでも同じに見える）
          for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const n = ch(y - dy, x - dx);   // 来た側の隣
            if (!(walk(n) || n === '@')) continue;
            if (n === '#') put(dirts, 'dirts', x, 0, y, DIM_AHEAD); else put(floors, 'floors', x, 0, y, DIM_AHEAD);
            put(ceils, 'ceils', x, 1, y, DIM_AHEAD);
            ahead = true;
            for (const [py, px] of [[dx, dy], [-dx, -dy]]) {   // 進む向きの左右
              if (rock.has((y - dy + py) * W + (x - dx + px)) && ch(y + py, x + px) === ' ' && !rock.has((y + py) * W + (x + px)))
                aheadRocks.add((y + py) * W + (x + px));
            }
            break;
          }
          if (!ahead && !inRoom[y * W + x]) voidCells.push(y * W + x);
          continue;
        }
        let byRoom = false;
        for (const [dy, dx] of DIRS) if (ch(y + dy, x + dx) === '.' && (dy === 0 || dx === 0)) byRoom = true;
        if (!byRoom) { put(rocks, 'rocks', x, 0.5, y, 0.8); solid[y * W + x] = 0.5; }
        continue;
      }
      if (!walk(c) && c !== '@') continue;
      // 探知の薬・魔法探知で一時的に出た字（反転）。まだ見ていない所なら床を作らず、形だけを置く（壁越しに透けて見える）
      const det = !!(s & 2048) && c !== '@' && !TERRAIN.has(c);
      if (det && !seen.has(y * W + x)) { addGlyph(c, s, x, y, true); continue; }
      // 床: 通路か部屋か。文字の下は周りから決める
      let corr = c === '#';
      if (c !== '#' && c !== '.' && c !== '+') {
        const ns = [ch(y - 1, x), ch(y + 1, x), ch(y, x - 1), ch(y, x + 1)];
        corr = ns.includes('#') && !ns.includes('.');
      }
      if (c === '%') {
        // 下り階段: 床の代わりに穴。北（奥）へ向かって段が下りていく
        const st = (s & 15) ? PALETTE[(s & 15) - 1] : stairsColor;
        stairsColor = st;
        if (upStairs) {
          // 上り階段: 南の端から北へ段が上り、天井の口から上の縦穴へ抜ける。
          // 段の上に立っている間は段を描かない（視点が段の中に埋まるので）。床と、頭の上の口だけ
          if (onStairs) put(floors, 'floors', x, 0, y, bright);
          else for (let i = 0; i < STEPS; i++) {
            const top = STEP_RISE * (i + 1), z1 = y + 1 - (i + 1) / STEPS;
            put(meshes.steps, 'steps', x + 0.5, top / 2, z1 + 0.5 / STEPS, bright, 0, 1, top, 1 / STEPS, true);
          }
          for (const [px, pz, sx, sz] of [[x + 0.5, y + 0.02, 1, 0.04], [x + 0.5, y + 0.98, 1, 0.04], [x + 0.02, y + 0.5, 0.04, 1], [x + 0.98, y + 0.5, 0.04, 1]])
            put(meshes.pits, 'pits', px, 1.6, pz, 1, 0, sx, 1.2, sz, true);   // 天井の上の縦穴（明るく）
          stairCells.push([y, x, bright]);
          continue;
        }
        for (let i = 0; i < STEPS; i++) {
          const top = -STEP_DROP * (i + 1), z1 = y + 1 - (i + 1) / STEPS;
          put(meshes.steps, 'steps', x + 0.5, (top - 1.2) / 2, z1 + 0.5 / STEPS, bright, 0, 1, top + 1.2, 1 / STEPS, true);
        }
        for (const [px, pz, sx, sz] of [[x + 0.5, y + 0.02, 1, 0.04], [x + 0.5, y + 0.98, 1, 0.04], [x + 0.02, y + 0.5, 0.04, 1], [x + 0.98, y + 0.5, 0.04, 1]])
          put(meshes.pits, 'pits', px, -0.6, pz, bright * 0.8, 0, sx, 1.2, sz, true);
        stairCells.push([y, x, bright]);
      } else if (c === '+') {
        // 扉: 床は普通の床。壁の向きに合わせて、部屋側の縁に細い戸口の枠（左右の柱と上の横木）を付ける。
        // 開いた扉の板も立てていたが、斜めから見ると戸口の向こうを隠すのでやめた
        put(floors, 'floors', x, 0, y, bright);
        const wallEW = '-|'.includes(ch(y, x - 1)) || '-|'.includes(ch(y, x + 1));   // 壁が東西に続く（通り抜けは南北）
        const out = (c2) => c2 === '#' || c2 === ' ';   // 部屋の外（通路・闇）
        const side = wallEW ? (out(ch(y + 1, x)) ? -1 : 1) : (out(ch(y, x + 1)) ? -1 : 1);   // 部屋のある側
        doorCells.push([y, x, bright, wallEW, side]);
        const [ux, uz] = wallEW ? [1, 0] : [0, 1];   // 戸口の幅の向き
        const [nx, nz] = wallEW ? [0, side] : [side, 0];   // 部屋へ向かう向き
        const cx = x + 0.5, cz = y + 0.5, J = 0.06, TOP = 0.86, D = 0.12;   // 柱の幅、戸口の高さ、枠の奥行き
        const fx = cx + nx * (0.5 - D / 2), fz = cz + nz * (0.5 - D / 2);   // 枠は部屋側の縁に、額縁のように薄く付ける
        for (const k of [-1, 1])   // 左右の柱
          put(doors, 'doors', fx + ux * k * (0.5 - J / 2), 0.5, fz + uz * k * (0.5 - J / 2), bright, 0, wallEW ? J : D, 1, wallEW ? D : J, true);
        put(doors, 'doors', fx, (TOP + 1) / 2, fz, bright, 0, wallEW ? 1 : D, 1 - TOP, wallEW ? D : 1, true);   // 上の横木
      }
      else if (corr) put(dirts, 'dirts', x, 0, y, bright); else put(floors, 'floors', x, 0, y, bright);
      if (trapCells.has(y * W + x) && c !== '^') put(meshes[corr ? 'hintC' : 'hintF'], corr ? 'hintC' : 'hintF', x, 0.004, y, bright);
      if (!(c === '%' && upStairs)) {   // 上り階段の上は天井に口が開いている
        const rm = rooms.find(r => y > r.top && y < r.bottom && x > r.left && x < r.right);
        const m0 = cellMask; cellMask = rm ? (rm.right - rm.left > rm.bottom - rm.top ? 1 : 2) : 0;   // 天井の梁は部屋の短い向きに渡す（通路にはない）
        put(ceils, 'ceils', x, 1, y, bright);
        cellMask = m0;
      }
      if (TERRAIN.has(c) || c === '@') continue;
      const fg = (s & 15) ? PALETTE[(s & 15) - 1] : '#c8ccd1';
      if (c === '%') continue;
      const dc = DECALS[c];
      if (dc) {   // 罠は床に描く
        put(meshes[dc.mesh], dc.mesh, x, 0.006, y, bright, yawOf(facing));   // 字の上を向いている方へ
        dc.color = fg;
        continue;
      }
      addGlyph(c, s, x, y, det);
    }
  }
  cellRoom = 0; cellMask = 0;
  for (const k of aheadRocks) {
    const y = Math.floor(k / W), x = k % W;
    put(rocks, 'rocks', x, 0.5, y, DIM_AHEAD); solid[k] = DIM_AHEAD;
  }
  for (const k of voidCells) if (!aheadRocks.has(k)) put(meshes.voids, 'voids', k % W, 0.5, Math.floor(k / W), 0);
  buildEdges(solid, stairCells, doorCells);
  buildSconces(grid);
  // 明るい部屋の扉の口から、通路へ光が漏れる（口の少し外に弱い光源を置く）
  lamps = [];
  for (const [y, x, , wallEW, side] of doorCells) {
    if (!litRoom[y * W + x] && !rooms.some(r => !r.dark && y >= r.top && y <= r.bottom && x >= r.left && x <= r.right)) continue;
    const [nx, nz] = wallEW ? [0, side] : [side, 0];
    lamps.push({ x: x + 0.5 - nx * 0.45, y: 0.45, z: y + 0.5 - nz * 0.45, w: 0.75 });
  }
  setLights();
  for (const [name, mesh] of Object.entries(meshes)) {
    mesh.count = counts[name];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

// 壁・岩の面のうち、開いた側を向いた面の輪郭を線にする。床と天井との境目は面ごとに、
// 縦の線は面が途切れる所（部屋の角・通路の曲がり角）にだけ引く（マスごとに引くと格子になってうるさい）
function buildEdges(solid, stairCells = [], doorCells = []) {
  const pos = [], bri = [];
  const isSolid = (y, x) => y >= MAP_TOP && y <= MAP_BOT && x >= 0 && x < W && solid[y * W + x] > 0;
  const line = (ax, ay, az, bx, by, bz, b) => {
    pos.push(ax, ay, az, bx, by, bz);
    bri.push(b);
  };
  for (let y = MAP_TOP; y <= MAP_BOT; y++) for (let x = 0; x < W; x++) {
    const b = solid[y * W + x]; if (!b) continue;
    for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      if (isSolid(y + dy, x + dx)) continue;
      const py = dx, px = dy;                       // 面に沿った向き
      const fx = x + 0.5 + dx * 0.505, fz = y + 0.5 + dy * 0.505;   // 面の中心（面の手前に少し浮かせる）
      const ax = fx - px * 0.5, az = fz - py * 0.5, bx = fx + px * 0.5, bz = fz + py * 0.5;
      line(ax, 0.002, az, bx, 0.002, bz, b);
      line(ax, 0.998, az, bx, 0.998, bz, b);
      for (const sgn of [-1, 1]) {
        const sy = y + py * sgn, sx = x + px * sgn;
        if (isSolid(sy, sx) && !isSolid(sy + dy, sx + dx)) continue;   // 面が隣へ続く
        const vx = sgn < 0 ? ax : bx, vz = sgn < 0 ? az : bz;
        line(vx, 0, vz, vx, 1, vz, b);
      }
    }
  }
  // 扉: 戸口の内側の角（柱と横木）
  for (const [y, x, b, wallEW, side] of doorCells) {
    const [ux, uz] = wallEW ? [1, 0] : [0, 1], [nx, nz] = wallEW ? [0, side] : [side, 0];
    const cx = x + 0.5, cz = y + 0.5, J = 0.06, TOP = 0.86, at = (u, n) => [cx + ux * u + nx * n, cz + uz * u + nz * n];
    for (const n of [0.5 - 0.12, 0.5]) {   // 枠は部屋側の縁だけ（奥行き 0.12）
      const [ax, az] = at(-0.5 + J, n), [bx, bz] = at(0.5 - J, n);
      line(ax, 0, az, ax, TOP, az, b); line(bx, 0, bz, bx, TOP, bz, b);   // 柱の内側の角
      line(ax, TOP, az, bx, TOP, bz, b);                                 // 横木の下の角
    }
  }
  // 上り階段: 天井の口の縁と、段の角（踏み面の先と、蹴込みの下）
  if (upStairs) for (const [y, x, b] of stairCells) {
    line(x, 0.996, y, x + 1, 0.996, y, b); line(x, 0.996, y + 1, x + 1, 0.996, y + 1, b);
    line(x, 0.996, y, x, 0.996, y + 1, b); line(x + 1, 0.996, y, x + 1, 0.996, y + 1, b);
    for (let i = 0; i < STEPS; i++) {
      const z0 = y + 1 - i / STEPS;
      line(x, STEP_RISE * (i + 1), z0, x + 1, STEP_RISE * (i + 1), z0, b);   // この段の踏み面の先
      line(x, STEP_RISE * i, z0, x + 1, STEP_RISE * i, z0, b);               // 蹴込みの下
    }
  }
  // 下り階段: 穴の縁と、段の角（踏み面の先と、蹴込みの下）
  if (!upStairs) for (const [y, x, b] of stairCells) {
    line(x, 0.004, y, x + 1, 0.004, y, b); line(x, 0.004, y + 1, x + 1, 0.004, y + 1, b);
    line(x, 0.004, y, x, 0.004, y + 1, b); line(x + 1, 0.004, y, x + 1, 0.004, y + 1, b);
    for (let i = 0; i < STEPS; i++) {
      const z0 = y + 1 - i / STEPS, upper = -STEP_DROP * i, top = -STEP_DROP * (i + 1);
      line(x, upper, z0, x + 1, upper, z0, b);   // 一段上の踏み面の先
      line(x, top, z0, x + 1, top, z0, b);       // この段の蹴込みの下
    }
  }
  edgeSegs = pos; edgeBright = bri;

}

// ---------------------------------------------------------------------------
// ASCII の見た目: 場面を升目と同じ粗さ（1 升 = 1 画素）で描き、読み出した値から文字を選ぶ。
// 面の材質は 赤 = 明るさ（覚えているだけの所は暗く、遠いほど暗く）、緑 = 何の面か、青 = 面の向き、
// 不透明度 = 距離 を書き出す。モンスターなどの字は、位置を升目に写して上から描く
// ---------------------------------------------------------------------------
// 覚えているだけの所を照らす手元の明かりの落ち方（大きいほど近くしか見えない）
const TORCH_U = { value: 3 };
// 光源（灯った燭台と、明るい部屋の扉の口）。xyz が場所、w が強さ。近い順に MAX_LIGHTS 個まで
const MAX_LIGHTS = 128, LIGHT_R = 2.6;
const LIGHTS_U = { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, 0, 0, 0)) };
const BEAM_U = { value: 3 };
const WALL_U = { value: 3 };
const TEXR_U = { value: 2.5 };   // 壁・床の模様が見える距離（これより遠くは模様なし）   // 部屋の壁の模様（0 なし・1 レンガ積み・2 ざらつき・3 不揃いな石）
const LT2_U = { value: new THREE.Vector4(0, 0, 0, 0) };   // 燭台の光の色・壁の石組み・床の敷石・燭台の上のすす   // 天井の梁の間隔（マス。0 でなし）
const TIME_U = { value: 0 }, LTUNE_U = { value: new THREE.Vector4(0, 0, 0, 0) };   // 部屋の光・手元の明かり・揺らぎ・隅の陰
let lamps = [];   // 明るい部屋の扉の口から漏れる光
// 燭台の光の強さ（d は燭台からの距離）。シェーダーと drawLines で同じ式
const sconceLit = d => d < LIGHT_R ? 0.9 * (1 - d / LIGHT_R) ** 2 : 0;
function setLights() {
  const [py, px] = player || [0, 0];
  const ls = [...sconces.filter(s => !s.dark).map(s => ({ x: s.x, y: 0.62, z: s.z, w: 1 })), ...(tune.doorLight ? lamps : [])]
    .map(l => ({ l, d: Math.hypot(l.x - px - 0.5, l.z - py - 0.5) }));
  ls.sort((a, b) => a.d - b.d);
  LIGHTS_U.value.forEach((v, i) => { const l = ls[i]?.l; if (l) v.set(l.x, l.y, l.z, l.w); else v.set(0, 0, 0, 0); });
  LTUNE_U.value.set(tune.roomLight, tune.hand, tune.flicker, tune.ao);
  LT2_U.value.set(tune.warm, tune.masonry, tune.flag, tune.soot);
}
function lightAt(x, y, z) {
  if (tune.torch < 0.2) return 0;
  let k = 0;
  const L = LIGHTS_U.value;
  for (let i = 0; i < L.length; i++) {
    const v = L[i]; if (!v.w) break;
    const dx = v.x - x, dy = v.y - y, dz = v.z - z;
    k += v.w * sconceLit(Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return Math.min(1, k);
}
// 材質の色（インスタンスごと）: 赤 = 明るさ、緑 = 明るい部屋の中か、青 = 床の隣の壁（北 1・南 2・西 4・東 8 の和 / 16。隅の陰に使う）
// まだ分からない所の「ふた」: 何も描かないが、奥行きは書き出すので向こうの物を隠す
const VOID_MAT = new THREE.ShaderMaterial({
  vertexShader: `
    varying float vD;
    void main() {
      mat4 m = modelMatrix;
      #ifdef USE_INSTANCING
        m = m * instanceMatrix;
      #endif
      vec4 mv = viewMatrix * m * vec4(position, 1.0);
      vD = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  // 明るさ 0・種類 0（字を置かない）。奥行きは書くので、輪郭の線・燭台・モンスターの字もここで隠れる
  fragmentShader: `varying float vD; void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, max(clamp(vD / 16.0, 0.0, 1.0), 1.0 / 255.0)); }`,
});
function kindMat(kind) {
  return new THREE.ShaderMaterial({
    uniforms: { kind: { value: kind }, torch: TORCH_U, lights: LIGHTS_U, time: TIME_U, lt: LTUNE_U, beam: BEAM_U, lt2: LT2_U, wall: WALL_U, texr: TEXR_U },
    vertexShader: `
      varying vec3 vN; varying vec3 vC; varying float vD; varying vec3 vW;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = m * instanceMatrix;
        #endif
        vN = normalize(mat3(m) * normal);
        vC = vec3(1.0, 0.0, 0.0);
        #ifdef USE_INSTANCING_COLOR
          vC = instanceColor;
        #endif
        vec4 wp = m * vec4(position, 1.0);
        vW = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vD = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float kind; uniform float beam; uniform vec4 lt2; uniform float wall; uniform float texr; uniform float torch; uniform vec4 lights[${MAX_LIGHTS}]; uniform float time; uniform vec4 lt;
      varying vec3 vN; varying vec3 vC; varying float vD; varying vec3 vW;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float vnoise(vec3 p) {   // 値ノイズ（岩のざらつき）
        vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
      vec2 stones(vec2 p) {   // 不揃いな石: いちばん近い石の中心までと 2 番目までの距離（目地は 2 つが近い所）
        vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0, id = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 g = vec2(float(x), float(y)), o = vec2(hash(vec3(i + g, 1.0)), hash(vec3(i + g, 2.0))) * 0.8 + 0.1;
          float d = length(g + o - f);
          if (d < d1) { d2 = d1; d1 = d; id = hash(vec3(i + g, 3.0)); } else if (d < d2) d2 = d;
        }
        return vec2(d2 - d1, id);
      }
      void main() {
        float vB = vC.r;
        float side = abs(vN.y) > 0.5 ? 0.0 : (abs(vN.x) > 0.5 ? 1.0 : 2.0);
        float face = side == 2.0 ? 0.78 : 1.0;   // 壁は向きで濃さを変えて角を見せる
        // 手元の明かり（lt.y）: 画面の奥行きではなく本当の距離で落ち、斜めに当たる面ほど暗い（正面の壁は真ん中が明るく、端へ暗くなる）
        vec3 toCam = cameraPosition - vW; float dc = length(toCam);
        float dd = mix(vD, dc, lt.y);
        float lam = mix(1.0, 0.15 + 0.85 * abs(dot(vN, toCam / dc)), lt.y);
        // 遠いほど暗く（薄い字に）。いま見えている所（明るい部屋）はゆっくり、覚えているだけの所は手元の明かりが届く範囲で
        float far = 1.0 - 0.9 * smoothstep(0.6, 10.0, dd);
        // 手に持った火の揺らぎ（lt.z）: 少し暗くなる向きにだけ揺れる
        float hf = 1.0 - lt.z * 0.9 * (0.5 + 0.5 * (0.6 * sin(time * 9.3) + 0.4 * sin(time * 21.7 + 1.3)));
        float tl = hf / (1.0 + torch * dd * dd);
        float soot = 0.0;   // 燭台の上のすす（lt2.w）: 炎の真上に、上へ広がる黒ずみ
        float sl = 0.0, rl = 0.0;   // sl: 燭台のすぐ周りを照らす光（覚えているだけの所が闇に沈むとき）、rl: 部屋を照らす光
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          vec4 L = lights[i];
          if (L.w <= 0.0) break;
          vec3 dv = L.xyz - vW; float d = length(dv);
          if (L.w > 0.99 && -dv.y > 0.06) { float h = -dv.y, rad = 0.1 + h * 0.45, r = length(dv.xz); if (r < rad) soot = max(soot, (1.0 - r / rad) * (1.0 - h * 0.8) * 0.8); }
          if (dot(vN, dv) < -0.05) continue;   // 面の裏側からの光は届かない（部屋の壁の外側は部屋の光で照らされない）
          float f = L.w * (1.0 + lt.z * (0.6 * sin(time * 11.1 + L.x * 3.0 + L.z * 7.0) + 0.4 * sin(time * 27.0 + L.x * 5.0)));   // 炎の揺らぎ
          if (d < ${LIGHT_R.toFixed(2)}) { float q = 1.0 - d / ${LIGHT_R.toFixed(2)}; sl += 0.9 * q * q * f; }
          rl += f / (1.0 + 0.6 * d * d * d);
        }
        if (torch < 0.2) sl = 0.0;
        float lit = vB > 0.9 ? far * lam * hf : min(1.0, vB * 2.3 * tl * lam + 0.04 * far * (torch < 0.2 ? 1.0 : 0.0) + sl);
        if (vC.g > 0.5) {   // 明るい部屋（lt.x）: 燭台の近くが明るく、間や真ん中はやや暗い。部屋を出ても明かりは灯ったまま
          float room = far * clamp(0.08 + 0.95 * rl, 0.0, 1.0);
          lit = mix(lit, max(room, min(1.0, 2.3 * tl * lam)), lt.x);   // 部屋の光の届かない所（部屋の壁の外側など）は手元の明かり
        }
        // 隅の陰（lt.w）: 壁の根元と天井際、床の壁際は光が回りにくい
        float ao = 1.0;
        if (kind < 3.5 && side != 0.0) ao = mix(0.55, 1.0, smoothstep(0.0, 0.28, vW.y)) * mix(0.8, 1.0, smoothstep(1.0, 0.85, vW.y));
        if (kind == 4.0 || kind == 5.0) {
          float m = floor(vC.b * 16.0 + 0.5), fx = fract(vW.x), fz = fract(vW.z), e = 1.0;
          if (mod(m, 2.0) >= 1.0) e = min(e, fz);
          if (mod(floor(m / 2.0), 2.0) >= 1.0) e = min(e, 1.0 - fz);
          if (mod(floor(m / 4.0), 2.0) >= 1.0) e = min(e, fx);
          if (mod(floor(m / 8.0), 2.0) >= 1.0) e = min(e, 1.0 - fx);
          ao = mix(0.55, 1.0, smoothstep(0.0, 0.35, e));
        }
        lit *= mix(1.0, ao, lt.w);
        // 壁の石組み（lt2.y）: 4 段の石積み。段ごとに縦の継ぎ目をずらす。遠くでは升目より細かくなるので消していく
        float near = 1.0 - smoothstep(texr * 0.45, texr, dd);
        if ((kind == 1.0 || kind == 2.0) && side != 0.0 && wall > 0.0) {
          float u = side == 1.0 ? vW.z : vW.x, row = floor(vW.y * 4.0);
          if (wall == 1.0) { if (fract(vW.y * 4.0) < 0.2 || fract(u * 2.0 + 0.5 * mod(row, 2.0)) < 0.12) lit *= 1.0 - 0.75 * lt2.y * near; }
          else if (wall == 2.0) lit *= mix(1.0, 0.6 + 0.6 * vnoise(vec3(u, vW.y, 0.0) * 7.0), near);
          else { vec2 st = stones(vec2(u * 3.2, vW.y * 4.2)); lit *= mix(1.0, (st.x < 0.12 ? 0.3 : 0.8 + 0.35 * st.y), near * lt2.y); }   // 石ごとに少し明るさを変える
        }
        if (kind == 3.0) lit *= mix(1.0, 0.55 + 0.7 * vnoise(vW * 3.1), lt2.y * near);   // 通路の岩はごつごつ
        // 床の敷石（lt2.z）: 半マスの石を、列ごとにずらして敷く（見つけていない罠の床も同じに）
        if (kind == 4.0 || kind == 10.0) {
          if (fract(vW.z * 2.0) < 0.14 || fract(vW.x * 2.0 + 0.5 * mod(floor(vW.z * 2.0), 2.0)) < 0.12) lit *= 1.0 - 0.85 * lt2.z * near;
        }
        lit *= 1.0 - soot * lt2.w;
        lit *= face;
        // 燭台の光の色（lt2.x）: 燭台の光が当たる分だけ暖かい色に。青の下位 6 bit に入れる（上位は面の向き）
        float warm = clamp(sl * 1.2 + (vC.g > 0.5 ? lt.x * rl * 0.9 : 0.0), 0.0, 1.0) * lt2.x;
        float k = kind;
        if (kind == 7.0 && beam > 0.0) {   // 天井の梁（部屋の短い向きに渡す。向きは色の青）
          float bm = floor(vC.b * 16.0 + 0.5);
          if ((bm == 1.0 && fract(vW.x / beam + 0.5) < 0.14) || (bm == 2.0 && fract(vW.z / beam + 0.5) < 0.14)) k = 12.0;
        }
        gl_FragColor = vec4(lit, k / 15.0, (side * 64.0 + floor(warm * 63.0 + 0.5)) / 255.0, max(clamp(vD / 16.0, 0.0, 1.0), 1.0 / 255.0));
      }`,
  });
}

const CELL_W = 5.5;   // 升目 1 つの横幅（CSS の px。縦はその 2 倍）。粗・中・細を見比べて中に決めた
let tcols = 0, trows = 0, tcw = 0, tch = 0, rt = null, tbuf = null, tdpr = 1;
function sizeTerm(w, h) {
  tcols = Math.max(24, Math.round(w / CELL_W)); tcw = w / tcols;
  tch = tcw * 2; trows = Math.max(12, Math.floor(h / tch));
  const dpr = tdpr = Math.min(devicePixelRatio || 1, 2);
  glyph.shapes.clear();
  tcv.width = Math.round(w * dpr); tcv.height = Math.round(h * dpr);
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (rt) rt.dispose();
  rt = new THREE.WebGLRenderTarget(tcols, trows, { depthBuffer: true });
  tbuf = new Uint8Array(tcols * trows * 4);
}

// 輪郭の線分を升目に写す。線の見た目の傾き（升は縦が横の 2 倍）で置き方を変える:
//   急（ほぼ縦） → 1 行に 1 字 |
//   斜め       → 1 行に 1 字 / か \。行の間で横に飛ぶ分は _ で埋める（\_  _/ の形）
//   ゆるやか   → 1 列に 1 字。升の中の高さで _ . - ' を使い分ける（__..--'' のように滑らかにつながる）
// 手前の面に隠れる所は引かない。同じ升に何本も通るときは手前の線
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _p = new THREE.Vector3();
// 毎回作り直すと iPhone で使い捨てのメモリが溜まって落ちるので（2026-10-24）、線の結果や途中の点は入れ物を使い回す
const lineOut = { ch: [], d: new Float32Array(0), v: new Float32Array(0) };
const linePts = new Float32Array(601 * 3);
let lineBest = { e: new Float32Array(0), p: new Float32Array(0), d: new Float32Array(0) };
function drawLines(C, R, depthOf) {
  const N = C * R;
  if (lineOut.d.length !== N) { lineOut.ch = new Array(N); lineOut.d = new Float32Array(N); lineOut.v = new Float32Array(N); }
  const M = Math.max(C, R);
  if (lineBest.e.length < M) lineBest = { e: new Float32Array(M), p: new Float32Array(M), d: new Float32Array(M) };
  const out = lineOut.ch, outD = lineOut.d, outV = lineOut.v, bestE = lineBest.e, bestP = lineBest.p, bestD = lineBest.d;
  out.fill(null);
  const near = 0.12;
  let segB = 1, segL = 0;
  const put = (x, y, ch, dist) => {
    if (x < 0 || y < 0 || x >= C || y >= R) return;
    if (depthOf(x, y) < dist - 0.35) return;   // 手前の壁に隠れる
    const j = y * C + x;
    if (out[j] && outD[j] <= dist) return;
    // 明るさ: 遠いほど暗く。覚えているだけ・まだ分からない所の線は、その暗さに合わせる
    const far = 1 - 0.9 * Math.min(1, Math.max(0, (dist - 0.6) / 9.4));
    const v = segB >= 0.9 ? far : Math.min(1, segB * 2.3 / (1 + tune.torch * dist * dist) + segL);
    if (segB < 0.9 && tune.torch >= 0.2 && v < 0.06) return;   // 手元の明かりが届かない、覚えているだけの所の線は引かない
    out[j] = ch; outD[j] = dist; outV[j] = v;
  };
  for (let i = 0; i < edgeSegs.length; i += 6) {
    segB = edgeBright[i / 6] ?? 1;
    segL = segB < 0.9 ? lightAt((edgeSegs[i] + edgeSegs[i + 3]) / 2, (edgeSegs[i + 1] + edgeSegs[i + 4]) / 2, (edgeSegs[i + 2] + edgeSegs[i + 5]) / 2) : 0;
    _a.set(edgeSegs[i], edgeSegs[i + 1], edgeSegs[i + 2]).applyMatrix4(camera.matrixWorldInverse);
    _b.set(edgeSegs[i + 3], edgeSegs[i + 4], edgeSegs[i + 5]).applyMatrix4(camera.matrixWorldInverse);
    // カメラの後ろに出る分は切る（視点の空間で z < -near が前）
    if (_a.z > -near && _b.z > -near) continue;
    if (_a.z > -near) _a.lerp(_b, (_a.z + near) / (_a.z - _b.z));
    else if (_b.z > -near) _b.lerp(_a, (_b.z + near) / (_b.z - _a.z));
    // 線分上の点を細かく取って升目に写す（視点の空間で取るので遠近で歪まない）
    const pa = _p.copy(_a).applyMatrix4(camera.projectionMatrix), ax = (pa.x + 1) / 2 * C, ay = (1 - pa.y) / 2 * R;
    const pb = _p.copy(_b).applyMatrix4(camera.projectionMatrix), bx = (pb.x + 1) / 2 * C, by = (1 - pb.y) / 2 * R;
    if ((ax < 0 && bx < 0) || (ax > C && bx > C) || (ay < 0 && by < 0) || (ay > R && by > R)) continue;
    const n = Math.min(600, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 4) + 2);
    for (let k = 0; k <= n; k++) {
      _p.copy(_a).lerp(_b, k / n);
      const dist = -_p.z;
      _p.applyMatrix4(camera.projectionMatrix);
      linePts[k * 3] = (_p.x + 1) / 2 * C; linePts[k * 3 + 1] = (1 - _p.y) / 2 * R; linePts[k * 3 + 2] = dist;
    }
    const dxc = bx - ax, dyc = by - ay;
    const slope = Math.abs(dyc * 2 / (dxc || 1e-6));
    if (slope >= 1) {
      // 1 行に 1 字: 行の真ん中を通る所（行ごとに一番近い点。bestE が -1 の行は通らない）
      bestE.fill(-1, 0, R);
      for (let k = 0; k <= n; k++) {
        const qx = linePts[k * 3], qy = linePts[k * 3 + 1];
        const y = Math.floor(qy); if (y < 0 || y >= R) continue;
        const e = Math.abs(qy - (y + 0.5));
        if (bestE[y] < 0 || e < bestE[y]) { bestE[y] = e; bestP[y] = qx; bestD[y] = linePts[k * 3 + 2]; }
      }
      const ch = slope > 3 ? '|' : (dyc > 0) === (dxc > 0) ? '\\' : '/';
      for (let y = 0; y < R; y++) {
        if (bestE[y] < 0) continue;
        const x = Math.floor(bestP[y]), d = bestD[y];
        put(x, y, ch, d);
        if (ch === '|' || y + 1 >= R || bestE[y + 1] < 0) continue;
        const nx = Math.floor(bestP[y + 1]);
        // 次の行まで横に 2 升以上ずれるなら、この行の続きを _ で埋める
        if (ch === '\\') for (let k = x + 1; k < nx; k++) put(k, y, '_', d);
        else for (let k = nx + 1; k < x; k++) put(k, y, '_', d);
      }
    } else {
      // 1 列に 1 字: 列の真ん中を通る所の高さで字を選ぶ
      bestE.fill(-1, 0, C);
      for (let k = 0; k <= n; k++) {
        const qx = linePts[k * 3];
        const x = Math.floor(qx); if (x < 0 || x >= C) continue;
        const e = Math.abs(qx - (x + 0.5));
        if (bestE[x] < 0 || e < bestE[x]) { bestE[x] = e; bestP[x] = linePts[k * 3 + 1]; bestD[x] = linePts[k * 3 + 2]; }
      }
      for (let x = 0; x < C; x++) {
        if (bestE[x] < 0) continue;
        const y = Math.floor(bestP[x]), f = bestP[x] - y;   // 升の中の高さ（0 = 上、1 = 下）
        put(x, y, f > 0.72 ? '_' : f > 0.5 ? '.' : f > 0.28 ? '-' : "'", bestD[x]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// モンスターの形（ASCII の見た目で近くにいるとき）。X の升をモンスター自身の字で、e の升を目として描く。. の升は黒く塗るだけ（後ろを透かさない隙間）。
// 1 升は縦が横の 2 倍なので、横に長めに作ると釣り合う。遠くて 1 升が小さくなりすぎるときは 1 文字で出す
// ---------------------------------------------------------------------------
const ART = {
  B: [   // バット: 翼を広げた蝙蝠
    'X               X',
    'XX     X X     XX',
    'XXXX   XXX   XXXX',
    'XXXXXXXeXeXXXXXXX',
    ' XXXXXXXXXXXXXXX ',
    '  XXX  XXX  XXX  ',
    '   X    X    X   ',
  ],
  K: [   // ケストレル: 翼を張って向かってくる鳥
    'XXX           XXX',
    ' XXXX   X   XXXX ',
    '   XXXXeXeXXXX   ',
    '     XXXXXXX     ',
    '      XXXXX      ',
    '       XXX       ',
    '      X X X      ',
  ],
  E: [   // エミュー: 長い首の大きな鳥
    '     XX   ',
    '    XeXX  ',
    '     XX   ',
    '     X    ',
    '     X    ',
    '    XX    ',
    '  XXXXXX  ',
    ' XXXXXXXX ',
    ' XXXXXXXX ',
    '  XXXXXX  ',
    '   X  X   ',
    '   X  X   ',
    '  XX XX   ',
  ],
  S: [   // スネーク: 鎌首をもたげた蛇
    '    XXXX    ',
    '   XeXXeX   ',
    '   XXXXXX   ',
    '    XXXX    ',
    '     XX     ',
    '     XX     ',
    '  XXXXX     ',
    ' XX         ',
    ' XXXXXXXXX  ',
    '         XX ',
    '  XXXXXXXXX ',
  ],
  H: [   // ホブゴブリン: 棍棒を持った小鬼
    '    XXX     ',
    '   XeXeX    ',
    '    XXX     ',
    '  XXXXXXX  X',
    ' X XXXXX X X',
    ' X XXXXX  XX',
    '   XX XX    ',
    '   X   X    ',
    '  XX   XX   ',
  ],
  A: [   // アクエイター: 丸い傘と垂れる足のくらげ
    '    XXXXXXXXX    ',
    '  XXXXXXXXXXXXX  ',
    ' XXXXeXXXXXeXXXX ',
    ' XXXXXXXXXXXXXXX ',
    '  X  X  X  X  X  ',
    ' X  X  X  X  X   ',
    '  X  X  X  X  X  ',
    ' X  X  X  X  X   ',
  ],
  C: [   // ケンタウロス: 人の上半身と馬の胴
    '    XX         ',
    '   XeX         ',
    '    XX         ',
    '  XXXXX        ',
    ' X XXX X       ',
    '   XXXXXXXXXXX ',
    '   XXXXXXXXXXXX',
    '   XXXXXXXXXXX ',
    '   X  X   X  X ',
    '   X  X   X  X ',
    '  XX XX  XX XX ',
  ],
  D: [   // ドラゴン: 横向き。左に頭、細い首、背中の翼、4 本の脚、右へ伸びる尾（正面向きはコウモリに見えるので）
    '             X       X    ',
    '  XX         XX     XXX   ',
    ' XXXX        XXX   XXXX   ',
    'XXeXXX        XXX XXXXX   ',
    'XXXX XX        XXXXXXX    ',
    ' X    XX     XXXXXXXXXX   ',
    '       XX  XXXXXXXXXXXXX  ',
    '        XXXXXXXXXXXXXXXXXX ',
    '         XXXXXXXXXXXXX  XXX',
    '         XX  XX    XX     XX',
    '        XXX XXX   XXX      X',
  ],
  F: [   // フライトラップ: 口を開けた食虫植物
    '  X X X X X  ',
    ' XXXXXXXXXXX ',
    'XXXXeXXXeXXXX',
    'X           X',
    'XXXXXXXXXXXXX',
    ' XXXXXXXXXXX ',
    '  X X X X X  ',
    '      X      ',
    ' XX   X   XX ',
    '  XXX X XXX  ',
    '     XXX     ',
  ],
  G: [   // グリフィン: 鷲の頭と翼、獅子の胴
    'XX           XX ',
    'XXXX  XXX  XXXX ',
    ' XXXXXXeXXXXXX  ',
    '   XXXXXXXXXX   ',
    '   XXXXXXXXXXXX ',
    '   XXXXXXXXXX  X',
    '   X X    X X   ',
    '  XX XX  XX XX  ',
  ],
  I: [   // アイスモンスター: 尖った氷の柱が立つ塊
    '   X     X     X   ',
    '  XXX   XXX   XXX  ',
    '  XXX  XXXXX  XXX  ',
    ' XXXXX XXXXX XXXXX ',
    ' XXXXXXXXXXXXXXXXX ',
    'XXXXXXeXXXXXeXXXXXX',
    'XXXXXXXXXXXXXXXXXXX',
  ],
  J: [   // ジャバウォック: 長い首と翼の怪物
    '  XX             ',
    ' XeXX            ',
    '  XXX    X    X  ',
    '   XX   XXX  XXX ',
    '    XX XXXXXXXXX ',
    '    XXXXXXXXXXX  ',
    '     XXXXXXXXX   ',
    '     XX XX XX    ',
    '    XX  X   XX   ',
    '   XX  XX    XX  ',
  ],
  L: [   // レプラコーン: 帽子をかぶった小人
    '    XXX    ',
    '    XXX    ',
    '  XXXXXXX  ',
    '   XeXeX   ',
    '    XXX    ',
    '   XXXXX   ',
    '  X XXX X  ',
    '    X X    ',
    '   XX XX   ',
  ],
  M: [   // メデューサ: 蛇の髪の女
    ' X X X X X ',
    'X XXXXXXX X',
    ' XXXXXXXXX ',
    'X XXeXeXX X',
    '   XXXXX   ',
    '    XXX    ',
    '  XXXXXXX  ',
    ' X XXXXX X ',
    '   XXXXX   ',
    '  XXXXXXX  ',
    ' XXXXXXXXX ',
  ],
  N: [   // ニンフ: 長い髪の精
    '    XXX    ',
    '   XeXeX   ',
    '   XXXXXX  ',
    '    XXX XX ',
    '  XXXXXX X ',
    ' X XXXXX   ',
    'X  XXXXX   ',
    '  XXXXXXX  ',
    ' XXXXXXXXX ',
    '   X   X   ',
  ],
  O: [   // オーク: 牙のある大柄な鬼
    '   XXXXX   ',
    '  XeXXXeX  ',
    '  XXXXXXX  ',
    '   X X X   ',
    ' XXXXXXXXX ',
    'XXXXXXXXXXX',
    'XX XXXXX XX',
    'X  XXXXX  X',
    '   XX XX   ',
    '  XXX XXX  ',
  ],
  P: [   // ファントム: 布をかぶった幽霊
    '   XXXXXXX   ',
    '  XXXXXXXXX  ',
    ' XXeXXXXXeXX ',
    ' XXXXXXXXXXX ',
    ' XXXX   XXXX ',
    ' XXXXXXXXXXX ',
    'XXXXXXXXXXXXX',
    'XXXXXXXXXXXXX',
    'X XX XXX XX X',
    'X  X  X  X  X',
  ],
  Q: [   // クアッガ: 胴に縞のある馬（. は縞の隙間）
    'XX              ',
    'XeX             ',
    ' XXX            ',
    '  XX.XX.XX.XXX  ',
    '  XX.XX.XX.XXXX ',
    '  XX.XX.XX.XX  X',
    '  X  X    X  X  ',
    '  X  X    X  X  ',
    ' XX XX   XX XX  ',
  ],
  R: [   // ラトルスネーク: とぐろを巻いた蛇と尾の鳴子
    '   XXXX       ',
    '  XeXXeX      ',
    '  XXXXXX      ',
    '   XXX        ',
    '    XX    X X ',
    '  XXXXXX  XXX ',
    ' XXXXXXXXXXX  ',
    'XXX      XXX  ',
    ' XXXXXXXXXX   ',
    '  XXXXXXXX    ',
  ],
  T: [   // トロール: 腕の長い大鬼
    '    XXXX    ',
    '   XeXXeX   ',
    '   XXXXXX   ',
    '  XXXXXXXX  ',
    ' XXXXXXXXXX ',
    'XX XXXXXX XX',
    'XX XXXXXX XX',
    'X  XXXXXX  X',
    'X  XXX XXX X',
    '   XX   XX  ',
    '  XXX   XXX ',
  ],
  U: [   // ブラックユニコーン: 角を立てて前脚を上げた馬（クアッガと見分けやすく）
    'X                 ',
    ' X                ',
    '  XX              ',
    ' XeXX             ',
    '  XXXX            ',
    ' X XXXXXXXXXXX    ',
    'X  XXXXXXXXXXXX   ',
    ' X  XXXXXXXXXX X  ',
    '       X    X  X  ',
    '       X    X     ',
    '      XX   XX     ',
  ],
  V: [   // ヴァンパイア: マントを広げた吸血鬼
    '    XXX    ',
    '   XeXeX   ',
    'XX  XXX  XX',
    'XXXXXXXXXXX',
    ' XXXXXXXXX ',
    ' XXXXXXXXX ',
    '  XXXXXXX  ',
    '  XXXXXXX  ',
    '  XXX XXX  ',
    '  XX   XX  ',
  ],
  W: [   // レイス: 宙に漂う死霊
    '    XXXX    ',
    '   XXXXXX   ',
    '   XeXXeX   ',
    '  XXXXXXXX  ',
    ' X XXXXXX X ',
    'X  XXXXXX  X',
    '   XXXXXX   ',
    '  XXX XXXX  ',
    '  X X  X X  ',
    '   X    X   ',
  ],
  X: [   // ゼロック: アイテムに化けて待ち伏せする怪物。目のある箱が歯の並んだ口を開ける（. は口の中）
    ' XXXXXXXXXXXXX ',
    'XXXXeXXXXXeXXXX',
    'XXXXXXXXXXXXXXX',
    'X.X.X.X.X.X.X.X',
    '...............',
    'X.X.X.X.X.X.X.X',
    'XXXXXXXXXXXXXXX',
    'XXXXXXXXXXXXXXX',
  ],
  Y: [   // イエティ: 毛むくじゃらの雪男
    '   XXXXX   ',
    '  XXeXeXX  ',
    '  XXXXXXX  ',
    ' XXXXXXXXX ',
    'XXXXXXXXXXX',
    'XX XXXXX XX',
    'XX XXXXX XX',
    '   XXXXX   ',
    '  XXX XXX  ',
    ' XXXX XXXX ',
  ],
  // 床のアイテム（e の升は光る点 * で描く）
  '!': [   // 薬: 瓶
    '  XX  ',
    '  XX  ',
    ' XXXX ',
    'XXXXXX',
    'XXXXXX',
    ' XXXX ',
  ],
  '?': [   // 巻物: 広げた紙と、上下に突き出た左右の軸。紙の . は文字の行の隙間（黒く塗る）
    'XX          XX',
    'XXXXXXXXXXXXXX',
    'XX.X.XXX.X..XX',
    'XX.XX.X.XXX.XX',
    'XX.X.XX.XX..XX',
    'XXXXXXXXXXXXXX',
    'XX          XX',
  ],
  ')': [   // 武器: 床に置いた剣
    '       XX',
    '      XX ',
    '     XX  ',
    '  XXXX   ',
    '   XX    ',
    '  X X    ',
    ' X       ',
  ],
  ']': [   // 鎧: 胸当て
    'XX    XX',
    'XXXXXXXX',
    ' XXXXXX ',
    ' XXXXXX ',
    '  XXXX  ',
  ],
  '=': [   // 指輪: 宝石の付いた輪
    '   ee   ',
    '  XXXX  ',
    ' X    X ',
    ' X    X ',
    '  XXXX  ',
  ],
  '/': [   // 杖: 先の光る棒
    '      e',
    '     X ',
    '    X  ',
    '   X   ',
    '  X    ',
    ' X     ',
  ],
  ':': [   // 食料: 骨付き肉（b の升は骨。2026-10-25 にパンから 3 案で選んだ）
    ' XXX   ',
    'XXXXX  ',
    'XXXXX  ',
    ' XXXbb ',
    '     bb',
  ],
  '*': [   // 金貨: 小山
    '   X   ',
    '  XXX  ',
    ' XXXXX ',
    'XXXXXXX',
  ],
  ',': [   // 魔除け: 首飾り
    'X     X',
    ' X   X ',
    '  X X  ',
    '   e   ',
    '  XXX  ',
  ],
  Z: [   // ゾンビ: 腕を前に突き出した死体
    '   XXX      ',
    '  XeXeX     ',
    '   XXX      ',
    '  XXXXXXXXX ',
    '  XXXX      ',
    '  XXXXXXXXX ',
    '  XXXX      ',
    '  XX XX     ',
    '  X   X     ',
    ' XX   XX    ',
  ],
};
// 横から見た形（左を向いた形）。ART が横向きのモンスター（SIDE_NATIVE）は、ここに正面の形を置く
const ART_SIDE = {
  B: [   // バット: 横から。翼を上げた蝙蝠
    '        XXX      ',
    '      XXXXX      ',
    '     XXXXX       ',
    ' XXXXXXXX        ',
    'XeXXXXXXXXXX     ',
    ' XXXXXXXXXXXXX   ',
    '   X    XX   XX  ',
  ],
  K: [   // ケストレル: 横から。翼を上げて飛ぶ鳥
    '        XXX         ',
    '       XXXX         ',
    '      XXXXX         ',
    ' XX  XXXXX          ',
    'XeXXXXXXXXXXXXX     ',
    ' XXXXXXXXXXXXXXXXX  ',
    '     XXXXXXX    XXX ',
    '      X  X          ',
  ],
  H: [   // ホブゴブリン: 横から。棍棒を振り上げた小鬼
    '    XXX    X ',
    '   XeXX   XX ',
    '    XXX  XX  ',
    '   XXXXXXX   ',
    '  XXXXXX     ',
    '   XXXX      ',
    '   XX XX     ',
    '  XX   XX    ',
  ],
  O: [   // オーク: 横から。突き出た牙と前かがみの大きな体
    '    XXXX   ',
    '   XeXXXX  ',
    ' X XXXXX   ',
    '  XXXXX    ',
    '   XXXXXX  ',
    '  XXXXXXXX ',
    ' XXXXXXXXX ',
    'X  XXXXXX  ',
    '   XXXXXX  ',
    '   XX  XX  ',
    '  XXX XXX  ',
  ],
  G: [   // グリフィン: 横から。鷲の頭と立てた翼、獅子の胴
    '      XX  XX     ',
    '     XXXXXXX     ',
    ' XX XXXXXXX      ',
    'XeXXXXXX         ',
    ' X XXXXXXXXXXX  X',
    '   XXXXXXXXXXXXX ',
    '   XXXXXXXXXXX   ',
    '   X X     X X   ',
    '  XX XX   XX XX  ',
  ],
  L: [   // レプラコーン: 横から。帽子をかぶった小人
    '    XXX   ',
    '    XXX   ',
    '  XXXXXX  ',
    '   XeXX   ',
    '    XXX   ',
    '   XXXX   ',
    '  XXXXX   ',
    '   XXX    ',
    '   X X    ',
    '  XX XX   ',
  ],
  M: [   // メデューサ: 横から。後ろへうねる蛇の髪
    '   XXXX X X',
    '  XXXXXXX X',
    ' XXXXXXX X ',
    ' XeXXXX X X',
    '  XXXX     ',
    '   XXX     ',
    '  XXXXX    ',
    ' XXXXXX    ',
    '  XXXXX    ',
    '  XXXXXX   ',
    ' XXXXXXXX  ',
  ],
  N: [   // ニンフ: 横から。後ろへ流れる長い髪
    '    XXXX   ',
    '   XeXXXX  ',
    '    XXXXXX ',
    '    XX  XX ',
    '   XXXX  X ',
    '  XXXXX    ',
    '   XXXX    ',
    '  XXXXXX   ',
    ' XXXXXXXX  ',
    '   X  X    ',
  ],
  P: [   // ファントム: 横から。裾を後ろへなびかせて漂う布
    '    XXXXXX     ',
    '   XXXXXXXX    ',
    '  XeXXXXXXXX   ',
    '  XXXXXXXXXX   ',
    '  XXXXXXXXXXX  ',
    '  XXXXXXXXXXXX ',
    '   XXXXXXXXXXXX',
    '    XXXXXXXXX X',
    '     X XX XX  X',
  ],
  R: [   // ラトルスネーク: 横から。鎌首と、後ろに立てた尾の鳴子
    '  XXXX       ',
    ' XeXXXX      ',
    '  XXX        ',
    '   XX     X  ',
    '   XX    XXX ',
    '  XXXXXXXXX  ',
    ' XXXXXXXXXXX ',
    'XXX      XXX ',
    ' XXXXXXXXXX  ',
    '  XXXXXXXX   ',
  ],
  S: [   // スネーク: 横から。鎌首をもたげた蛇
    '  XXXX      ',
    ' XeXXXX     ',
    '  XXXXX     ',
    '    XXX     ',
    '     XX     ',
    '     XX     ',
    '    XXXXX   ',
    '         XX ',
    '  XXXXXXXXX ',
    ' XX         ',
    '  XXXXXXXXX ',
  ],
  T: [   // トロール: 横から。前に垂らした長い腕
    '    XXXX    ',
    '   XeXXXX   ',
    '    XXXX    ',
    '   XXXXXX   ',
    '  XXXXXXXX  ',
    ' XXXXXXXXX  ',
    ' X XXXXXX   ',
    'X  XXXXXX   ',
    'X   XX XX   ',
    '    XX  XX  ',
    '   XXX  XXX ',
  ],
  V: [   // ヴァンパイア: 横から。後ろに広がるマント
    '    XXX    ',
    '   XeXX    ',
    '    XXX XX ',
    '   XXXXXXX ',
    '   XXXXXXXX',
    '   XXXXXXXX',
    '   XXXXXXX ',
    '   XXXXXXX ',
    '   XX XX   ',
    '  XX  XX   ',
  ],
  W: [   // レイス: 横から。裾を引いて漂う死霊
    '    XXXX    ',
    '   XXXXXX   ',
    '   XeXXXX   ',
    '  XXXXXXXX  ',
    ' XXXXXXXXX  ',
    '    XXXXXXX ',
    '    XXXXXXXX',
    '     XXXXX X',
    '      X X  X',
    '       X    ',
  ],
  X: [   // ゼロック: 横から。口を開けた箱（. は口の中）
    ' XXXXXXXXX ',
    'XeXXXXXXXXX',
    'XXXXXXXXXXX',
    'X.X.XXXXXXX',
    '....XXXXXXX',
    'X.X.XXXXXXX',
    'XXXXXXXXXXX',
    'XXXXXXXXXXX',
  ],
  Y: [   // イエティ: 横から。前かがみの雪男
    '   XXXXX   ',
    '  XeXXXXX  ',
    '  XXXXXXX  ',
    '  XXXXXXXX ',
    ' XXXXXXXXXX',
    ' XXXXXXXXX ',
    'XX XXXXXX  ',
    '   XXXXX   ',
    '  XXX XXX  ',
    ' XXXX XXXX ',
  ],
  F: [   // フライトラップ: 横から。左へ口を開けた顎と、後ろから下りる茎
    '  X X X       ',
    ' XXXXXXXX     ',
    'XXXeXXXXXX    ',
    '      XXXXX   ',
    'XXXXXXXXXX    ',
    ' XXXXXXXX     ',
    '  X X X  X    ',
    '         X    ',
    '     XX  X XX ',
    '      XXXXXX  ',
    '        XX    ',
  ],
  I: [   // アイスモンスター: 横から。氷の柱が後ろへ並ぶ塊（目は 1 つ）
    '    X     X   ',
    '   XXX   XXX  ',
    '   XXX  XXXXX ',
    '  XXXXX XXXXX ',
    ' XXXXXXXXXXXXX',
    'XXeXXXXXXXXXXX',
    'XXXXXXXXXXXXXX',
  ],
  A: [   // アクエイター: 横から。左へ進む傘と、後ろへ流れる足
    '   XXXXXX       ',
    ' XXXXXXXXXX     ',
    'XXeXXXXXXXXX    ',
    'XXXXXXXXXXXX    ',
    '  X  X  X  XX X ',
    '   X  X  X  X  X',
    '    X  X  X  X  ',
    '     X  X  X  X ',
  ],
};
ART_SIDE.Z = [   // ゾンビ: 横から（ART のゾンビは右向きで目が 2 つなので、左向きを描き直す）
  '    XXX     ',
  '   XeXX     ',
  '    XXX     ',
  'XXXXXXXX    ',
  '     XXXX   ',
  'XXXXXXXXX   ',
  '     XXXX   ',
  '    XX XX   ',
  '    X   X   ',
  '   XX   XX  ',
];
const ART_FRONT = {
  E: [   // エミュー: 正面から。長い首の大きな鳥
    '   XXX   ',
    '  XeXeX  ',
    '   XXX   ',
    '    X    ',
    '    X    ',
    '   XXX   ',
    ' XXXXXXX ',
    'XXXXXXXXX',
    'XXXXXXXXX',
    ' XXXXXXX ',
    '  X   X  ',
    '  X   X  ',
    ' XX   XX ',
  ],
  C: [   // ケンタウロス: 正面から。人の上半身と馬の前脚
    '    XXX    ',
    '   XeXeX   ',
    '    XXX    ',
    '  XXXXXXX  ',
    ' X XXXXX X ',
    '   XXXXX   ',
    '  XXXXXXX  ',
    '  XXXXXXX  ',
    '  X X X X  ',
    '  X X X X  ',
    ' XX XX XX XX',
  ],
  D: [   // ドラゴン: 正面から。角のある頭と長い首、広げた翼
    'X          XXX          X',
    'XX        XeXeX        XX',
    'XXXX       XXX       XXXX',
    'XXXXXX     XXX     XXXXXX',
    ' XXXXXXX XXXXXXX XXXXXXX ',
    '  XXXXXXXXXXXXXXXXXXXXX  ',
    '    XXXX XXXXXXX XXXX    ',
    '         XXXXXXX         ',
    '        XX XXX XX        ',
    '       XXX     XXX       ',
  ],
  J: [   // ジャバウォック: 正面から。長い首と翼
    '      XXX      ',
    '     XeXeX     ',
    '  X   XXX   X  ',
    ' XXX  XXX  XXX ',
    ' XXXXXXXXXXXXX ',
    '  XXXXXXXXXXX  ',
    '    XXXXXXX    ',
    '    XX X XX    ',
    '   XX  X  XX   ',
    '  XX       XX  ',
  ],
  Q: [   // クアッガ: 正面から。縞のある馬
    '    XXX    ',
    '   XeXeX   ',
    '    XXX    ',
    '    XXX    ',
    '  XX.X.XX  ',
    '  XX.X.XX  ',
    '  XX.X.XX  ',
    '   X   X   ',
    '   X   X   ',
    '  XX   XX  ',
  ],
  U: [   // ブラックユニコーン: 正面から。額の角
    '     X     ',
    '     X     ',
    '    XXX    ',
    '   XeXeX   ',
    '    XXX    ',
    '    XXX    ',
    '  XXXXXXX  ',
    '  XXXXXXX  ',
    '   X   X   ',
    '   X   X   ',
    '  XX   XX  ',
  ],
  Z: [   // ゾンビ: 正面から。腕をこちらへ突き出した死体
    '   XXX   ',
    '  XeXeX  ',
    '   XXX   ',
    ' XXXXXXX ',
    'XX XXX XX',
    'X  XXX  X',
    '   XXX   ',
    '  XX XX  ',
    '  X   X  ',
    ' XX   XX ',
  ],
};
const SIDE_NATIVE = new Set(['E', 'C', 'D', 'J', 'Q', 'U', 'Z']);   // ART が横向きのモンスター
for (const art of [...Object.values(ART), ...Object.values(ART_SIDE), ...Object.values(ART_FRONT)]) {   // 行の長さをそろえる（短い行は右を空白で埋める）
  const n = Math.max(...art.map(r => r.length));
  art.forEach((r, i) => { art[i] = r.padEnd(n); });
}
// 向きごとの形
const mirror = art => art.map(r => [...r].reverse().join(''));
const noEyes = art => art.map(r => r.replace(/e/g, 'X'));
const ART_VIEW = {};
for (const ch of Object.keys(ART).filter(c => c >= 'A' && c <= 'Z')) {
  const native = SIDE_NATIVE.has(ch);
  const front = native ? ART_FRONT[ch] : ART[ch], side = ART_SIDE[ch] || (native ? ART[ch] : null);
  if (!front) continue;
  ART_VIEW[ch] = { front, back: mirror(noEyes(front)), side, sideR: side && mirror(side) };   // 後ろからは左右が逆（持っている物が反対の手に来る）
}
// 見る向きでの形: 正面・横・後ろ。横の絵は左を向いた形で持ち、右を向くときは左右を返す。
// 後ろは正面の形を左右返して目を消す（多くのモンスターは前と後ろで輪郭がほぼ同じ）。横の絵がないモンスターは横も正面のまま
const _mv = new THREE.Vector3();
function artFor(o, u) {
  const v = ART_VIEW[u.ch], st = u.st;
  if (!v || !st || !st.face || !tune.monView) return ART[u.ch];
  const [fy, fx] = st.face, fl = Math.hypot(fx, fy);
  _mv.copy(camera.position).sub(o.sp.position); _mv.y = 0; _mv.normalize();
  const c = (fx * _mv.x + fy * _mv.z) / fl;   // こちらを向いているほど 1
  if (c > 0.4) return v.front;
  if (c < -0.4) return v.back;
  if (!v.side) return v.front;
  const right = (fx * Math.cos(camera.rotation.y) - fy * Math.sin(camera.rotation.y)) > 0;   // 画面の右を向いている
  return right ? v.sideR : v.side;
}
// 形ごとの大きさ・色の手直し（食料は升が少ないぶん大きく描かれるので小さめに。色は肉の赤茶、骨は白っぽく）
const ART_SCALE = { ':': 0.8 }, ART_COL = { ':': '#c0653c' }, BONE_COL = '#e8e0cc';
// 形で描けたら true（近くて、1 升が画面の升の 0.75 倍以上になるとき）
function drawArt(o, u) {
  const art = artFor(o, u);
  if (!art) return false;
  const rows = art.length, cols = art[0].length;
  // 形の 1 升の高さ（縦に長い形ほど背が高くなる。ただし画面の 9 割まで）
  const h = Math.min(o.size * 1.15 / Math.min(rows, 9), trows * tch * 0.9 / rows) * (ART_SCALE[u.ch] || 1);
  const bottom = o.py + o.size / 2.3;   // 足元を床にそろえる（札の下の端 = 中心から札の高さの半分下）
  if (h < tch * 0.75) return drawArtSmall(art, u, h, bottom, o.px);
  const w = h / 2, x0 = o.px - cols * w / 2, y0 = bottom - rows * h;
  const st = u.st;
  tctx.font = `700 ${fpx(h)}px "BIZ UDGothic", monospace`;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const m = art[r][c];
    if (m === ' ') continue;
    if (st && m !== 'e' && wounded(st.hp, r, c)) continue;   // 傷: 欠けた升は描かない（後ろが透ける）
    const x = x0 + c * w, y = y0 + r * h;
    if (!u.ghost) { tctx.fillStyle = '#000'; tctx.fillRect(x - 0.5, y, w + 1, h); }   // 後ろの壁の字を消す（壁越しの透けた形は消さない）
    if (m === '.') continue;
    const eye = m === 'e', shut = eye && st && st.sleep;
    const base = m === 'b' ? BONE_COL : ART_COL[u.ch] || u.col || '#c8ccd1';
    tctx.fillStyle = eye && !shut ? '#ffe08a' : u.L ? litCol(base, u.L, (c + 0.5) / cols * 2 - 1) : base;
    tctx.fillText(shut ? '-' : eye ? '*' : u.ch, x + w / 2, y + h / 2 + h * 0.04);
  }
  if (st && st.sleep) drawZzz(x0 + cols * w * 0.75, y0, h);
  return true;
}

// 燭台の形（たいまつ: 炎 ^ と火皿の * は橙、( ) と柄 | は灰色の金具）。2026-10-23 に 3 案から選んだ
const SCONCE_ART = {
  B: { rows: [' ^ ', '(*)', ' | '], flame: [[0, 1], [1, 1]] },
};
// 燭台の光が届く所（画面の升目での中心・半径と、燭台までの距離）。drawTerm が字を橙に明るくするのに使う
function sconceLights(C, R) {
  if (!SCONCE_ART[tune.sconce] || !tune.glow) return [];
  const v3 = new THREE.Vector3(), out = [];
  const unitK = R * tch / (2 * Math.tan(camera.fov * Math.PI / 360));
  for (const s of sconces) {
    if (s.dark) continue;
    v3.set(s.x, 0.62, s.z).applyMatrix4(camera.matrixWorldInverse);
    const dist = -v3.z;
    if (dist < 0.2) continue;
    v3.set(s.x, 0.62, s.z).project(camera);
    if (Math.abs(v3.x) > 1.6 || Math.abs(v3.y) > 1.6) continue;
    let fl = 1 + tune.flicker * 0.6 * Math.sin(performance.now() / 90 + s.x * 3 + s.z * 7), fi = 1;   // 炎と同じ揺らぎ
    if (tune.halo) {   // 部屋を照らす光（シェーダの L.w）と同じ式で、光の輪の広さと明るさを揺らす
      const t = TIME_U.value, ff = Math.min(1, tune.flicker / 0.15) * (0.6 * Math.sin(t * 11.1 + s.x * 3 + s.z * 7) + 0.4 * Math.sin(t * 27 + s.x * 5));
      fl = 1 + tune.halo * ff; fi = 1 + tune.halo * 1.5 * ff;
    }
    out.push({ cx: (v3.x + 1) / 2 * C, cy: (1 - v3.y) / 2 * R, dist, fi, rad: unitK / dist * tune.glow * fl / tch });   // rad は升（縦）の数
  }
  return out;
}
function glowAt(lights, x, y, depth) {
  let k = 0;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i];
    if (Math.abs(depth - l.dist) > 1.6) continue;   // 燭台から離れた奥や手前の面は照らさない
    const dx = (x + 0.5 - l.cx) * tcw / tch, dy = y + 0.5 - l.cy;
    const d = Math.sqrt(dx * dx + dy * dy) / l.rad;
    if (d < 1) k = Math.max(k, Math.min(1, (1 - d) * (1 - d) * l.fi));
  }
  return k;
}
function drawSconces(C, R, depthOf) {
  const st = tune.sconce, art = SCONCE_ART[st];
  if (!art) return;
  const v3 = new THREE.Vector3(), now = performance.now();
  const unitK = R * tch / (2 * Math.tan(camera.fov * Math.PI / 360));
  for (const s of sconces) {
    v3.set(s.x, 0.62, s.z).applyMatrix4(camera.matrixWorldInverse);
    const dist = -v3.z;
    if (dist < 0.2) continue;
    v3.set(s.x, 0.62, s.z).project(camera);
    if (Math.abs(v3.x) > 1.1 || Math.abs(v3.y) > 1.1) continue;
    const cx = (v3.x + 1) / 2 * C, cy = (1 - v3.y) / 2 * R;
    const ix = Math.min(C - 1, Math.max(0, Math.floor(cx))), iy = Math.min(R - 1, Math.max(0, Math.floor(cy)));
    if (depthOf(ix, iy) < dist - 0.2) continue;   // 手前の壁に隠れている
    const unit = unitK / dist, rows = art.rows.length, cols = art.rows[0].length;
    const lit = !s.dark;
    const fade = 1 - Math.min(0.7, Math.max(0, (dist - 2) / 12));
    let h = unit * 0.36 / rows;
    if (h < tch * 0.8) {   // 遠い: 炎の 1 字だけ
      if (!lit) continue;
      tctx.font = `700 ${fpx(tch * 0.94)}px "BIZ UDGothic", monospace`;
      tctx.globalAlpha = fade; tctx.fillStyle = '#ffb054';
      tctx.fillText('*', (ix + 0.5) * tcw, (iy + 0.5) * tch + tch * 0.04);
      tctx.globalAlpha = 1;
      continue;
    }
    h = Math.min(h, tch * 4);
    const w = h / 2, x0 = cx * tcw - cols * w / 2, y0 = cy * tch - rows * h / 2;
    tctx.font = `700 ${fpx(h)}px "BIZ UDGothic", monospace`;
    tctx.globalAlpha = fade;
    let flick = 0.85 + 0.15 * Math.sin(now / 90 + s.x * 3 + s.z * 7);
    // 炎の揺らぎ（tune.flame）: 部屋を照らす光（シェーダの L.w の揺らぎ）と同じ式で、明るさ・先の形・横の揺れ・大きさを動かす
    const t = TIME_U.value, ff = Math.min(1, tune.flicker / 0.15) * (0.6 * Math.sin(t * 11.1 + s.x * 3 + s.z * 7) + 0.4 * Math.sin(t * 27 + s.x * 5));
    const sway = Math.min(1, tune.flicker / 0.15) * (0.6 * Math.sin(t * 5.3 + s.z * 4) + 0.4 * Math.sin(t * 13.7 + s.x * 2));
    if (tune.flame >= 1) flick = 0.75 + 0.25 * ff;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let ch = art.rows[r][c];
      if (ch === ' ') continue;
      const isFlame = art.flame.some(([fr, fc]) => fr === r && fc === c);
      if (isFlame && !lit) continue;   // 暗い部屋: 火の消えた金具だけ
      tctx.fillStyle = '#000'; tctx.fillRect(x0 + c * w - 0.5, y0 + r * h, w + 1, h);
      tctx.fillStyle = isFlame ? `rgb(255,${Math.round(Math.min(255, 150 + 60 * flick))},${Math.round(Math.max(0, 70 * flick))})` : lit ? '#9a8f80' : '#5a5650';
      let dx = 0, dy = 0, sc = 1;
      if (isFlame && tune.flame >= 2) {
        if (r === 0) { sc = 0.8 + 0.3 * ff; dx = sway * w * 0.3; dy = (1 - sc) * h * 0.5; }   // 先: 伸び縮みして、左右に揺れる
        else dx = sway * w * 0.06;
      }
      if (isFlame && tune.flame >= 3 && r > 0) sc = 1 + 0.14 * ff;   // 炎の芯が膨らんだり縮んだり
      if (sc !== 1) tctx.font = `700 ${fpx(h * sc)}px "BIZ UDGothic", monospace`;
      tctx.fillText(ch, x0 + c * w + w / 2 + dx, y0 + r * h + h / 2 + h * 0.04 + dy);
      if (sc !== 1) tctx.font = `700 ${fpx(h)}px "BIZ UDGothic", monospace`;
    }
    tctx.globalAlpha = 1;
  }
}

// 傷ついたモンスターの欠ける升: 体力が半分を切ると、残りが少ないほど多く欠ける（升ごとに決まった順で）
function wounded(hp, r, c) {
  if (hp >= 0.5) return false;
  const k = ((r * 73 + c * 151) % 97) / 97;
  return k < (0.5 - hp) * 0.9;
}
// 眠っている印: 頭の右上に小さな z と大きな Z
function drawZzz(x, y, h) {
  const font = tctx.font;
  tctx.fillStyle = '#6cc6d6';
  tctx.font = `700 ${fpx(h * 0.8)}px "BIZ UDGothic", monospace`; tctx.fillText('z', x, y - h * 0.3);
  tctx.font = `700 ${fpx(h * 1.1)}px "BIZ UDGothic", monospace`; tctx.fillText('Z', x + h * 0.7, y - h * 1.2);
  tctx.font = font;
}

// 遠くて形の 1 升が画面の升より小さいとき: 形を画面の升目の粗さに縮めて、升目にそろえて描く。
// 縮めた 1 升に当たる範囲の 3 割以上が埋まっていれば字を置く（細い所が消えないように、少なくとも 1 升は残す）
function drawArtSmall(art, u, h, bottom, cx) {
  const rows = art.length, cols = art[0].length;
  const tr = Math.max(1, Math.round(rows * h / tch)), tc = Math.max(1, Math.round(cols * h / 2 / tcw));
  if (tr * tc <= 1) return false;   // 1 升にしかならないなら 1 文字で
  const gx0 = Math.round(cx / tcw - tc / 2), gy0 = Math.round(bottom / tch - tr);
  tctx.font = `700 ${fpx(tch * 0.94)}px "BIZ UDGothic", monospace`;
  let drawn = 0;
  for (let r = 0; r < tr; r++) for (let c = 0; c < tc; c++) {
    const r0 = Math.floor(r * rows / tr), r1 = Math.max(r0 + 1, Math.floor((r + 1) * rows / tr));
    const c0 = Math.floor(c * cols / tc), c1 = Math.max(c0 + 1, Math.floor((c + 1) * cols / tc));
    let n = 0, eye = false, bone = 0;
    for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) { const m = art[y][x]; if (m !== ' ' && m !== '.') n++; if (m === 'e') eye = true; if (m === 'b') bone++; }
    if (n < (r1 - r0) * (c1 - c0) * 0.3) continue;
    if (u.st && !(eye && tr >= 3) && wounded(u.st.hp, r, c)) continue;
    const x = (gx0 + c) * tcw, y = (gy0 + r) * tch;
    if (!u.ghost) { tctx.fillStyle = '#000'; tctx.fillRect(x, y, tcw, tch); }
    const shut = u.st && u.st.sleep;
    const base = bone * 2 > n ? BONE_COL : ART_COL[u.ch] || u.col || '#c8ccd1';
    tctx.fillStyle = eye && tr >= 3 && !shut ? '#ffe08a' : u.L ? litCol(base, u.L, (c + 0.5) / tc * 2 - 1) : base;
    tctx.fillText(eye && tr >= 3 ? (shut ? '-' : '*') : u.ch, x + tcw / 2, y + tch / 2 + tch * 0.04);
    drawn++;
  }
  if (drawn && u.st && u.st.sleep) {   // 小さいときの z は 1 升だけ
    tctx.fillStyle = '#6cc6d6'; tctx.fillText('z', (gx0 + tc) * tcw + tcw / 2, (gy0 - 1) * tch + tch / 2);
  }
  return drawn > 0;
}

// 色 #rrggbb を明るさ v（0〜1）で暗くした rgb()
// モンスター・アイテムの陰影（tune.objLight）: 燭台の光が当たる側を明るく、反対側を暗くする（形を縦の筒とみなし、列ごとに面の向きを変えて光との角度を取る）。
// 燭台の光は炎と一緒に揺らぐ
const _ol = new THREE.Vector3();
// 手に持った火の揺らぎ（シェーダーの hf と同じ式）
const handFlick = t => 1 - tune.flicker * 0.9 * (0.5 + 0.5 * (0.6 * Math.sin(t * 9.3) + 0.4 * Math.sin(t * 21.7 + 1.3)));
function objLight(o, u) {
  if (!tune.objLight || u.ghost || u.flash || u.cell == null) return null;
  const P = o.sp.position, t = TIME_U.value, yaw = camera.rotation.y;
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);   // 画面の右
  let cx = camera.position.x - P.x, cz = camera.position.z - P.z;
  const cl = Math.hypot(cx, cz) || 1; cx /= cl; cz /= cl;   // こちら向き
  const y = Math.floor(u.cell / W), x = u.cell % W;
  const amb = tune.roomLight && rooms.some(r => !r.dark && y > r.top && y < r.bottom && x > r.left && x < r.right) ? 0.08 : 0;
  const ls = [];
  for (const L of LIGHTS_U.value) {
    if (!L.w) break;
    _ol.set(L.x - P.x, L.y - P.y, L.z - P.z);
    const d = _ol.length();
    if (d > 7) continue;
    const f = L.w * (1 + 7 * tune.flicker * (0.6 * Math.sin(t * 11.1 + L.x * 3 + L.z * 7) + 0.4 * Math.sin(t * 27 + L.x * 5)));   // 揺れは壁の 7 倍（形は小さく、色の差も出にくいので、同じ揺れでは見えない）
    const hx = _ol.x / d, hz = _ol.z / d;
    ls.push({ c: f / (1 + 0.6 * d * d * d), s: hx * rx + hz * rz, fr: hx * cx + hz * cz, warm: 1 });
  }
  ls.push({ c: 2.3 * handFlick(t) / (1 + tune.torch * o.dist * o.dist), s: 0, fr: 1, warm: 0 });   // 手元の明かり（正面から）
  return { amb, ls };
}
// 形の横の位置 cx（-1 = 左の端、1 = 右の端）での色。いつもの色のまま、燭台の光が当たる側だけを橙がかった明るい色へ寄せる
function litCol(hex, L, cx) {
  const n = Math.sqrt(Math.max(0, 1 - cx * cx));
  let e = L.amb, w = 0;   // e: 当たる光の強さ、w: そのうち燭台の分（橙に寄せる）
  for (const l of L.ls) { const k = Math.max(0, cx * l.s + n * l.fr), q = k * k * l.c * (l.warm ? 3.4 : 1); e += q; if (l.warm) w += q; }
  // 頭打ちにしない（明るい所でも、炎の揺らぎがいつも色に出る）。光の当たらない側は暗く沈む
  const v = e / (e + 0.5), wv = w / (e + 0.5), sc = 0.14 + 0.95 * v;   // 光の正面でも元の色の 8〜9 割ほど（元の色が明るい赤などでも、揺れが頭打ちにならない）
  const c = parseInt(hex.slice(1), 16), r = c >> 16 & 255, g = c >> 8 & 255, bl = c & 255;
  return `rgb(${Math.min(255, Math.round(r * sc + 130 * wv * v))},${Math.min(255, Math.round(g * sc + 60 * wv * v))},${Math.round(bl * sc * (1 - 0.3 * wv))})`;
}
// 足元の陰（床に立って見えるように）と、近くの燭台の光で反対側の床に伸びる影。
// 字の画面では床の点の間はもともと黒いので、上から黒を重ねても見えない。影の升は床の字そのものを暗くする（濃い所は消える）。
// 升ごとの影の濃さ（0〜1）を返す
const _sh = new THREE.Vector3();
let shadowBuf = new Float32Array(0);   // 毎回作らず使い回す
function shadowMask(C, R, depthOf) {
  if (shadowBuf.length !== C * R) shadowBuf = new Float32Array(C * R); else shadowBuf.fill(0);
  const mask = shadowBuf, SW = C * tcw, SH = R * tch, t = TIME_U.value;
  const scr = (x, z) => { _sh.set(x, 0.01, z).applyMatrix4(camera.matrixWorldInverse); if (_sh.z > -0.08) return null; _sh.applyMatrix4(camera.projectionMatrix); return [(_sh.x + 1) / 2 * C, (1 - _sh.y) / 2 * R]; };
  const fillPoly = (pts, a) => {   // 升の真ん中が多角形の中なら、その升に濃さ a
    const sp = pts.map(([x, z]) => scr(x, z));
    if (sp.some(q => !q)) return;
    const x0 = Math.max(0, Math.floor(Math.min(...sp.map(q => q[0])))), x1 = Math.min(C - 1, Math.ceil(Math.max(...sp.map(q => q[0]))));
    const y0 = Math.max(0, Math.floor(Math.min(...sp.map(q => q[1])))), y1 = Math.min(R - 1, Math.ceil(Math.max(...sp.map(q => q[1]))));
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const px = gx + 0.5, py = gy + 0.5;
      let inside = false;
      for (let i = 0, j = sp.length - 1; i < sp.length; j = i++) {
        const [xi, yi] = sp[i], [xj, yj] = sp[j];
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) mask[gy * C + gx] = Math.max(mask[gy * C + gx], a);
    }
  };
  const v3 = new THREE.Vector3();
  for (const sp of glyphGroup.children) {
    const u = sp.userData, P = sp.position;
    if (u.cell == null) continue;
    v3.copy(P).applyMatrix4(camera.matrixWorldInverse);
    const dist = -v3.z;
    if (dist < 0.3) continue;
    const c0 = scr(P.x, P.z);
    if (!c0 || c0[0] < -2 || c0[0] > C + 2 || c0[1] < -2 || c0[1] > R + 2) continue;
    const gx = Math.min(C - 1, Math.max(0, Math.floor(c0[0]))), gy = Math.min(R - 1, Math.max(0, Math.floor(c0[1])));
    if (depthOf(gx, gy) < dist - 0.6) continue;   // 足元が壁の向こう
    const mon = u.ch >= 'A' && u.ch <= 'Z';
    // 燭台の光で落ちる影（いちばん強く当たる燭台から、反対向きへ）
    let best = null, bc = 0;
    for (const L of LIGHTS_U.value) {
      if (!L.w) break;
      const d = Math.hypot(L.x - P.x, L.z - P.z);
      if (d > 3.2 || d < 0.05) continue;
      const c = L.w * (1 + 7 * tune.flicker * (0.6 * Math.sin(t * 11.1 + L.x * 3 + L.z * 7) + 0.4 * Math.sin(t * 27 + L.x * 5))) / (1 + 0.6 * d * d * d);
      if (c > bc) { bc = c; best = { dx: (P.x - L.x) / d, dz: (P.z - L.z) / d, d }; }
    }
    if (best && bc > 0.05) {
      const len = (mon ? 1.2 : 0.5) * Math.min(1.6, 0.8 + best.d * 0.35), w = mon ? 0.3 : 0.14;   // 燭台から離れるほど長く
      const px = -best.dz, pz = best.dx;
      fillPoly([[P.x + px * w, P.z + pz * w], [P.x + best.dx * len + px * w * 0.7, P.z + best.dz * len + pz * w * 0.7],
        [P.x + best.dx * len * 1.08, P.z + best.dz * len * 1.08], [P.x + best.dx * len - px * w * 0.7, P.z + best.dz * len - pz * w * 0.7], [P.x - px * w, P.z - pz * w]],
        Math.min(0.9, 0.35 + bc * 1.2));
    }
    // 足元の陰
    const r = mon ? 0.36 : 0.2, ring = [];
    for (let k = 0; k < 12; k++) ring.push([P.x + Math.cos(k / 12 * Math.PI * 2) * r, P.z + Math.sin(k / 12 * Math.PI * 2) * r * 0.8]);
    fillPoly(ring, 0.6);
  }
  return mask;
}
// 灰色の字を、燭台の光の分だけ暖かい色に
// 地形の字の色は 0xRRGGBB の数で扱う（升ごとに色の文字列を作ると、使い捨てのメモリが溜まる）
function rgb(r, g, b) {
  return Math.max(0, Math.min(255, Math.round(r))) << 16 | Math.max(0, Math.min(255, Math.round(g))) << 8 | Math.max(0, Math.min(255, Math.round(b)));
}

// 地形の字は 1 画面に数千あり、毎回 fillText で描くと iPhone（WebKit）がメモリを溜め込んで落ちる（2026-10-24。
// fillText を止めると増えないのを確かめた）。字の形を一度だけ描いて取っておき、色を掛けて画素へ直接書き、最後に 1 回で画面に出す
const glyph = { shapes: new Map(), cv: null, cx: null, img: null, px: null, px32: null };
if (document.fonts) document.fonts.addEventListener('loadingdone', () => glyph.shapes.clear());   // 字の形は字体が届いてから取り直す
function glyphShape(ch) {
  let sh = glyph.shapes.get(ch);
  if (sh) return sh;
  const fs = tch * 0.94 * tdpr, w = Math.ceil(fs * 1.4) + 4, h = Math.ceil(fs * 1.4) + 4, ox = w >> 1, oy = h >> 1;
  if (!glyph.cv) { glyph.cv = document.createElement('canvas'); glyph.cx = glyph.cv.getContext('2d', { willReadFrequently: true }); }
  const cv = glyph.cv, cx = glyph.cx;
  if (cv.width < w || cv.height < h) { cv.width = Math.max(cv.width, w); cv.height = Math.max(cv.height, h); }
  cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, w, h);
  cx.font = `400 ${fs}px "BIZ UDGothic", monospace`; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillStyle = '#fff';
  cx.fillText(ch, ox, oy);
  const d = cx.getImageData(0, 0, w, h).data, dx = [], dy = [], a = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = d[(y * w + x) * 4 + 3]; if (v) { dx.push(x - ox); dy.push(y - oy); a.push(v); } }
  sh = { dx: Int16Array.from(dx), dy: Int16Array.from(dy), a: Uint8Array.from(a) };
  glyph.shapes.set(ch, sh);
  return sh;
}
function glyphBegin() {   // 黒で塗った画素の入れ物を用意する
  if (!glyph.img || glyph.img.width !== tcv.width || glyph.img.height !== tcv.height) {
    glyph.img = tctx.createImageData(tcv.width, tcv.height); glyph.px = glyph.img.data; glyph.px32 = new Uint32Array(glyph.px.buffer);
  }
  glyph.px32.fill(0xff000000);
}
function glyphPut(ch, x, y, col) {   // x, y は字の真ん中（CSS の px）
  const sh = glyphShape(ch), W = glyph.img.width, H = glyph.img.height, px = glyph.px;
  const bx = Math.round(x * tdpr), by = Math.round(y * tdpr), r = col >> 16 & 255, g = col >> 8 & 255, b = col & 255;
  const { dx, dy, a } = sh;
  for (let i = 0; i < a.length; i++) {
    const X = bx + dx[i], Y = by + dy[i];
    if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
    const j = (Y * W + X) * 4, k = a[i] / 255;
    px[j] += (r - px[j]) * k; px[j + 1] += (g - px[j + 1]) * k; px[j + 2] += (b - px[j + 2]) * k;
  }
}
function warmGray(g, w) {
  if (w < 0.02) return rgb(g, g, g + 8);
  if (tune.warmHue) return rgb(g * (1 + 0.22 * w), g * (1 + 0.14 * w), g * (1 - 0.25 * w));   // 琥珀（黄寄り）
  return rgb(g * (1 + 0.45 * w) + 14 * w, g * (1 + 0.08 * w), g * (1 - 0.4 * w));
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];   // 点の密度を明るさで変えるときの順番（4×4）
const HEX_CACHE = new Map();
function tint(hex, v) {
  let n = HEX_CACHE.get(hex);
  if (n === undefined) { n = parseInt(hex.slice(1), 16); HEX_CACHE.set(hex, n); }
  const k = 0.25 + v * 0.75;
  return rgb((n >> 16 & 255) * k, (n >> 8 & 255) * k, (n & 255) * k);
}

// ASCII の濃さのつまみ: 壁の字の並び（暗い → 明るい）、壁・床の明るさ、天井の点の有無。
// 2026-10-22 に案を並べて見比べ、壁は . : の点描（* + や - = は横じまや重さでうるさい）、床は暗めに決めた
// sconce: 燭台の形、glow: 光の広さ（0 で光なし）、torch: 手元の明かりの落ち方（大きいほど闇が近い）、corrGap: 通路の燭台の間隔（0 でなし）。
// roomLight: 部屋を燭台の光で照らす、doorLight: 扉の口から光が漏れる、hand: 手元の明かりの当たり方、flicker: 炎の揺らぎ、ao: 隅の陰（2026-10-23）
const tune = { ramp: ' ...::::', wallV: 1, floorV: 0.45, passV: 0.4, ceil: true, sconce: 'B', glow: 1.0, torch: 3, corrGap: 3,
  roomLight: 1, doorLight: 1, hand: 1, flicker: 0.15, ao: 1, monView: 1, objLight: 1, fadeDark: 1, shadow: 1, ceilDither: 1, beam: 3, warm: 0.35, masonry: 1, flag: 1, soot: 1, bob: 1, warmHue: 1, wall: 3, texr: 2.5, flame: 3, halo: 0.3 };   // halo: 燭台の周りの光の輪の揺らぎ（広さ ±halo・明るさ ±1.5halo）   // flame: 燭台の炎を部屋の光と同じ揺らぎで動かす（1 明るさ・2 先の伸び縮みと横揺れ・3 芯の膨らみ）   // wall・masonry・flag・soot・texr: 壁や床の模様は遠くまで出すとうるさく、無いと物足りないので、手前 texr マスだけに出す（2026-10-23）   // fadeDark: 暗がりでは床・天井の字も消える、shadow: 足元の陰と燭台の影、ceilDither: 天井の点を明るい所だけに、beam: 天井の梁の間隔（2026-10-23 に 3 案から選んだ）、warm: 燭台の光の色（1.0・0.6 の赤橙は赤すぎたので、warmHue の琥珀で 0.35）、masonry: 壁の石組みと岩のざらつき、flag: 床の敷石、soot: 燭台の上のすす、bob: 歩くときの頭の上下   // objLight: モンスター・アイテムにも光の陰影   // monView: モンスターを見る向きで描き分ける
export function lights() { return LIGHTS_U.value.filter(v => v.w).map(v => [v.x, v.y, v.z, v.w]); }   // 確かめ用: 光源の場所
export function setTune(o) { Object.assign(tune, o); TORCH_U.value = tune.torch; BEAM_U.value = tune.beam; WALL_U.value = tune.wall; TEXR_U.value = tune.texr; if (lastGrid) build(lastGrid); draw(); }
const ROCK_RAMP = ' ..::';
function drawTerm() {
  if (!rt) return;
  // 1. 面の種類・明るさ・距離を升目の粗さで描いて読み出す
  const gv = glyphGroup.visible;
  glyphGroup.visible = false;
  for (const sp of flying) sp.visible = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(rt, 0, 0, tcols, trows, tbuf);
  renderer.setRenderTarget(null);
  glyphGroup.visible = gv;
  for (const sp of flying) sp.visible = true;

  const C = tcols, R = trows;
  const inside = (x, y) => x >= 0 && y >= 0 && x < C && y < R;
  const at = (x, y) => ((R - 1 - y) * C + x) * 4;   // 読み出しは下の行から
  const depthOf = (x, y) => { if (!inside(x, y)) return 99; const i = at(x, y); return tbuf[i + 3] ? tbuf[i + 3] / 255 * 16 : 99; };

  drawLines(C, R, depthOf);
  const lines = lineOut.ch, lineV = lineOut.v;
  const lights = sconceLights(C, R);
  const tnow = performance.now(), warpK = Math.max(0, 1 - (tnow - trans.warpT0) / WARP_MS);
  tctx.fillStyle = '#000'; tctx.fillRect(0, 0, C * tcw, (R + 1) * tch);
  tctx.font = `400 ${fpx(tch * 0.94)}px "BIZ UDGothic", monospace`;
  tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
  const shadow = tune.shadow ? shadowMask(C, R, depthOf) : null;
  if (!mood.halu) glyphBegin();
  for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
    const i = at(x, y);
    // 2. 壁の輪郭の線が通る升は、線の傾きに合った字（drawLines で決めたもの）。面がない所（闇との境）にも引く
    const ln = lines[y * C + x];   // 輪郭の字（なければ null）
    if (!tbuf[i + 3] && !ln) continue;
    const kind = tbuf[i + 3] ? Math.round(tbuf[i + 1] / 255 * 15) : 0;
    const sh = shadow && (kind === 4 || kind === 5 || kind === 10 || kind === 11) ? shadow[y * C + x] : 0;   // 床に落ちた影
    const lit = tbuf[i] / 255 * (1 - sh);
    if (lit < 0.03 && !ln) continue;
    let ch = null, v = lit;
    if (ln) {
      ch = ln; v = Math.min(1, lineV[y * C + x] * 1.2 + 0.12);
    } else if (kind === 2 && tbuf[i + 3] / 255 * 16 < SECRET_NEAR) {
      ch = (x * 7 + y * 3) % 4 === 0 ? ',' : tune.ramp[Math.min(tune.ramp.length - 1, Math.floor(lit * tune.ramp.length))]; v = lit * tune.wallV;
    } else if (kind === 1 || kind === 2) {
      ch = tune.ramp[Math.min(tune.ramp.length - 1, Math.floor(lit * tune.ramp.length))]; v = lit * tune.wallV;
    } else if (kind === 3) {
      ch = ROCK_RAMP[Math.min(ROCK_RAMP.length - 1, Math.floor(lit * ROCK_RAMP.length))]; v = lit * 0.6;
    } else if (kind === 4) { ch = '.'; v = lit * tune.floorV; }
    else if (kind === 5) { ch = '#'; v = lit * tune.passV; }
    else if (kind === 10 || kind === 11) {   // 見つけていない罠の床: 近くでは , に、遠くでは普通の床
      const near = tbuf[i + 3] / 255 * 16 < SECRET_NEAR;
      ch = near ? ',' : kind === 10 ? '.' : '#'; v = lit * (kind === 10 ? tune.floorV : tune.passV);
    }
    else if (kind === 6) { ch = tbuf[i + 2] < 64 ? '=' : '|'; }   // 扉の木（縦の面は縦板の |、横木の下面などは =）
    else if (kind === 8) {   // 階段の段（踏み面 = 、蹴込み #）。上り階段は蹴込みと横を暗くして、踏み面の = を目立たせる
      const flat = tbuf[i + 2] < 64;
      ch = flat ? '=' : '#'; v = Math.min(1, lit * 1.1 + 0.1) * (upStairs && !flat ? 0.45 : 1);
    }   // 下り階段の段（踏み面 = 、蹴込み #）
    else if (kind === 9) { ch = '^'; v = Math.min(1, lit * 1.1 + 0.1); }
    else if (kind === 7) {   // 天井はまばらに。ceilDither では明るい所ほど点が密になる（燭台の上が明るく溜まる）
      if (tune.ceilDither) { ch = tune.ceil && Math.min(0.75, Math.max(0, (lit - 0.42) * 1.5)) > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 ? '`' : ' '; v = lit * 0.6; }
      else { ch = tune.ceil && x % 3 === 0 && y % 2 === 0 ? '`' : ' '; v = lit * 0.4; }
    }
    else if (kind === 12) { ch = '='; v = Math.min(1, lit * 1.3); }   // 天井の梁
    if (!ch || ch === ' ') continue;
    const g = Math.round((tune.fadeDark ? 40 * Math.min(1, lit / 0.3) : 40) + v * 215);   // 字の明るさの下限も、光が弱いほど下げる（暗がりでは床・天井の字も闇に消える）
    let tx = (x + 0.5) * tcw;
    if (warpK > 0) {
      if (Math.random() < warpK * 0.7) ch = WARP_CHARS[(Math.random() * WARP_CHARS.length) | 0];
      tx += Math.sin(y * 0.55 + tnow / 45) * tcw * 3 * warpK;
    }
    if (mood.halu) {   // 幻覚: 升ごとに色相をずらし、時間で流す
      tctx.fillStyle = `hsl(${(x * 9 + y * 13 + performance.now() / 8) % 360},80%,${Math.round(18 + v * 52)}%)`;
      tctx.fillText(ch, (x + 0.5) * tcw + Math.sin(performance.now() / 300 + y * 0.6) * tcw * 0.35, (y + 0.5) * tch + tch * 0.04);
      continue;
    }
    let fill = ln ? rgb(30 + v * 113, 40 + v * 139, 60 + v * 195)   // 境界線は青
      : kind === 6 ? tint('#d39a5c', v)
      : kind === 8 ? tint(stairsColor, v) : kind === 9 ? tint(DECALS['^'].color, v) : kind === 12 ? tint('#9a7a58', v) : warmGray(g, (tbuf[i + 2] & 63) / 63);
    if (lights.length && !ln && (kind !== 7 || tune.ceilDither)) {   // 燭台の光: 近くの字を橙に明るく
      const k = glowAt(lights, x, y, tbuf[i + 3] / 255 * 16);
      if (k > 0.02) fill = rgb(g + 150 * k, g + 70 * k, g * (1 - 0.4 * k));
    }
    glyphPut(ch, tx, (y + 0.5) * tch + tch * 0.04, fill);
  }
  if (!mood.halu) tctx.putImageData(glyph.img, 0, 0);

  drawSconces(C, R, depthOf);

  // 3. モンスター・アイテム・飛んでいる物: 升目に写して、壁の向こうでなければ描く（近いほど大きく）
  const list = [];
  const v3 = new THREE.Vector3();
  for (const sp of [...glyphGroup.children, ...flying]) {
    v3.copy(sp.position).applyMatrix4(camera.matrixWorldInverse);
    const dist = -v3.z;
    if (dist < 0.15) continue;
    v3.copy(sp.position).project(camera);
    if (Math.abs(v3.x) > 1.1 || Math.abs(v3.y) > 1.1) continue;
    const cx = (v3.x + 1) / 2 * C, cy = (1 - v3.y) / 2 * R;
    const ix = Math.min(C - 1, Math.max(0, Math.floor(cx))), iy = Math.min(R - 1, Math.max(0, Math.floor(cy)));
    const behind = depthOf(ix, iy) < dist - 0.45;   // 壁の向こう: 探知で見えている物だけ、透けた形で描く
    if (behind && !sp.userData.det) continue;
    const hPx = sp.scale.y / (2 * dist * Math.tan(camera.fov * Math.PI / 360)) * R * tch;
    list.push({ sp, dist, ghost: behind, px: cx * tcw, py: cy * tch, size: Math.max(tch * 0.95, Math.min(R * tch * 0.6, hPx * 1.15)) * (1 + 0.3 * (sp.userData.lunge || 0)) });   // 上限は画面の高さに対して（升目の大きさで変わらないように）
  }
  list.sort((a, b) => b.dist - a.dist);   // 遠い物から
  for (const o of list) {
    const u = o.sp.userData;
    const fade = 1 - Math.min(0.75, Math.max(0, (o.dist - 2) / 12));
    tctx.globalAlpha = (u.dim ? 0.5 : 1) * fade * (o.ghost ? 0.5 : 1);
    const st = u.cell != null && u.ch >= 'A' && u.ch <= 'Z' ? monState.get(u.cell) : null;
    const uu = { ...u, st, ghost: o.ghost, ...(u.flash ? { col: '#ffffff' } : {}) };
    uu.L = objLight(o, uu);
    const amu = u.ch === ',' && !u.flying;   // イェンダーの魔除け: ほかの物と違って輝いて見える
    if (u.flying) o.size = Math.min(o.size, R * tch * 0.14);   // 飛んでいる物は字 1 つで、手元でも大きくなりすぎないように
    else if (drawArt(o, uu)) { if (amu) amuletGlow(o, performance.now()); continue; }
    tctx.font = `700 ${fpx(o.size)}px "BIZ UDGothic", monospace`;
    tctx.fillStyle = '#000';
    const w = tctx.measureText(u.ch).width;
    if (!o.ghost) tctx.fillRect(o.px - w / 2 - 1, o.py - o.size / 2, w + 2, o.size);   // 後ろの字を消して読みやすく
    tctx.fillStyle = uu.L ? litCol(uu.col || '#c8ccd1', uu.L, 0) : (uu.col || '#c8ccd1');
    tctx.fillText(u.ch, o.px, o.py + o.size * 0.04);
    if (amu) amuletGlow(o, performance.now());
  }
  tctx.globalAlpha = 1;
}

// 魔除けの輝き: 周りに光の粒（. + *）がまたたき、消えては別の所に現れる（宝石が光を受けてきらめくように）。
// 2026-10-25 に 3 案（きらめき・光の柱・後光）から、現実の光り方に近いきらめきを選んだ
const AMU_COLS = ['#fff6d0', '#ffe08a', '#f0c652'];
function amuletGlow(o, now) {
  const a0 = tctx.globalAlpha, S = Math.max(8, o.size), cx = o.px, cy = o.py;
  for (let i = 0; i < 9; i++) {
    const ph = (now / 900 + i * 0.37) % 1, tw = Math.sin(ph * Math.PI);
    const ang = i * 2.4 + Math.floor(now / 900 + i * 0.37) * 1.7, rad = S * (0.45 + 0.4 * ((i * 0.618) % 1));
    tctx.globalAlpha = a0 * tw;
    tctx.font = `700 ${fpx(S * (0.18 + 0.14 * tw))}px "BIZ UDGothic", monospace`;
    tctx.fillStyle = AMU_COLS[i % 3];
    tctx.fillText(tw > 0.7 ? '*' : tw > 0.35 ? '+' : '.', cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad * 0.8);
  }
  tctx.globalAlpha = a0;
}

// ---------------------------------------------------------------------------
// カメラ（歩く・向きを変えるときは少しだけ滑らかに動かす）
// ---------------------------------------------------------------------------
let cam = null, from = null, to = null, t0 = 0, animating = false;
const DUR = 140;
const yawOf = f => -f * Math.PI / 4;

function target() { return { x: player[1] + 0.5, z: player[0] + 0.5, yaw: yawOf(facing) }; }
function startMove() {
  if (!player) return;
  const tg = target();
  if (!cam) { cam = { ...tg }; return; }
  // 遠くへ飛んだ（階段・テレポート）ときは滑らせない
  if (Math.hypot(tg.x - cam.x, tg.z - cam.z) > 1.6) { cam.x = tg.x; cam.z = tg.z; }
  animateTo(tg);
}
function animateTo(tg) {
  from = { ...cam };
  // 回る向きは近いほうへ
  let d = tg.yaw - from.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  to = { ...tg, yaw: from.yaw + d };
  t0 = performance.now();
  if (!animating) { animating = true; requestAnimationFrame(tick); }
}
function tick(now) {
  const dur = mood.haste ? DUR * 0.5 : mood.slow ? DUR * 2.2 : DUR;   // 加速中は速く、減速中はゆっくり動く
  const k = Math.min(1, (now - t0) / dur), e = k * (2 - k);
  cam.x = from.x + (to.x - from.x) * e; cam.z = from.z + (to.z - from.z) * e; cam.yaw = from.yaw + (to.yaw - from.yaw) * e;
  cam.bob = from.x !== to.x || from.z !== to.z ? Math.sin(k * Math.PI) * 0.045 * tune.bob : 0;   // 歩くときは一歩ごとに頭が少し沈む
  draw();
  if (k < 1) requestAnimationFrame(tick); else animating = false;
}

export function turn(d) {
  facing = (facing + d + 8) % 8;
  try { localStorage.setItem('rogue3d-facing', facing); } catch {}
  if (lastGrid) look(lastGrid);
  if (lastGrid) build(lastGrid);   // 床に描いた字（階段・罠）の向きを合わせ直す
  if (player && cam) animateTo(target());
}

// 投げた物が飛んでいく様子: 自分のマスから道筋に沿って滑らかに動かす（ゲームは step × マス数 だけ待っている）
export function missile(m) {
  if (!renderer || !player || !m.path.length) return;
  const col = (m.style & 15) ? PALETTE[(m.style & 15) - 1] : '#c8ccd1';
  const sp = new THREE.Sprite(SPRITE_MAT);
  sp.scale.set(0.4, 0.4, 1);
  sp.userData = { ch: m.ch, col, flying: true };
  scene.add(sp); flying.add(sp);
  const pts = [player, ...m.path], dur = m.step * m.path.length, t0 = performance.now();
  const bolt = '|-/\\'.includes(m.ch);   // 杖の光線は、通った所に光が尾を引く
  if (bolt) sp.userData.ch = '*';
  const toss = !bolt && fx.toss && t0 - fx.toss.t0 < 600 ? fx.toss : null;
  const spin = toss && toss.w === 7, streak = toss && (toss.w === 3 || toss.w === 6);   // 手裏剣は回る、矢・ダーツは筋を引く
  if (toss && TOSS_FLY[toss.w]) sp.userData.ch = TOSS_FLY[toss.w];
  let lastStreak = 0;
  let passed = 0;
  const frame = now => {
    const k = Math.max(0, Math.min(1, (now - t0) / dur)) * (pts.length - 1);   // 描く時刻は t0 より少し前のことがある（そのままだと -1 番目のマスを読んで落ちる）
    const i = Math.min(pts.length - 2, Math.floor(k)), f = k - i;
    if (bolt) while (passed <= i) { const [ty, tx] = pts[passed++ + 1] || []; if (ty != null) { fx.trail.push({ y: ty, x: tx, t0: now, col }); startFx(); } }
    const y = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, x = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
    sp.position.set(x + 0.5, 0.42, y + 0.5);
    if (spin) sp.userData.ch = '*+x+'[Math.floor(now / 45) % 4];
    if (streak && k > 0.7 && now - lastStreak > 16) { lastStreak = now; fx.trail.push({ y, x, t0: now, col: '#c8ccd1', ch: '-', ms: 160 }); startFx(); }
    draw();
    if (k < pts.length - 1) requestAnimationFrame(frame); else { scene.remove(sp); flying.delete(sp); draw(); }
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// 演出: 敵に当てた（白く点滅して震え、ダメージの数字が浮かぶ。倒したら字が飛び散る）、
// 自分がくらった（画面が揺れ、殴ってきた方向の端が赤く光る）。ゲームから rogue_effect で届く
// ---------------------------------------------------------------------------
const fx = { doorGlow: [], breaths: [], burn: null, gaze: null, frost: null, hits: [], nums: [], debris: [], pops: [], trail: [], shakeT0: -1e9, lastHp: null, swing: null, toss: null, lunges: [], claws: [], busyUntil: 0, hurtAt: null, hurtSoon: 0 };
let fxcv, fxctx, hurtEl, blindEl, fxRunning = false;
// 武器を振る: 手元（右下）から、握り→刃先の順の字を棒のように並べて振り下ろす。w は 5.4 の武器の番号（-1 は素手）
const SWING_MS = 420, SWING_HIT = 150;   // SWING_HIT: 振り始めから敵に届くまで（当たりの演出はここから）
const SWING_ART = {
  '-1': '(#)',                 // 素手: 拳（振らずに突き出す）
  0: '==-----(@)',             // メイス
  1: '==+========>',           // 長剣
  2: '==-)',                   // 弓
  3: '----->',                 // 矢
  4: '=+===>',                 // 短剣
  5: '===+=============>',     // 両手剣
  6: '=->',                    // ダーツ
  7: '=*',                     // 手裏剣
  8: '=------------<>',        // 槍
};
const HIT_MS = 260, NUM_MS = 800, DEBRIS_MS = 650, SHAKE_MS = 320, POP_MS = 900, TRAIL_MS = 450;
const BREATH_STEP = 55, BREATH_FADE = 450, BURN_MS = 750, GAZE_MS = 900, FROST_IN = 450, THAW_MS = 700;   // 炎が 1 マス伸びる間・伸びきってから消えるまで・燃え上がる炎
const FLAME_COLS = ['#fff1a8', '#ffd25a', '#ff9a3a', '#ff5a2a', '#d8321e'];   // 芯（明るい黄）から外（赤）へ

function initFx(canvas) {
  fxcv = document.createElement('canvas');
  fxcv.id = 'v3fx'; fxcv.setAttribute('aria-hidden', 'true');
  canvas.parentElement.append(fxcv);
  fxctx = fxcv.getContext('2d');
  hurtEl = document.createElement('div');
  hurtEl.id = 'v3hurt'; hurtEl.setAttribute('aria-hidden', 'true');
  canvas.parentElement.append(hurtEl);
  blindEl = document.createElement('div');   // 盲目: 足元の少しだけ残して暗くする
  blindEl.id = 'v3blind'; blindEl.setAttribute('aria-hidden', 'true');
  canvas.parentElement.append(blindEl);
}
function sizeFx(w, h) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  fxcv.width = Math.round(w * dpr); fxcv.height = Math.round(h * dpr);
  fxctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function effect(d) {
  const now = performance.now();
  if (d.type === 'hurtsoon') {   // くらった知らせはメッセージを読み進めてから来る。それまで状態行の HP が減っても揺らさない
    fx.hurtSoon = now;
  } else if (d.type === 'mattack') {   // 敵が殴りかかってくる: こちらへ踏み込んで戻る。当たれば踏み込みきった所で爪あと
    // 順番に見せる: こちらの振りが届いて止まるまで、ほかの敵が殴っていればその踏み込みが終わるまで待つ（待ちすぎない）
    const start = Math.min(now + 700, Math.max(now, fx.busyUntil));
    fx.busyUntil = start + 260;
    fx.hurtAt = { made: now, at: start + LUNGE_HIT };
    fx.lunges.push({ y: d.y, x: d.x, t0: start, hit: !!d.hit });
    if (d.hit && ATTACK_KIND[d.ch] !== 'none') fx.claws.push({ t0: start + LUNGE_HIT, seed: Math.random(), kind: ATTACK_KIND[d.ch] || 'claw', ch: d.ch });
  } else if (d.type === 'breath') {   // ドラゴンの炎: 口からこちらへ炎が伸びてくる。当たったら画面の下から炎が燃え上がる
    const start = Math.max(now, Math.min(now + 700, fx.busyUntil)), ms = BREATH_STEP * d.path.length;
    fx.busyUntil = start + ms;
    fx.breaths.push({ from: [d.y, d.x], path: d.path, t0: start, ms });
    if (d.hit) { fx.burn = { t0: start + ms }; fx.hurtAt = { made: now, at: start + ms }; }
  } else if (d.type === 'doorglow') {   // 暗い通路の先に見える、明るい部屋の扉の口の光
    fx.doorGlow = d.cells || [];
    draw();
    return;
  } else if (d.type === 'gaze') {   // メデューサのにらみ: 目が光り、視線の輪がこちらへ押し寄せる
    const start = Math.max(now, Math.min(now + 700, fx.busyUntil));
    fx.busyUntil = start + GAZE_MS;
    fx.gaze = { y: d.y, x: d.x, t0: start };
  } else if (d.type === 'freeze') {   // 凍らされた: 殴られた所から、画面のふちに霜が張る
    const start = fx.hurtAt && now - fx.hurtAt.made < 60 ? fx.hurtAt.at : now;
    if (!fx.frost || fx.frost.thaw) fx.frost = { t0: start, para: false, thaw: null };
  } else if (d.type === 'throw') {
    fx.toss = { t0: now, w: d.w, ch: d.ch || ')', fired: !!d.fired };
  } else if (d.type === 'swing') {
    fx.swing = { t0: now, w: d.w in SWING_ART ? d.w : -1, hit: !!d.hit };
    fx.busyUntil = Math.max(fx.busyUntil, now + 320);   // 敵の反撃は、こちらの刃が届いて止まってから
  } else if (d.type === 'hit') {
    const delay = fx.swing && now - fx.swing.t0 < 60 ? SWING_HIT : 0;   // 振った刃が届いてから当たりを見せる
    const t0 = now + delay;
    const cell = lastGrid && lastGrid[d.y] && lastGrid[d.y][d.x];
    const ch = cell ? cell[0] : '*', col = cell && (cell[1] & 15) ? PALETTE[(cell[1] & 15) - 1] : '#ff6a5c';
    fx.hits.push({ y: d.y, x: d.x, t0 });
    fx.nums.push({ y: d.y, x: d.x, t0, text: '-' + d.dmg });
    if (d.killed) {
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.2;
        fx.debris.push({ y: d.y, x: d.x, t0, ch, col, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 0.8 + Math.random() * 1.6, h: 0.2 + Math.random() * 0.5 });
      }
    }
  } else if (d.type === 'teleport') {
    pendingWarp = true;
    return;
  } else if (d.type === 'descend') {
    trans.how = d.how in DESCEND_MS ? d.how : 'stairs'; trans.t0 = performance.now();
    trans.col = BRIGHT_TRANS.has(trans.how) ? '#fff' : '#000';
  } else if (d.type === 'amulet') {
    upStairs = !!d.has;
    if (lastGrid) { build(lastGrid); draw(); }
    return;
  } else if (d.type === 'mapped') {   // 魔法の地図: 分かっている所を全部、地図に載せる
    if (lastGrid) for (let y = MAP_TOP; y <= MAP_BOT; y++) for (let x = 0; x < W; x++) if (cellAt(lastGrid, y, x)[0] !== ' ') seen.add(y * W + x);
    saveSeen();
    return;
  } else if (d.type === 'traps') {
    trapCells = new Set(d.cells.map(([y, x]) => y * W + x));
    if (lastGrid) { build(lastGrid); draw(); }
    return;
  } else if (d.type === 'mons') {
    const prev = monList;
    monList = d.mons.map(([y, x, sleep, hp], i) => {
      // 向き: 動いたらその向き。動かず起きていれば（隣で殴り合うなど）こちらを向く。眠っていれば場所で決まった向き
      // 並びはゲームのモンスターの並びと同じなので、同じ番目が近くにいれば同じモンスターとみなす
      const o = prev.length === d.mons.length ? prev[i] : prev.find(q => Math.max(Math.abs(q.y - y), Math.abs(q.x - x)) <= 2 && !d.mons.some(([y2, x2]) => y2 === q.y && x2 === q.x));
      let face = o && Math.max(Math.abs(o.y - y), Math.abs(o.x - x)) <= 2 ? o.face : null;
      if (o && face && (o.y !== y || o.x !== x)) face = [Math.sign(y - o.y), Math.sign(x - o.x)];
      if (!sleep && player && Math.max(Math.abs(player[0] - y), Math.abs(player[1] - x)) <= 1) face = [Math.sign(player[0] - y), Math.sign(player[1] - x)];
      if (!face) face = sleep ? DIRS[(y * 7 + x * 13) % 8] : player ? [Math.sign(player[0] - y), Math.sign(player[1] - x)] : [1, 0];
      if (!face[0] && !face[1]) face = [1, 0];
      return { y, x, face };
    });
    monState = new Map(d.mons.map(([y, x, sleep, hp], i) => [y * W + x, { sleep: !!sleep, hp, face: monList[i].face }]));
    if (lastGrid) draw();
    return;
  } else if (d.type === 'rooms') {
    rooms = d.rooms.map(([top, left, bottom, right, dark]) => ({ top, left, bottom, right, dark: !!dark }));
    if (lastGrid) { build(lastGrid); draw(); }
    return;
  } else if (d.type === 'secrets') {
    secretCells = new Set(d.cells.map(([y, x]) => y * W + x));
    if (lastGrid) { build(lastGrid); draw(); }
    return;
  } else if (d.type === 'hurt') {
    fx.hurtSoon = 0;
    const from = d.y == null ? null : [d.y, d.x];
    if (fx.hurtAt && now - fx.hurtAt.made < 60) setTimeout(() => { hurt(from); startFx(); }, fx.hurtAt.at - now);   // 踏み込みきってから揺らす
    else hurt(from);
  }
  startFx();
}

// くらった: 揺らして、殴ってきた方向の端を赤く（方向が分からないときは画面のふち全体をうっすら）
function hurt(from) {
  fx.shakeT0 = performance.now();
  let side = 'all';
  if (from && player) {
    const dy = Math.sign(from[0] - player[0]), dx = Math.sign(from[1] - player[1]);
    const abs = DIRS.findIndex(([a, b]) => a === dy && b === dx);
    const rel = abs < 0 ? 0 : (abs - facing + 8) % 8;
    side = rel === 0 ? 'front' : rel <= 2 ? 'right' : rel <= 5 ? 'back' : 'left';   // 右回りに数えた 8 方向
  }
  const red = 'rgba(255, 40, 30, .75)';
  hurtEl.style.background = {
    left: `linear-gradient(to right, ${red}, transparent 32%)`,
    right: `linear-gradient(to left, ${red}, transparent 32%)`,
    back: `linear-gradient(to top, ${red}, transparent 35%)`,
    front: `radial-gradient(ellipse at center, transparent 45%, rgba(255, 40, 30, .45))`,
    all: `radial-gradient(ellipse at center, transparent 50%, rgba(255, 40, 30, .5))`,
  }[side];
  hurtEl.style.transition = 'none'; hurtEl.style.opacity = '1';
  void hurtEl.offsetWidth;   // いったん描かせてから消えていくように
  hurtEl.style.transition = 'opacity .7s ease-out'; hurtEl.style.opacity = '0';
}

// 壁（- |）だった所が扉（+）に、岩だと思っていた所が通路（#）に変わったら、隠し扉・隠し通路を見つけた演出。
// 階が変わったときは比べない
let prevRows = null;
function findReveals(grid, sameLevel) {
  const rows = [];
  for (let y = MAP_TOP; y <= MAP_BOT; y++) rows.push((grid[y] || []).map(c => c ? c[0] : ' ').join(''));
  if (prevRows && sameLevel) {
    for (let y = MAP_TOP; y <= MAP_BOT; y++) {
      const a = prevRows[y - MAP_TOP], b = rows[y - MAP_TOP];
      if (a === b) continue;
      for (let x = 0; x < Math.min(a.length, b.length); x++) {
        if ((a[x] === '-' || a[x] === '|') && b[x] === '+') reveal(y, x, a[x]);
        else if (a[x] === ' ' && b[x] === '#' && rock.has(y * W + x)) { rock.delete(y * W + x); reveal(y, x, ':'); }
      }
    }
  }
  prevRows = rows;
}
function reveal(y, x, ch) {
  const now = performance.now();
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 1.1;
    fx.debris.push({ y, x, t0: now, ch, col: '#c8ccd1', vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 0.3 + Math.random() * 1.2, h: Math.random() * 0.95 });
  }
  fx.pops.push({ y, x, t0: now, ch: ch === ':' ? '#' : '+' });
  startFx();
}

// 自分の状態（状態行の表示から読む）: 幻覚 = 壁が虹色に揺れる、混乱 = 視界がふらつく、盲目 = 暗転、
// 浮遊 = 視点が高い、加速・減速 = 歩く動きが速い・遅い
const mood = { halu: false, conf: false, blind: false, lev: false, haste: false, slow: false };
let eye = EYE;
function watchStatus(grid) {
  const t = (grid[23] || []).filter(Boolean).map(c => c[0]).join('');
  const was = moodActive();
  mood.halu = /幻覚|Halu/.test(t); mood.conf = /混乱|Conf/.test(t); mood.blind = /盲目|Blind/.test(t);
  mood.lev = /浮遊|Lev/.test(t); mood.haste = /加速|Haste/.test(t); mood.slow = /減速|Slow/.test(t);
  // 凍っている間は状態行に「麻痺」が出る。消えたら（一度も見えないまましばらく経ったときも）霜が割れて落ちる
  if (fx.frost && !fx.frost.thaw) {
    const now = performance.now();
    if (/麻痺|Para/.test(t)) fx.frost.para = true;
    else if (fx.frost.para || now - fx.frost.t0 > 1500) { fx.frost.thaw = Math.max(now, fx.frost.t0 + FROST_IN); startFx(); }
  }
  if (blindEl) blindEl.classList.toggle('on', mood.blind);
  if (moodActive() && !was) startFx();
}
const moodActive = () => mood.halu || mood.conf || Math.abs(eye - (mood.lev ? EYE + 0.3 : EYE)) > 0.005;

// 状態行の HP が減ったのに知らせがなかったとき（罠・毒・空腹など）も揺らす
function watchHp(grid) {
  const status = (grid[23] || []).filter(Boolean).map(c => c[0]).join('');
  const m = status.match(/HP:\s*(\d+)/i);
  if (!m) return;
  const hp = +m[1];
  if (fx.lastHp !== null && hp < fx.lastHp && performance.now() - fx.shakeT0 > 400 && !(fx.hurtAt && performance.now() < fx.hurtAt.at + 400) && !(fx.hurtSoon && performance.now() - fx.hurtSoon < 60000)) { hurt(null); startFx(); }
  fx.lastHp = hp;
}

const fxActive = now => fx.breaths.length || !!fx.burn || !!fx.gaze || !!fx.frost || transActive(now) || now - fx.shakeT0 < SHAKE_MS || fx.hits.length || fx.nums.length || fx.debris.length || fx.pops.length || fx.trail.length || !!fx.swing || !!fx.toss || fx.lunges.length || fx.claws.length || moodActive();
function startFx() {
  if (fxRunning) return;
  fxRunning = true;
  requestAnimationFrame(function tick(now) {
    fx.hits = fx.hits.filter(h => now - h.t0 < HIT_MS);
    fx.nums = fx.nums.filter(n => now - n.t0 < NUM_MS);
    fx.debris = fx.debris.filter(p => now - p.t0 < DEBRIS_MS);
    fx.pops = fx.pops.filter(p => now - p.t0 < POP_MS);
    fx.trail = fx.trail.filter(p => now - p.t0 < (p.ms || TRAIL_MS));
    fx.breaths = fx.breaths.filter(b => now - b.t0 < b.ms + BREATH_FADE);
    if (fx.burn && now - fx.burn.t0 > BURN_MS) fx.burn = null;
    if (fx.gaze && now - fx.gaze.t0 > GAZE_MS) fx.gaze = null;
    if (fx.frost && (fx.frost.thaw ? now - fx.frost.thaw > THAW_MS : now - fx.frost.t0 > 60000)) fx.frost = null;
    if (fx.toss && now - fx.toss.t0 > TOSS_MS) fx.toss = null;
    fx.lunges = fx.lunges.filter(l => now - l.t0 < LUNGE_MS);
    fx.claws = fx.claws.filter(c => now - c.t0 < CLAW_MS);
    if (fx.swing && now - fx.swing.t0 > SWING_MS) fx.swing = null;
    draw();
    if (fxActive(now)) requestAnimationFrame(tick);
    else { fxRunning = false; draw(); }
  });
}

// 当てたモンスターの札を震わせる（draw の間だけ位置をずらす）。点滅は ASCII では drawTerm、ほかは材質を白に
function hitAt(y, x, now) { return fx.hits.find(h => h.y === y && h.x === x && now >= h.t0 && now - h.t0 < HIT_MS); }
function jitterSprites(now, on) {
  if (!fx.hits.length && !fx.lunges.length) return;
  for (const sp of glyphGroup.children) {
    const y = Math.round(sp.position.z - 0.5), x = Math.round(sp.position.x - 0.5);
    if (on) {
      const l = player && fx.lunges.find(l => l.y === y && l.x === x);
      if (l && now >= l.t0) {   // 踏み込み: 速く前へ出て、ゆっくり戻る
        const ms = now - l.t0, q = ms < LUNGE_HIT ? Math.sin(ms / LUNGE_HIT * Math.PI / 2) : Math.max(0, 1 - (ms - LUNGE_HIT) / (LUNGE_MS - LUNGE_HIT)) ** 2;
        sp.userData.base = sp.position.clone();
        sp.position.x += (player[1] - x) * 0.42 * q; sp.position.z += (player[0] - y) * 0.42 * q; sp.position.y -= 0.04 * q;
        sp.userData.lunge = q;   // 隣の敵は大きさの上限に当たっていて近づいても大きくならないので、描くときに膨らませる
      }
      const h = hitAt(y, x, now); if (!h) continue;
      const k = 1 - (now - h.t0) / HIT_MS;
      if (!sp.userData.base) sp.userData.base = sp.position.clone();
      sp.position.x += (Math.random() - 0.5) * 0.12 * k; sp.position.y += (Math.random() - 0.5) * 0.06 * k;
      sp.userData.flash = ((now - h.t0) / 65 | 0) % 2 === 0;
    } else if (sp.userData.base) {
      sp.position.copy(sp.userData.base); sp.userData.base = null; sp.userData.flash = false; sp.userData.lunge = 0;
    }
  }
}

// ダメージの数字と飛び散る字（どの見た目でも上に重ねて描く）
const _v = new THREE.Vector3();
// 暗い通路の先の、明るい部屋の扉の口の光: まだ分からない所越しにぼんやり見える暖かい光。遠いほど薄い。
// ゲームが「本当に一直線に見通せる」と知らせた口だけ。間のマスがもう分かっていれば、ふつうの漏れる光（lamps）で見えるので描かない
const GLOW_COLS = ['#ffe6a8', '#f0c070', '#c8873a'];
function drawDoorGlow(now) {
  if (!fx.doorGlow.length || !player || !lastGrid) return;
  const [py, px] = player;
  for (const [gy, gx, dist] of fx.doorGlow) {
    let hidden = false;   // 間に、まだ分からない所（ふた）があるか
    for (let i = 1; i < dist; i++) {
      const y = py + Math.round((gy - py) * i / dist), x = px + Math.round((gx - px) * i / dist);
      if (cellAt(lastGrid, y, x)[0] === ' ' && !rock.has(y * W + x)) { hidden = true; break; }
    }
    if (!hidden && cellAt(lastGrid, gy, gx)[0] !== ' ') continue;
    const p = project(gx + 0.5, 0.45, gy + 0.5); if (!p) continue;
    const s = Math.max(0.15, 1 - dist / 18), R = Math.max(6, Math.min(80, p.unit * 0.5));
    const size = Math.max(9, Math.min(26, p.unit * 0.18));
    fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
    for (let i = 0; i < 14; i++) {
      const sd = Math.sin(i * 12.9898 + gx * 78.233 + gy * 37.719) * 43758.5, q = sd - Math.floor(sd);
      const a = i * 2.39996, r = R * Math.sqrt((i + 0.5) / 14);
      const fl = 0.75 + 0.25 * Math.sin(now / 180 + i * 1.7);   // 炎の揺らぎ
      fxctx.globalAlpha = s * fl * (1 - r / (R * 1.1)) * 0.75;
      fxctx.fillStyle = GLOW_COLS[Math.min(2, Math.floor(r / R * 3))];
      fxctx.fillText(r < R * 0.35 ? '*' : q < 0.5 ? ':' : '.', p.px + Math.cos(a) * r, p.py + Math.sin(a) * r * 0.7);
    }
  }
  fxctx.globalAlpha = 1;
}

// ドラゴンの炎: 口から伸びる炎の帯。先ほど太く明るく、根元から消えていく。字は揺らめくように入れ替わる
function drawBreath(b, now) {
  const pts = [b.from, ...b.path], n = pts.length - 1, t = now - b.t0;
  if (t < 0) return;
  const head = Math.min(1, t / b.ms) * n, fade = Math.max(0, (t - b.ms) / BREATH_FADE);
  const end = Math.min(head, n - 0.7);   // 自分のすぐ手前は字が大きくなりすぎるので描かない（当たれば下から燃え上がる）
  for (let s = 0.4; s <= end; s += 0.1) for (let j = 0; j < 2; j++) {
    const near = s / Math.max(1, n), lead = 1 - (head - s) / Math.max(1, n);   // near: 口から離れるほど 1、lead: 炎の先に近いほど 1
    const a = Math.max(0, 1 - fade * 1.4 - (1 - lead) * 0.35);
    if (a <= 0) continue;
    const i = Math.min(n - 1, Math.floor(s)), f = s - i;
    const seed = Math.sin(s * 91.7 + j * 17.3 + Math.floor(now / 60) * 13.1) * 43758.5, r = seed - Math.floor(seed);
    const seed2 = Math.sin(s * 53.1 + j * 29.9 + Math.floor(now / 60) * 7.7) * 43758.5, r2 = seed2 - Math.floor(seed2);
    const spread = 0.08 + 0.4 * near;   // 口から離れるほど広がる
    const y = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f + (r - 0.5) * spread;
    const x = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f + (r2 - 0.5) * spread;
    const p = project(x + 0.5, 0.5 + (r2 - r) * spread, y + 0.5); if (!p) continue;
    const size = Math.max(9, Math.min(30, p.unit * (0.09 + 0.08 * near)));
    fxctx.globalAlpha = a;
    fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
    fxctx.fillStyle = FLAME_COLS[Math.min(4, Math.floor(Math.abs(r - 0.5) * 4 + near * 2.2))];   // 芯は明るく、外と先は赤く
    fxctx.fillText('*#&%^~'[Math.floor(r2 * 6)], p.px, p.py);
  }
  fxctx.globalAlpha = 1;
}
// メデューサのにらみ: 頭の所に 2 つの目が光り、緑の視線の輪（o O 0）が広がりながらこちらへ押し寄せる
const GAZE_COLS = ['#eaffc8', '#b6f06a', '#6fcf4a', '#3c9a3a'];
function drawGaze(now) {
  const k = (now - fx.gaze.t0) / GAZE_MS;
  const p = project(fx.gaze.x + 0.5, 0.78, fx.gaze.y + 0.5);
  const Wc = fxcv.clientWidth || fxcv.width, Hc = fxcv.clientHeight || fxcv.height;
  const cx = p ? p.px : Wc / 2, cy = p ? p.py : Hc * 0.4;
  const eye = Math.max(10, Math.min(48, (p ? p.unit : 60) * 0.14)) * (1 + 0.6 * Math.sin(Math.min(1, k * 3) * Math.PI));
  fxctx.globalAlpha = Math.max(0, 1 - Math.max(0, k - 0.7) / 0.3);
  fxctx.font = `700 ${fpx(eye)}px "BIZ UDGothic", monospace`;
  fxctx.fillStyle = '#eaffc8';
  fxctx.fillText('*', cx - eye * 0.45, cy); fxctx.fillText('*', cx + eye * 0.45, cy);
  // 輪: 目から順に生まれ、広がって画面を覆いながら薄れる
  const size = Math.round(Math.min(Wc, Hc) * 0.045);
  fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
  for (let ring = 0; ring < 4; ring++) {
    const rk = k * 1.6 - ring * 0.18;
    if (rk <= 0 || rk >= 1) continue;
    const rad = rk * Math.hypot(Wc, Hc) * 0.7, n = Math.max(8, Math.round(rad * 2 * Math.PI / (size * 1.1)));
    fxctx.globalAlpha = (1 - rk) * 0.8;
    fxctx.fillStyle = GAZE_COLS[ring];
    for (let i = 0; i < n; i++) {
      const a = i / n * 2 * Math.PI + ring * 0.4;
      fxctx.fillText('oO0o'[(i + ring) % 4], cx + Math.cos(a) * rad, cy + Math.sin(a) * rad * 0.8);
    }
  }
  fxctx.globalAlpha = 1;
}
// 凍らされた: 画面のふちから霜の字（* + x # / \）が内へ伸び、青白く曇る。解けると割れて下へ落ちる
const FROST_CH = '*+x#/\\', SHARD_CH = '/\\.,';
function drawFrost(now) {
  const f = fx.frost, Wc = fxcv.clientWidth || fxcv.width, Hc = fxcv.clientHeight || fxcv.height;
  const grow = Math.min(1, (now - f.t0) / FROST_IN), th = f.thaw ? Math.min(1, Math.max(0, now - f.thaw) / THAW_MS) : 0;
  const size = Math.round(Math.min(Wc, Hc) * 0.05), cw = size * 0.62, cols = Math.ceil(Wc / cw), rows = Math.ceil(Hc / size);
  fxctx.globalAlpha = 0.16 * grow * (1 - th);
  fxctx.fillStyle = '#9fd4ff'; fxctx.fillRect(0, 0, Wc, Hc);   // 青白い曇り
  fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
  const reach = 0.24 * (1 - Math.pow(1 - grow, 3));   // ふちから内へ（画面の短い辺に対する割合）
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * cw + cw / 2, y = r * size + size / 2;
    const d = Math.min(x, Wc - x, y, Hc - y) / Math.min(Wc, Hc);   // ふちからの近さ
    const sd = Math.sin(c * 12.9898 + r * 78.233) * 43758.5, q = sd - Math.floor(sd);
    const lim = reach * (0.55 + 0.45 * q);
    if (d > lim) continue;
    const edge = 1 - d / Math.max(0.001, lim);   // ふちほど 1
    if (edge < 0.35 && q < 0.5) continue;   // 内側の先はまばらに
    let fy = y, fa = 0.15 + 0.6 * edge;
    if (th > 0) { fy += th * th * size * (2 + 4 * q); fa *= Math.max(0, 1 - th * 1.4); }   // 割れて少し落ち、すぐ消える
    fxctx.globalAlpha = fa;
    fxctx.fillStyle = edge > 0.6 ? '#f2fbff' : edge > 0.3 ? '#bfe6ff' : '#7fbfea';
    fxctx.fillText(th > 0 ? SHARD_CH[Math.floor(q * 4)] : FROST_CH[Math.floor(q * 6)], x + (th > 0 ? (q - 0.5) * th * size : 0), fy);
  }
  fxctx.globalAlpha = 1;
}
// 炎に包まれた: 画面の下から炎の字が燃え上がって消える
function drawBurn(now) {
  const k = (now - fx.burn.t0) / BURN_MS, Wc = fxcv.clientWidth || fxcv.width, Hc = fxcv.clientHeight || fxcv.height;
  const size = Math.round(Math.min(Wc, Hc) * 0.06), cw = size * 0.6;
  const rise = Math.sin(Math.min(1, k * 2.2) * Math.PI / 2) * (1 - Math.max(0, k - 0.55) / 0.45 * 0.6);
  fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
  for (let c = 0; c * cw < Wc + cw; c++) {
    const hgt = Hc * rise * (0.28 + 0.14 * Math.sin(c * 1.7 + now / 90) + 0.08 * Math.sin(c * 0.6 - now / 130));
    const rows = Math.ceil(hgt / size);
    for (let r = 0; r < rows; r++) {
      const up = r / Math.max(1, rows);   // 0 = 下の端
      const seed = Math.sin(c * 12.9 + r * 78.2 + Math.floor(now / 70)) * 43758.5, q = seed - Math.floor(seed);
      fxctx.globalAlpha = Math.max(0, (1 - up) * 0.85 * (1 - Math.max(0, k - 0.6) / 0.4));
      fxctx.fillStyle = FLAME_COLS[Math.min(4, Math.floor(up * 4 + q * 1.2))];
      fxctx.fillText(r === rows - 1 ? '^' : '*#&%^~'[Math.floor(q * 6)], c * cw + cw / 2, Hc - r * size - size / 2);
    }
  }
  fxctx.globalAlpha = 1;
}

function project(x, y, z) {
  _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  const dist = -_v.z;
  if (dist < 0.12) return null;
  _v.set(x, y, z).project(camera);
  const W2 = fxcv.width / Math.min(devicePixelRatio || 1, 2), H2 = fxcv.height / Math.min(devicePixelRatio || 1, 2);
  return { px: (_v.x + 1) / 2 * W2, py: (1 - _v.y) / 2 * H2, dist, unit: H2 / (2 * dist * Math.tan(camera.fov * Math.PI / 360)) };
}
// 敵の攻撃: 踏み込み（LUNGE_HIT で当たる）と、当たったときに画面に走る 3 本の爪あと（/ の字を斜めに並べる）
const LUNGE_MS = 380, LUNGE_HIT = 110, CLAW_MS = 360;
// 敵ごとの攻撃の仕方（当たったときに画面に出る跡）。E（浮遊する目）は見つめるだけで殴らない
const ATTACK_KIND = {
  G: 'claw', K: 'claw', J: 'claw', Y: 'claw', D: 'claw', T: 'claw',
  A: 'bite', B: 'bite', S: 'bite', R: 'bite', V: 'bite', X: 'bite', Z: 'bite', Q: 'bite',
  H: 'blunt', O: 'blunt', C: 'blunt', M: 'blunt',
  U: 'horn',
  I: 'touch', P: 'touch', W: 'touch', L: 'touch', N: 'touch', F: 'touch',
  E: 'none',
};
const TOUCH_COL = { I: '#9fd8ff', P: '#b0b8c8', W: '#8a6fb0', L: '#f0c652', N: '#f0a0c8', F: '#7fd17a' };   // 触れたものの色（冷気・霊気・金・魅了・つる）
function markCtx(size) {
  const dpr = Math.min(devicePixelRatio || 1, 2), W2 = fxcv.width / dpr, H2 = fxcv.height / dpr;
  fxctx.save(); fxctx.textAlign = 'center'; fxctx.textBaseline = 'middle';
  fxctx.font = `700 ${fpx(Math.round(Math.min(W2, H2) * size))}px "BIZ UDGothic", monospace`;
  return { W2, H2, u: Math.min(W2, H2) };
}
function markChar(ch, x, y, col, a = 1, rot = 0) {
  fxctx.globalAlpha = Math.max(0, Math.min(1, a));
  if (rot) { fxctx.save(); fxctx.translate(x, y); fxctx.rotate(rot); x = 0; y = 0; }
  fxctx.lineWidth = 6; fxctx.strokeStyle = '#000'; fxctx.strokeText(ch, x, y);
  fxctx.fillStyle = col; fxctx.fillText(ch, x, y);
  if (rot) fxctx.restore();
}
// 噛みつき: 上から V、下から ^ の牙の列が閉じる
function drawBite(c, ms) {
  const { W2, H2, u } = markCtx(0.13), close = Math.min(1, ms / 70), fade = ms < 140 ? 1 : 1 - (ms - 140) / (CLAW_MS - 140);
  const gap = (1 - close) * H2 * 0.32 + u * 0.06, cy = H2 * 0.47, n = 6;
  for (let i = 0; i < n; i++) {
    const q = i / (n - 1) - 0.5, x = W2 * 0.5 + q * u * 0.8, arc = q * q * u * 0.35;   // 顎の形に両端を上げ下げ
    const col = ms < 110 ? '#fff' : '#ff6a5c';
    markChar('V', x, cy - gap + arc, col, fade);
    markChar('^', x + u * 0.07, cy + gap - arc, col, fade);
  }
  fxctx.restore();
}
// 殴る: 真ん中で * がはじけ、8 方向へ衝撃の字が飛ぶ
function drawBlunt(c, ms) {
  const { W2, H2, u } = markCtx(0.11), k = Math.min(1, ms / CLAW_MS), fade = ms < 100 ? 1 : 1 - (ms - 100) / (CLAW_MS - 100);
  const cx = W2 * (0.45 + 0.1 * c.seed), cy = H2 * 0.47;
  fxctx.font = `700 ${fpx(Math.round(u * (0.22 + 0.25 * Math.min(1, ms / 60))))}px "BIZ UDGothic", monospace`;
  markChar('*', cx, cy, ms < 90 ? '#fff' : '#ffb054', fade);
  fxctx.font = `700 ${fpx(Math.round(u * 0.1))}px "BIZ UDGothic", monospace`;
  const RAY = ['-', '\\', '|', '/', '-', '\\', '|', '/'];
  for (let j = 0; j < 8; j++) {
    const a = j * Math.PI / 4 + c.seed * 0.4, r = u * (0.16 + 0.32 * Math.sqrt(k));
    for (let m = 0; m < 2; m++) markChar(RAY[j], cx + Math.cos(a) * (r + m * u * 0.07), cy + Math.sin(a) * (r + m * u * 0.07), m ? '#ff6a5c' : '#ffe08a', fade * (1 - m * 0.4));
  }
  fxctx.restore();
}
// 角で突く: 真ん中から、ひびが折れ曲がりながら放射状に走る
function drawHorn(c, ms) {
  const { W2, H2, u } = markCtx(0.09), reveal = Math.min(1, ms / 80), fade = ms < 150 ? 1 : 1 - (ms - 150) / (CLAW_MS - 150);
  const cx = W2 * 0.5, cy = H2 * 0.47;
  markChar('X', cx, cy, ms < 100 ? '#fff' : '#ff6a5c', fade);
  let r = c.seed * 1000;
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  for (let j = 0; j < 7; j++) {
    let a = j * Math.PI * 2 / 7 + rnd() * 0.5, x = cx, y = cy;
    const n = Math.ceil(6 * reveal);
    for (let i = 0; i < n; i++) {
      a += (rnd() - 0.5) * 0.9;   // 折れ曲がる
      x += Math.cos(a) * u * 0.07; y += Math.sin(a) * u * 0.07;
      const d = ((a % Math.PI) + Math.PI) % Math.PI, ch = d < Math.PI / 8 || d > Math.PI * 7 / 8 ? '-' : d < Math.PI * 3 / 8 ? '\\' : d < Math.PI * 5 / 8 ? '|' : '/';
      markChar(ch, x, y, i < 2 && ms < 100 ? '#fff' : '#ff6a5c', fade * (1 - i / 8));
    }
  }
  fxctx.restore();
}
// 触れる・つかむ: 画面のふちから、その敵の色の ~ がにじんで消える
function drawTouch(c, ms) {
  const { W2, H2, u } = markCtx(0.12), k = Math.min(1, ms / 120), fade = ms < 140 ? 1 : 1 - (ms - 140) / (CLAW_MS - 140);
  const col = TOUCH_COL[c.ch] || '#b0b8c8';
  let r = c.seed * 1000;
  const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < 70; i++) {
    const side = i % 4, t = rnd(), depth = rnd() * 0.32 * k;   // ふちからの深さ
    const x = side === 0 ? t * W2 : side === 1 ? W2 * (1 - depth) : side === 2 ? t * W2 : W2 * depth;
    const y = side === 0 ? H2 * depth : side === 1 ? t * H2 : side === 2 ? H2 * (1 - depth) : t * H2;
    markChar('~', x + Math.sin(ms / 40 + i) * u * 0.015, y, col, fade * (0.7 + 0.3 * rnd()));
  }
  fxctx.restore();
}
function drawClaw(c, now) {
  const ms = now - c.t0; if (ms < 0) return;
  if (c.kind === 'bite') return drawBite(c, ms);
  if (c.kind === 'blunt') return drawBlunt(c, ms);
  if (c.kind === 'horn') return drawHorn(c, ms);
  if (c.kind === 'touch') return drawTouch(c, ms);
  const dpr = Math.min(devicePixelRatio || 1, 2), W2 = fxcv.width / dpr, H2 = fxcv.height / dpr;
  const size = Math.round(Math.min(W2, H2) * 0.12), reveal = Math.min(1, ms / 70), fade = ms < 140 ? 1 : 1 - (ms - 140) / (CLAW_MS - 140);
  const cx = W2 * (0.45 + 0.1 * c.seed), cy = H2 * 0.45, len = Math.min(W2, H2) * 0.5, a = -Math.PI / 3 + (c.seed - 0.5) * 0.4;
  fxctx.save(); fxctx.textAlign = 'center'; fxctx.textBaseline = 'middle';
  fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
  for (let j = -1; j <= 1; j++) {
    const ox = Math.cos(a + Math.PI / 2) * j * size * 1.1, oy = Math.sin(a + Math.PI / 2) * j * size * 1.1;
    const n = Math.round(len / (size * 0.4)), shown = Math.ceil(n * reveal);
    for (let i = 0; i < shown; i++) {
      const q = i / (n - 1) - 0.5, taper = 1 - Math.abs(q) * 1.2;   // 両端は細く薄く
      const x = cx + ox + Math.cos(a) * q * len, y = cy + oy + Math.sin(a) * q * len;
      fxctx.globalAlpha = fade * Math.max(0.2, taper);
      fxctx.lineWidth = 6; fxctx.strokeStyle = '#000'; fxctx.strokeText('/', x, y);
      fxctx.fillStyle = taper > 0.6 && ms < 120 ? '#fff' : '#ff6a5c'; fxctx.fillText('/', x, y);
    }
  }
  fxctx.restore();
}

// 投げる・射る（手元の動き）。fired: 弓で矢を射る（引いて放し、弦が震える）。それ以外は手に持った物を振りかぶって投げる
const TOSS_MS = 640, TOSS_REL = 230, TOSS_REL_BOW = 280;   // TOSS_REL: 構えてから手を離すまで（game.py の effect_wait と同じ値）
const TOSS_ART = { 3: '----->', 4: '=+===>', 6: '=->', 7: '*', 8: '=------------<>', 0: '==-----(@)', 1: '==+========>', 5: '===+=============>', 2: '==-)' };
const TOSS_FLY = { 3: '-', 6: '-', 4: ')', 8: '|' };   // 飛んでいる間の字（ほかは物の字のまま）
function drawToss(now) {
  const t = fx.toss, ms = now - t.t0, k = ms / TOSS_MS;
  if (k < 0 || k > 1) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), W2 = fxcv.width / dpr, H2 = fxcv.height / dpr;
  const size = Math.round(Math.min(W2, H2) * 0.11), rel = t.fired ? TOSS_REL_BOW : TOSS_REL;
  const fade = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
  fxctx.save();
  fxctx.textAlign = 'center'; fxctx.textBaseline = 'middle';
  const put = (ch, x, y, col, sz = size, a = 0) => {
    fxctx.setTransform(dpr, 0, 0, dpr, 0, 0); fxctx.translate(x, y); fxctx.rotate(a);
    fxctx.font = `700 ${fpx(sz)}px "BIZ UDGothic", monospace`;
    fxctx.lineWidth = 4; fxctx.strokeStyle = '#000'; fxctx.strokeText(ch, 0, 0);
    fxctx.fillStyle = col; fxctx.fillText(ch, 0, 0);
  };
  fxctx.globalAlpha = fade;
  if (t.fired) {
    // 弓: 右下に縦に構える。弦を引き（矢が手前へ下がる）、放すと矢は消え、弦が震えて戻る
    const bx = W2 * 0.74, by = H2 * 0.66, bh = H2 * 0.42;
    const pull = ms < rel ? (ms / rel) ** 0.7 : 0;
    const vib = ms < rel ? 0 : Math.sin((ms - rel) / 14) * Math.exp(-(ms - rel) / 90);
    const nx = bx + size * (0.4 + 1.1 * pull + 0.35 * vib), ny = by + size * 0.5 * pull;
    const n = 9;
    for (let i = 0; i <= n; i++) {   // 弓の背: ( の字を弧に並べる
      const q = i / n - 0.5, x = bx - Math.cos(q * Math.PI) * size * 0.9, y = by + q * bh;
      put(i === 0 || i === n ? '.' : '(', x, y, '#9a7a58', size * 0.8);
    }
    for (const [tx, ty] of [[bx, by - bh / 2], [bx, by + bh / 2]]) {   // 弦: 弓の両端から引き手まで点で
      for (let i = 1; i < 6; i++) { const q = i / 6; put('.', tx + (nx - tx) * q, ty + (ny - ty) * q, '#bbb', size * 0.6); }
    }
    if (ms < rel) {   // つがえた矢: 引き手から画面の真ん中へ向ける
      const a = Math.atan2(H2 * 0.45 - ny, W2 * 0.5 - nx);
      fxctx.setTransform(dpr, 0, 0, dpr, 0, 0); fxctx.translate(nx, ny); fxctx.rotate(a);
      fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
      const art = '>>----->';
      for (let i = 0; i < art.length; i++) { fxctx.lineWidth = 4; fxctx.strokeStyle = '#000'; fxctx.strokeText(art[i], i * size * 0.5, 0); fxctx.fillStyle = i < 2 ? '#c8ccd1' : '#d6dbe0'; fxctx.fillText(art[i], i * size * 0.5, 0); }
    }
  } else if (ms < rel) {
    // 投げる: 右下へ振りかぶってから、真ん中へ向けて小さくなりながら放つ
    const back = Math.min(1, ms / (rel * 0.35)), fwd = Math.max(0, (ms - rel * 0.35) / (rel * 0.65));
    const x = W2 * (0.84 + 0.06 * back - 0.34 * fwd * fwd), y = H2 * (0.92 + 0.06 * back - 0.45 * fwd * fwd);
    const art = TOSS_ART[t.w] || t.ch, sz = size * (1.6 - 0.8 * fwd);
    const a = t.w === 7 ? ms / 30 : art.length > 2 ? Math.atan2(H2 * 0.45 - y, W2 * 0.5 - x) - (1 - fwd) * 0.6 : 0;
    if (art.length > 2) {
      fxctx.setTransform(dpr, 0, 0, dpr, 0, 0); fxctx.translate(x, y); fxctx.rotate(a);
      fxctx.font = `700 ${fpx(sz)}px "BIZ UDGothic", monospace`;
      for (let i = 0; i < art.length; i++) { const cx = (i - art.length + 1) * sz * 0.5; fxctx.lineWidth = 4; fxctx.strokeStyle = '#000'; fxctx.strokeText(art[i], cx, 0); fxctx.fillStyle = i < 2 ? '#9a7a58' : '#d6dbe0'; fxctx.fillText(art[i], cx, 0); }
    } else put(art, x, y, t.w === 7 ? '#d6dbe0' : '#e8d8b0', sz * 1.3, a);
  }
  fxctx.restore();
}

// 振りの角度（画面の右下の手元から見た向き。-90° が真上、180° が真左）。構え直し→速く振り下ろす→当たれば少し止まる・外れれば振り抜く
function swingAngle(sw, k) {
  const A0 = -70, A1 = -78, HIT = -128, END = sw.hit ? -150 : -185;
  const kh = SWING_HIT / SWING_MS;
  if (k < 0.12) return A0 + (A1 - A0) * (k / 0.12);                   // 少し振りかぶる
  if (k < kh) { const q = (k - 0.12) / (kh - 0.12); return A1 + (HIT - A1) * q * q; }   // 加速して振り下ろす
  if (sw.hit && k < kh + 0.18) return HIT - 4 * (k - kh) / 0.18;      // 当たり: 手応えで止まる
  const k2 = sw.hit ? kh + 0.18 : kh, q = Math.min(1, (k - k2) / (1 - k2));
  return HIT - 4 * (sw.hit ? 1 : 0) + (END - HIT) * (1 - (1 - q) * (1 - q));   // 振り抜く（だんだん遅く）
}
function drawSwing(now) {
  const sw = fx.swing, k = (now - sw.t0) / SWING_MS;
  if (k < 0 || k > 1) return;
  const dpr = Math.min(devicePixelRatio || 1, 2), W2 = fxcv.width / dpr, H2 = fxcv.height / dpr;
  const art = SWING_ART[sw.w], size = Math.round(Math.min(W2, H2) * 0.11 * (sw.w === 2 ? 1.5 : 1));
  const fade = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
  fxctx.save();
  fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
  fxctx.textAlign = 'center'; fxctx.textBaseline = 'middle';
  const px = W2 * 0.9, py = H2 * 1.04, step = size * 0.5;   // 字を詰めて、刃が一続きに見えるように
  if (sw.w === -1) {   // 素手: 右下から敵へ突き出して戻す
    const kh = SWING_HIT / SWING_MS, q = k < kh ? (k / kh) ** 2 : sw.hit && k < kh + 0.15 ? 1 : Math.max(0, 1 - (k - kh - (sw.hit ? 0.15 : 0)) / 0.45);
    const x = W2 * (0.82 - 0.3 * q), y = H2 * (1.0 - 0.45 * q), sz = size * (1.6 - 0.5 * q);
    fxctx.font = `700 ${fpx(sz)}px "BIZ UDGothic", monospace`; fxctx.globalAlpha = fade;
    fxctx.lineWidth = 5; fxctx.strokeStyle = '#000'; fxctx.strokeText(art, x, y);
    fxctx.fillStyle = '#d8b48a'; fxctx.fillText(art, x, y);
    fxctx.restore(); return;
  }
  if (sw.w === 3 || sw.w === 6 || sw.w === 7 || sw.w === 8) {   // 槍は突く。矢・ダーツ・手裏剣は短いので振らずに、大きく持って突き刺す（手裏剣は回しながら）
    const kh = SWING_HIT / SWING_MS, q = k < kh ? (k / kh) ** 2 : sw.hit && k < kh + 0.15 ? 1 : Math.max(0, 1 - (k - kh - (sw.hit ? 0.15 : 0)) / 0.45);
    const x = W2 * (0.86 - 0.32 * q), y = H2 * (1.02 - 0.47 * q), sz = size * (sw.w === 8 ? 1.15 - 0.2 * q : 1.8 - 0.5 * q);   // 槍は長いので字は大きくしない
    const a = sw.w === 7 ? k * 14 : Math.atan2(-0.57 * H2, -0.36 * W2), txt = sw.w === 7 ? '*' : art;
    fxctx.globalAlpha = fade;
    fxctx.setTransform(dpr, 0, 0, dpr, 0, 0); fxctx.translate(x, y); fxctx.rotate(a);
    fxctx.font = `700 ${fpx(sz * (sw.w === 7 ? 1.6 : 1))}px "BIZ UDGothic", monospace`;
    for (let i = 0; i < txt.length; i++) {   // 刃先を手前の点に、握りを後ろへ
      const cx = (i - txt.length + 1) * sz * 0.5;
      fxctx.lineWidth = 5; fxctx.strokeStyle = '#000'; fxctx.strokeText(txt[i], cx, 0);
      fxctx.fillStyle = i === 0 && txt.length > 2 ? '#9a7a58' : '#d6dbe0'; fxctx.fillText(txt[i], cx, 0);
    }
    fxctx.restore(); return;
  }
  const ghosts = sw.hit && k > SWING_HIT / SWING_MS && k < SWING_HIT / SWING_MS + 0.18 ? [0] : [0, 0.025, 0.05];   // 速いときは残像
  for (let gi = ghosts.length - 1; gi >= 0; gi--) {
    const a = swingAngle(sw, Math.max(0, k - ghosts[gi])) * Math.PI / 180;
    fxctx.globalAlpha = fade * (gi ? 0.25 / gi : 1);
    fxctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fxctx.translate(px, py); fxctx.rotate(a);
    for (let i = 0; i < art.length; i++) {
      const ch = art[i], grip = i < 2 && sw.w !== -1;
      fxctx.lineWidth = 4; fxctx.strokeStyle = '#000'; fxctx.strokeText(ch, size * 0.9 + i * step, 0);
      fxctx.fillStyle = sw.w === -1 ? '#d8b48a' : grip ? '#9a7a58' : '#d6dbe0';
      fxctx.fillText(ch, size * 0.9 + i * step, 0);
    }
  }
  fxctx.restore();
}
function drawFx(now) {
  if (!fxctx) return;
  fxctx.clearRect(0, 0, fxcv.width, fxcv.height);
  fxctx.textAlign = 'center'; fxctx.textBaseline = 'middle';
  for (const n of fx.nums) {
    if (now < n.t0) continue;
    const k = (now - n.t0) / NUM_MS;
    const p = project(n.x + 0.5, 0.95 + k * 0.45, n.y + 0.5); if (!p) continue;
    const size = Math.max(14, Math.min(48, p.unit * 0.3));
    fxctx.globalAlpha = 1 - Math.max(0, (k - 0.5) * 2);
    fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
    fxctx.lineWidth = 4; fxctx.strokeStyle = '#000'; fxctx.strokeText(n.text, p.px, p.py);
    fxctx.fillStyle = '#ffe08a'; fxctx.fillText(n.text, p.px, p.py);
  }
  for (const d of fx.debris) {
    if (now < d.t0) continue;
    const t = (now - d.t0) / 1000, k = (now - d.t0) / DEBRIS_MS;
    const y = Math.max(0.02, d.h + d.vy * t - 4.5 * t * t);
    const p = project(d.x + 0.5 + d.vx * t, y, d.y + 0.5 + d.vz * t); if (!p) continue;
    const size = Math.max(8, Math.min(40, p.unit * 0.16));
    fxctx.globalAlpha = 1 - k;
    fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
    fxctx.fillStyle = d.col; fxctx.fillText(d.ch, p.px, p.py);
  }
  // 光線の通り道: 光る * が残って消えていく
  for (const o of fx.trail) {
    const k = (now - o.t0) / (o.ms || TRAIL_MS);
    const p = project(o.x + 0.5, 0.42, o.y + 0.5); if (!p) continue;
    const size = Math.max(10, Math.min(o.ch ? 30 : 120, p.unit * (o.ch ? 0.22 : 0.35)));
    fxctx.globalAlpha = (1 - k) * (o.ch ? 0.7 : 1);
    fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
    fxctx.shadowColor = o.col; fxctx.shadowBlur = o.ch ? 0 : 18;
    fxctx.fillStyle = o.col; fxctx.fillText(o.ch || '*', p.px, p.py);
    fxctx.shadowBlur = 0;
  }
  // 見つけた扉: + が光りながら大きくなって消える
  for (const o of fx.pops) {
    const k = (now - o.t0) / POP_MS;
    const p = project(o.x + 0.5, 0.5, o.y + 0.5); if (!p) continue;
    const size = Math.max(16, Math.min(160, p.unit * (0.5 + k * 0.6)));
    fxctx.globalAlpha = 1 - k;
    fxctx.font = `700 ${fpx(size)}px "BIZ UDGothic", monospace`;
    fxctx.shadowColor = '#f0c652'; fxctx.shadowBlur = 24;
    fxctx.fillStyle = '#ffe08a'; fxctx.fillText(o.ch, p.px, p.py);
    fxctx.shadowBlur = 0;
  }
  drawDoorGlow(now);
  for (const b of fx.breaths) drawBreath(b, now);
  if (fx.burn && now >= fx.burn.t0) drawBurn(now);
  if (fx.gaze && now >= fx.gaze.t0) drawGaze(now);
  if (fx.frost && now >= fx.frost.t0) drawFrost(now);
  if (fx.swing) drawSwing(now);
  if (fx.toss) drawToss(now);
  for (const c of fx.claws) drawClaw(c, now);
  const dark = transDark(now);   // 階段・落とし穴の暗転
  if (dark > 0) { fxctx.globalAlpha = dark; fxctx.fillStyle = trans.col; fxctx.fillRect(0, 0, fxcv.width, fxcv.height); }
  fxctx.globalAlpha = 1;
}

let flickTimer = 0;
function draw() {
  if (!renderer || !cam) return;
  const now = performance.now();
  TIME_U.value = now / 1000;
  // 炎の揺らぎ: 止まっていても少しずつ描き直す
  if (tune.flicker && !flickTimer && !document.hidden) {
    flickTimer = setTimeout(() => { flickTimer = 0; draw(); }, 110);   // 手元の明かりはいつも揺れる
  }
  // 自分のマスの少し後ろから見る（真ん中からだと両脇の壁しか見えず窮屈）
  const back = 0.32;
  eye += ((mood.lev ? EYE + 0.3 : EYE) - eye) * 0.15;   // 浮遊中は視点を高く（ゆっくり上がり下がりする）
  camera.position.set(cam.x + Math.sin(cam.yaw) * back, eye - (cam.bob || 0), cam.z + Math.cos(cam.yaw) * back);
  camera.rotation.set(0, cam.yaw, 0, 'YXZ');
  const tc = transCamera(now);
  if (tc) { camera.position.set(tc.x, tc.y, tc.z); camera.rotation.set(tc.pitch, tc.yaw, 0, 'YXZ'); }
  if (mood.conf) {   // 混乱: 視界がふらふら傾いて揺れる
    camera.rotation.z = Math.sin(now / 520) * 0.09;
    camera.rotation.y += Math.sin(now / 830) * 0.05;
    camera.rotation.x = Math.sin(now / 670) * 0.04;
  }
  const sk = 1 - (now - fx.shakeT0) / SHAKE_MS;   // くらったときの揺れ
  if (sk > 0) {
    camera.position.x += (Math.random() - 0.5) * 0.14 * sk; camera.position.y += (Math.random() - 0.5) * 0.08 * sk;
    camera.rotation.z = (Math.random() - 0.5) * 0.06 * sk;
  }
  camera.updateMatrixWorld();
  jitterSprites(now, true);
  drawTerm();
  jitterSprites(now, false);
  drawFx(now);
  drawCompass();
}

// 方位計の帯: 画面の下に、向いている方角を中心に N・E・S・W と目盛りが流れる（地図の上が北）
let compass, cctx;
function drawCompass() {
  if (!compass) {
    compass = document.createElement('canvas'); compass.id = 'v3compass'; compass.setAttribute('aria-hidden', 'true');
    cv.parentElement.append(compass); cctx = compass.getContext('2d');
  }
  const dpr = Math.min(devicePixelRatio || 1, 2), w = compass.clientWidth, h = compass.clientHeight;
  if (!w) return;
  if (compass.width !== Math.round(w * dpr)) { compass.width = Math.round(w * dpr); compass.height = Math.round(h * dpr); }
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.clearRect(0, 0, w, h);
  const head = -cam.yaw;   // 北から右回りの角度
  cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
  for (let a = 0; a < 360; a += 15) {
    let d = a * Math.PI / 180 - head;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > Math.PI / 2) continue;
    const x = w / 2 + d / (Math.PI / 2) * w / 2, fade = 1 - Math.abs(d) / (Math.PI / 2);
    const main = a % 90 === 0;
    cctx.globalAlpha = 0.25 + 0.75 * fade;
    cctx.font = `${main ? 700 : 400} ${main ? h * 0.7 : h * 0.5}px "BIZ UDGothic", monospace`;
    cctx.fillStyle = main ? '#f0c652' : '#8d939a';
    cctx.fillText(main ? 'NESW'[a / 90] : a % 45 === 0 ? '+' : '.', x, h / 2);
  }
  cctx.globalAlpha = 1;
  cctx.fillStyle = '#f0c652'; cctx.fillRect(w / 2 - 0.5, 0, 1, 3);   // 真ん中の印
}

