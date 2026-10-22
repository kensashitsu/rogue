// 3D 表示（試作）: ゲームが送ってくる 80×24 の画面から、プレイヤーが知っている地図を立体にして一人称で描く。
// ゲームの中身には手を入れない。見えているもの・覚えているものは 2D 版の画面と同じ
//   - 壁（- |）は石の壁、通路（#）は岩に囲まれた細い道、扉（+）は壁の切れ目
//   - モンスターは文字のまま立たせ、アイテム・階段・罠も文字を床に浮かべる
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
// 手書きの質感（石壁・床）
// ---------------------------------------------------------------------------
function texture(draw, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; t.anisotropy = 4;
  return t;
}
function noise(g, s, n, a) {
  for (let i = 0; i < n; i++) {
    const v = Math.random() * 255 | 0;
    g.fillStyle = `rgba(${v},${v},${v},${a})`;
    g.fillRect(Math.random() * s | 0, Math.random() * s | 0, 2, 2);
  }
}
const stoneTex = texture((g, s) => {   // 石積み
  g.fillStyle = '#6b6258'; g.fillRect(0, 0, s, s);
  const rows = 4, h = s / rows;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? s / 4 : 0;
    for (let x = -s / 2; x < s; x += s / 2) {
      const l = 88 + Math.random() * 30 | 0;
      g.fillStyle = `rgb(${l + 8},${l},${l - 10})`;
      g.fillRect(x + off + 2, r * h + 2, s / 2 - 4, h - 4);
    }
  }
  noise(g, s, 900, 0.12);
});
const rockTex = texture((g, s) => {    // 通路の岩肌
  g.fillStyle = '#3e3832'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 40; i++) {
    const l = 50 + Math.random() * 30 | 0;
    g.fillStyle = `rgb(${l + 6},${l},${l - 6})`;
    g.beginPath(); g.arc(Math.random() * s, Math.random() * s, 6 + Math.random() * 14, 0, 7); g.fill();
  }
  noise(g, s, 900, 0.15);
});
const floorTex = texture((g, s) => {   // 部屋の床（敷石）
  g.fillStyle = '#2a2622'; g.fillRect(0, 0, s, s);
  const n = 2, q = s / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const l = 66 + Math.random() * 18 | 0;
    g.fillStyle = `rgb(${l},${l - 4},${l - 10})`; g.fillRect(x * q + 2, y * q + 2, q - 4, q - 4);
  }
  noise(g, s, 700, 0.1);
});
const dirtTex = texture((g, s) => {    // 通路の土
  g.fillStyle = '#3a3128'; g.fillRect(0, 0, s, s);
  noise(g, s, 1600, 0.18);
});

// 文字の見た目: 黒地に記号を並べた質感（壁は - と |、床は .、通路は #、扉は +）
function glyphTile(ch, cols, rows, col, size) {
  const t = texture((g, s) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, s, s);
    g.font = `700 ${size}px "BIZ UDGothic", monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = col;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * s / cols, y = (r + 0.5) * s / rows;
      if (ch === '.') { g.beginPath(); g.arc(x, y, size, 0, 7); g.fill(); }   // 床の点は字だと小さすぎるので丸で
      else g.fillText(ch, x, y + size * 0.04);
    }
  }, 128);
  t.magFilter = THREE.LinearFilter; t.anisotropy = 8;
  return t;
}
const asciiTex = {
  hwall: glyphTile('-', 3, 4, '#c8ccd1', 46),
  vwall: glyphTile('|', 4, 2, '#c8ccd1', 50),
  floor: glyphTile('.', 1, 1, '#b4bac0', 7),
  passage: glyphTile('#', 1, 1, '#a0a6ad', 96),
  door: glyphTile('+', 1, 1, '#e0c080', 96),
  rock: glyphTile('.', 4, 4, '#3a3f46', 3),
  step: glyphTile('=', 2, 2, '#9fd8e0', 44),   // 下り階段の段      // 通路の両脇: ごく薄い点の面（原作の地図では空白の所なので目立たせない）
  ceil: glyphTile('.', 1, 1, '#6a7078', 6),      // 天井: 床の点を薄くしたもの
};

// ---------------------------------------------------------------------------
// 場面
// ---------------------------------------------------------------------------
let renderer, scene, camera, torch, ambient, cv;
const MAX = W * (MAP_BOT - MAP_TOP + 1);
let hwalls, vwalls, rocks, floors, dirts, doors, ceils, lintels;
let meshes = {}, themes = {}, edges, tcv, tctx, stepsMat;
// 床に描く字: 階段（%）と罠（^）。立てた札ではなく床の模様にする。色は 2D の画面の色に合わせて材質の色で付ける
const DECALS = { '^': { mesh: 'traps', kind: 9, color: '#d58cf0' } };
let stairsColor = '#6cc6d6';   // 階段の色（2D の画面の % の色に合わせる）
const STEPS = 4, STEP_DROP = 0.22;
const DIM_AHEAD = 0.16;   // まだ分からない 1 マス先を描く暗さ（覚えている所は 0.38、見えている所は 1）   // 下り階段の段の数と、1 段で下がる高さ
function decalTex(ch) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = '700 108px "BIZ UDGothic", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#fff'; g.fillText(ch, 64, ch === '^' ? 82 : 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const flying = new Set();   // 飛んでいる最中の物（投げた物）
let edgeSegs = [], edgeBright = [];          // 壁の輪郭の線分（x, y, z の組を 2 つずつ）
let theme = 'term';
try { theme = localStorage.getItem('rogue3d-theme') || theme; } catch {}
export const getTheme = () => theme;
const glyphGroup = new THREE.Group();
const dummy = new THREE.Object3D();
const color = new THREE.Color();

function instanced(geo) {
  const m = new THREE.InstancedMesh(geo, undefined, MAX);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.count = 0; m.frustumCulled = false;   // 置く場所を毎回変えるので、まとめての見切り判定はしない
  scene.add(m); return m;
}

export function init(canvas) {
  cv = canvas;
  // ASCII の見た目を描く 2D の画面（3D の画面に重ねる）
  tcv = document.createElement('canvas');
  tcv.id = 'v3t'; tcv.setAttribute('aria-hidden', 'true');
  canvas.after(tcv);
  tctx = tcv.getContext('2d');
  initFx(canvas);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#050607');
  scene.fog = new THREE.Fog('#050607', 1.5, 11);
  camera = new THREE.PerspectiveCamera(72, 1, 0.05, 40);
  ambient = new THREE.AmbientLight('#ffffff', 1.25);
  scene.add(ambient);
  torch = new THREE.PointLight('#ffcf8a', 1.6, 6, 1.6);   // 手元の明かり
  scene.add(torch);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const ceil = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
  meshes = {
    hwalls: instanced(box), vwalls: instanced(box), rocks: instanced(box),
    floors: instanced(plane), dirts: instanced(plane), doors: instanced(plane),
    ceils: instanced(ceil), lintels: instanced(new THREE.BoxGeometry(1, 0.22, 1)),
    traps: instanced(plane),   // 床に描く字（床から少し浮かせて重ねる）
    steps: instanced(box), pits: instanced(box),   // 下り階段の段と、穴の内側の壁
  };
  ({ hwalls, vwalls, rocks, floors, dirts, doors, ceils, lintels } = meshes);
  // 見た目ごとの材質（null は描かない）
  const lam = o => new THREE.MeshLambertMaterial(o), basic = map => new THREE.MeshBasicMaterial({ map });
  const stone = lam({ map: stoneTex }), stoneFloor = lam({ map: floorTex });
  for (const [ch, d] of Object.entries(DECALS))
    d.mat = new THREE.MeshBasicMaterial({ map: decalTex(ch), transparent: true, depthWrite: false, color: d.color });
  const decals = { traps: DECALS['^'].mat };
  stepsMat = new THREE.MeshLambertMaterial({ map: stoneTex, color: '#9fd8e0' });
  themes = {
    stone: {
      bg: '#050607', fog: [1.5, 11], light: true,
      mat: { hwalls: stone, vwalls: stone, rocks: lam({ map: rockTex }), floors: stoneFloor, dirts: lam({ map: dirtTex }),
        doors: stoneFloor, ceils: lam({ color: '#1c1916' }), lintels: lam({ color: '#5a3d22' }), ...decals,
        steps: stepsMat, pits: stone },
    },
    // 文字: 天井も岩もない真っ暗な中に、地図の記号だけが並ぶ
    ascii: {
      bg: '#000000', fog: [2, 13], light: false,
      mat: { hwalls: basic(asciiTex.hwall), vwalls: basic(asciiTex.vwall), rocks: basic(asciiTex.rock), floors: basic(asciiTex.floor),
        dirts: basic(asciiTex.passage), doors: basic(asciiTex.door), ceils: basic(asciiTex.ceil), lintels: null, ...decals,
        steps: basic(asciiTex.step), pits: basic(asciiTex.rock) },
      edges: true,
    },
    // ASCII: 場面を升目の粗さで描いて、升目ごとに文字へ置き換える（drawTerm）。ここでの材質は「何の面か」を書き出すだけ
    term: {
      bg: '#000000', fog: [2, 13], light: false, term: true,
      mat: { hwalls: kindMat(1), vwalls: kindMat(1), rocks: kindMat(3), floors: kindMat(4), dirts: kindMat(5),
        doors: kindMat(6), ceils: kindMat(7), lintels: null, traps: kindMat(9), steps: kindMat(8), pits: kindMat(1) },
    },
  };
  // 壁の輪郭線（床・天井との境目と角）。形が分かるように、文字の見た目のときだけ引く
  edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
  edges.frustumCulled = false;
  scene.add(edges);
  scene.add(glyphGroup);
  applyTheme();
  resize();
}

function applyTheme() {
  if (!themes[theme]) theme = 'term';
  const th = themes[theme];
  for (const [name, mesh] of Object.entries(meshes)) {
    const m = th.mat[name];
    mesh.visible = !!m;
    if (m) mesh.material = m;
  }
  scene.background.set(th.bg);
  scene.fog.color.set(th.bg); [scene.fog.near, scene.fog.far] = th.fog;
  ambient.visible = torch.visible = th.light;
  edges.visible = !!th.edges;
  cv.style.visibility = th.term ? 'hidden' : '';
  tcv.style.display = th.term ? '' : 'none';
  const seg = document.getElementById('cellSeg');
  if (seg) seg.hidden = !th.term;   // 升目の大きさは ASCII のときだけ
}

export function setTheme(name) {
  theme = name;
  try { localStorage.setItem('rogue3d-theme', theme); } catch {}
  if (renderer) { applyTheme(); draw(); }
}

export function resize() {
  if (!renderer) return;
  const w = cv.parentElement.clientWidth, h = cv.parentElement.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, true);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  sizeTerm(w, h);
  sizeFx(w, h);
  draw();
}

// 文字の札（同じ字・色は使い回す）
const glyphMats = new Map();
function glyphMat(ch, col) {
  const key = ch + col;
  if (glyphMats.has(key)) return glyphMats.get(key);
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.font = '700 112px "BIZ UDGothic", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = col; g.shadowBlur = 18;
  g.fillStyle = col; g.fillText(ch, 64, 70);
  g.shadowBlur = 0; g.fillText(ch, 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, fog: true });
  glyphMats.set(key, m); return m;
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
export function forgetRock() {   // 新しく始めるとき（前の冒険の同じ階の岩を引き継がない）
  rock.clear(); rockLevel = '';
  try { localStorage.removeItem('rogue3d-rock'); } catch {}
}
function learnRock(grid, pos) {
  const status = (grid[23] || []).filter(Boolean).map(c => c[0]).join('');
  const lv = (status.match(/(?:階|Level):\s*(\d+)/) || [])[1];
  if (!lv || !pos) return false;
  let changed = false;
  if (lv !== rockLevel) { rockLevel = lv; rock.clear(); changed = true; }
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
  if (pos) player = pos;
  const lvBefore = rockLevel;
  const learned = learnRock(grid, pos);
  findReveals(grid, lvBefore === rockLevel);
  lastGrid = grid;
  watchHp(grid);
  if (sig !== lastSig || learned) { lastSig = sig; build(grid); }
  // 始めたときや、階段・テレポートで遠くへ移ったときは、いちばん先まで歩ける方向を向く
  const jumped = pos && (!cam || Math.hypot(pos[1] + 0.5 - cam.x, pos[0] + 0.5 - cam.z) > 1.6);
  if (jumped) faceOpen(grid);
  if (moved) startMove();
  draw();
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
    mesh.setColorAt(i, color.setScalar(bright));
  };
  glyphGroup.clear();
  const solid = new Float32Array(W * 24);   // 壁・岩のマス（値は明るさ）。輪郭線を引くのに使う
  const stairCells = [];
  const aheadRocks = new Set();   // 1 マス先へ延ばした通路の脇の岩
  for (let y = MAP_TOP; y <= MAP_BOT; y++) {
    for (let x = 0; x < W; x++) {
      const [c, s] = cellAt(grid, y, x);
      const bright = s & 512 ? 0.38 : 1;   // 覚えているだけの所は暗く
      if (c === '-') { put(hwalls, 'hwalls', x, 0.5, y, bright); solid[y * W + x] = bright; continue; }
      if (c === '|') { put(vwalls, 'vwalls', x, 0.5, y, bright); solid[y * W + x] = bright; continue; }
      if (c === ' ') {
        // 何もない所: 隣に立って確かめた岩だけを岩にする（通路の壁）。まだ分からない所や、暗い部屋のまだ見ていない床は闇のまま
        if (!rock.has(y * W + x)) {
          // まだ分からない 1 マス先: 隣の歩いた床と同じ床・天井を暗く描き、通路なら両脇の岩も暗く延ばす。
          // 闇へうっすら続いて見せるだけで、本当の地形は使わない（行き止まりでも同じに見える）
          for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const n = ch(y - dy, x - dx);   // 来た側の隣
            if (!(walk(n) || n === '@')) continue;
            if (n === '#') put(dirts, 'dirts', x, 0, y, DIM_AHEAD); else put(floors, 'floors', x, 0, y, DIM_AHEAD);
            put(ceils, 'ceils', x, 1, y, DIM_AHEAD);
            for (const [py, px] of [[dx, dy], [-dx, -dy]]) {   // 進む向きの左右
              if (rock.has((y - dy + py) * W + (x - dx + px)) && ch(y + py, x + px) === ' ' && !rock.has((y + py) * W + (x + px)))
                aheadRocks.add((y + py) * W + (x + px));
            }
            break;
          }
          continue;
        }
        let byRoom = false;
        for (const [dy, dx] of DIRS) if (ch(y + dy, x + dx) === '.' && (dy === 0 || dx === 0)) byRoom = true;
        if (!byRoom) { put(rocks, 'rocks', x, 0.5, y, 0.8); solid[y * W + x] = 0.5; }
        continue;
      }
      if (!walk(c) && c !== '@') continue;
      // 床: 通路か部屋か。文字の下は周りから決める
      let corr = c === '#';
      if (c !== '#' && c !== '.' && c !== '+') {
        const ns = [ch(y - 1, x), ch(y + 1, x), ch(y, x - 1), ch(y, x + 1)];
        corr = ns.includes('#') && !ns.includes('.');
      }
      if (c === '%') {
        // 下り階段: 床の代わりに穴。北（奥）へ向かって段が下りていく
        const st = (s & 15) ? PALETTE[(s & 15) - 1] : stairsColor;
        if (st !== stairsColor) { stairsColor = st; stepsMat.color.set(st); }
        for (let i = 0; i < STEPS; i++) {
          const top = -STEP_DROP * (i + 1), z1 = y + 1 - (i + 1) / STEPS;
          put(meshes.steps, 'steps', x + 0.5, (top - 1.2) / 2, z1 + 0.5 / STEPS, bright, 0, 1, top + 1.2, 1 / STEPS, true);
        }
        for (const [px, pz, sx, sz] of [[x + 0.5, y + 0.02, 1, 0.04], [x + 0.5, y + 0.98, 1, 0.04], [x + 0.02, y + 0.5, 0.04, 1], [x + 0.98, y + 0.5, 0.04, 1]])
          put(meshes.pits, 'pits', px, -0.6, pz, bright * 0.8, 0, sx, 1.2, sz, true);
        stairCells.push([y, x, bright]);
      } else if (c === '+') put(doors, 'doors', x, 0, y, bright);
      else if (corr) put(dirts, 'dirts', x, 0, y, bright); else put(floors, 'floors', x, 0, y, bright);
      put(ceils, 'ceils', x, 1, y, bright);
      if (c === '+') put(lintels, 'lintels', x, 0.89, y, bright);
      if (TERRAIN.has(c) || c === '@') continue;
      const fg = (s & 15) ? PALETTE[(s & 15) - 1] : '#c8ccd1';
      if (c === '%') continue;
      const dc = DECALS[c];
      if (dc) {   // 罠は床に描く
        put(meshes[dc.mesh], dc.mesh, x, 0.006, y, bright, yawOf(facing));   // 字の上を向いている方へ
        if (fg !== dc.color) { dc.color = fg; dc.mat.color.set(fg); }
        continue;
      }
      // モンスター（大文字）は立たせ、それ以外（アイテム・罠）は床の近くに浮かべる
      const sp = new THREE.Sprite(glyphMat(c, fg));
      const mon = c >= 'A' && c <= 'Z';
      sp.userData = { ch: c, col: fg, dim: !!(s & 512) };
      const size = mon ? 0.78 : 0.42;
      sp.scale.set(size, size, 1);
      sp.position.set(x + 0.5, mon ? 0.42 : 0.24, y + 0.5);
      if (s & 512) { sp.material = sp.material.clone(); sp.material.opacity = 0.5; }
      glyphGroup.add(sp);
    }
  }
  for (const k of aheadRocks) {
    const y = Math.floor(k / W), x = k % W;
    put(rocks, 'rocks', x, 0.5, y, DIM_AHEAD); solid[k] = DIM_AHEAD;
  }
  buildEdges(solid, stairCells);
  for (const [name, mesh] of Object.entries(meshes)) {
    mesh.count = counts[name];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

// 壁・岩の面のうち、開いた側を向いた面の輪郭を線にする。床と天井との境目は面ごとに、
// 縦の線は面が途切れる所（部屋の角・通路の曲がり角）にだけ引く（マスごとに引くと格子になってうるさい）
function buildEdges(solid, stairCells = []) {
  const pos = [], col = [], bri = [];
  const isSolid = (y, x) => y >= MAP_TOP && y <= MAP_BOT && x >= 0 && x < W && solid[y * W + x] > 0;
  const line = (ax, ay, az, bx, by, bz, b) => {
    pos.push(ax, ay, az, bx, by, bz);
    const v = 0.5 * b; col.push(v, v * 1.04, v * 1.1, v, v * 1.04, v * 1.1);
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
  // 下り階段: 穴の縁と、段の角（踏み面の先と、蹴込みの下）
  for (const [y, x, b] of stairCells) {
    line(x, 0.004, y, x + 1, 0.004, y, b); line(x, 0.004, y + 1, x + 1, 0.004, y + 1, b);
    line(x, 0.004, y, x, 0.004, y + 1, b); line(x + 1, 0.004, y, x + 1, 0.004, y + 1, b);
    for (let i = 0; i < STEPS; i++) {
      const z0 = y + 1 - i / STEPS, upper = -STEP_DROP * i, top = -STEP_DROP * (i + 1);
      line(x, upper, z0, x + 1, upper, z0, b);   // 一段上の踏み面の先
      line(x, top, z0, x + 1, top, z0, b);       // この段の蹴込みの下
    }
  }
  edgeSegs = pos; edgeBright = bri;
  edges.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  edges.geometry = g;
}

// ---------------------------------------------------------------------------
// ASCII の見た目: 場面を升目と同じ粗さ（1 升 = 1 画素）で描き、読み出した値から文字を選ぶ。
// 面の材質は 赤 = 明るさ（覚えているだけの所は暗く、遠いほど暗く）、緑 = 何の面か、青 = 面の向き、
// 不透明度 = 距離 を書き出す。モンスターなどの字は、位置を升目に写して上から描く
// ---------------------------------------------------------------------------
function kindMat(kind) {
  return new THREE.ShaderMaterial({
    uniforms: { kind: { value: kind } },
    vertexShader: `
      varying vec3 vN; varying float vB; varying float vD;
      void main() {
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = m * instanceMatrix;
        #endif
        vN = normalize(mat3(m) * normal);
        vB = 1.0;
        #ifdef USE_INSTANCING_COLOR
          vB = instanceColor.r;
        #endif
        vec4 mv = viewMatrix * m * vec4(position, 1.0);
        vD = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float kind; varying vec3 vN; varying float vB; varying float vD;
      void main() {
        float side = abs(vN.y) > 0.5 ? 0.0 : (abs(vN.x) > 0.5 ? 1.0 : 2.0);
        float face = side == 2.0 ? 0.78 : 1.0;   // 壁は向きで濃さを変えて角を見せる
        // 遠いほど暗く（薄い字に）。いま見えている所（明るい部屋）はゆっくり、覚えているだけの所は手元の明かりが届く範囲で
        float far = 1.0 - 0.9 * smoothstep(0.6, 10.0, vD);
        float torch = 1.0 / (1.0 + 0.11 * vD * vD);
        float lit = face * (vB > 0.9 ? far : min(1.0, vB * 2.3 * torch + 0.04 * far));
        gl_FragColor = vec4(lit, kind / 15.0, side / 2.0, max(clamp(vD / 16.0, 0.0, 1.0), 1.0 / 255.0));
      }`,
  });
}

// 升目 1 つの横幅（CSS の px。縦はその 2 倍）。小さいほど細かく描けるが字も小さくなる
export const CELL_SIZES = { coarse: 7.5, mid: 5.5, fine: 4 };
let cellSize = 'mid';
try { cellSize = localStorage.getItem('rogue3d-cell') || cellSize; } catch {}
export const getCellSize = () => cellSize;
export function setCellSize(k) {
  cellSize = k;
  try { localStorage.setItem('rogue3d-cell', k); } catch {}
  resize();
}
let tcols = 0, trows = 0, tcw = 0, tch = 0, rt = null, tbuf = null;
function sizeTerm(w, h) {
  tcols = Math.max(24, Math.round(w / (CELL_SIZES[cellSize] || CELL_SIZES.mid))); tcw = w / tcols;
  tch = tcw * 2; trows = Math.max(12, Math.floor(h / tch));
  const dpr = Math.min(devicePixelRatio || 1, 2);
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
function drawLines(C, R, depthOf) {
  const out = new Array(C * R);
  const near = 0.12;
  let segB = 1;
  const put = (x, y, ch, dist) => {
    if (x < 0 || y < 0 || x >= C || y >= R) return;
    if (depthOf(x, y) < dist - 0.35) return;   // 手前の壁に隠れる
    const o = out[y * C + x];
    if (o && o.d <= dist) return;
    // 明るさ: 遠いほど暗く。覚えているだけ・まだ分からない所の線は、その暗さに合わせる
    const far = 1 - 0.9 * Math.min(1, Math.max(0, (dist - 0.6) / 9.4));
    out[y * C + x] = { ch, d: dist, v: segB >= 0.9 ? far : Math.min(1, segB * 2.3 / (1 + 0.11 * dist * dist)) };
  };
  for (let i = 0; i < edgeSegs.length; i += 6) {
    segB = edgeBright[i / 6] ?? 1;
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
    const pts = [];
    for (let k = 0; k <= n; k++) {
      _p.copy(_a).lerp(_b, k / n);
      const dist = -_p.z;
      _p.applyMatrix4(camera.projectionMatrix);
      pts.push([(_p.x + 1) / 2 * C, (1 - _p.y) / 2 * R, dist]);
    }
    const dxc = bx - ax, dyc = by - ay;
    const slope = Math.abs(dyc * 2 / (dxc || 1e-6));
    if (slope >= 1) {
      // 1 行に 1 字: 行の真ん中を通る所
      const rows = new Map();
      for (const q of pts) {
        const y = Math.floor(q[1]); if (y < 0 || y >= R) continue;
        const e = Math.abs(q[1] - (y + 0.5)), r = rows.get(y);
        if (!r || e < r.e) rows.set(y, { e, x: q[0], d: q[2] });
      }
      const ch = slope > 3 ? '|' : (dyc > 0) === (dxc > 0) ? '\\' : '/';
      const ys = [...rows.keys()].sort((p, q) => p - q);
      ys.forEach((y, j) => {
        const r = rows.get(y), x = Math.floor(r.x);
        put(x, y, ch, r.d);
        const nx = rows.has(y + 1) ? Math.floor(rows.get(y + 1).x) : null;
        if (ch === '|' || nx === null) return;
        // 次の行まで横に 2 升以上ずれるなら、この行の続きを _ で埋める
        if (ch === '\\') for (let k = x + 1; k < nx; k++) put(k, y, '_', r.d);
        else for (let k = nx + 1; k < x; k++) put(k, y, '_', r.d);
      });
    } else {
      // 1 列に 1 字: 列の真ん中を通る所の高さで字を選ぶ
      const cols = new Map();
      for (const q of pts) {
        const x = Math.floor(q[0]); if (x < 0 || x >= C) continue;
        const e = Math.abs(q[0] - (x + 0.5)), c = cols.get(x);
        if (!c || e < c.e) cols.set(x, { e, y: q[1], d: q[2] });
      }
      for (const [x, c] of cols) {
        const y = Math.floor(c.y), f = c.y - y;   // 升の中の高さ（0 = 上、1 = 下）
        put(x, y, f > 0.72 ? '_' : f > 0.5 ? '.' : f > 0.28 ? '-' : "'", c.d);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// モンスターの形（ASCII の見た目で近くにいるとき）。X の升をモンスター自身の字で、e の升を目として描く。
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
  A: [   // アクエイター: 触手の垂れた水の塊
    '   XXXXXXX   ',
    '  XXeXXXeXX  ',
    ' XXXXXXXXXXX ',
    ' XXXXXXXXXXX ',
    '  XXXXXXXXX  ',
    ' X X X X X X ',
    'X X X X X X X',
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
  D: [   // ドラゴン: 翼を広げた竜
    'XX                XX',
    'XXX     XXXX     XXX',
    'XXXX   XeXXeX   XXXX',
    'XXXXX   XXXX   XXXXX',
    ' XXXXXXXXXXXXXXXXXX ',
    '  XXXXXXXXXXXXXXXX  ',
    '      XXXXXXXX      ',
    '      XXX  XXX      ',
    '     XXX    XXX     ',
    '    XX        XX    ',
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
  I: [   // アイスモンスター: 氷の塊
    '    X   X    ',
    '   XXX XXX   ',
    '  XXXXXXXXX  ',
    ' XXeXXXXXeXX ',
    'XXXXXXXXXXXXX',
    ' XXXXXXXXXXX ',
    '  XXX   XXX  ',
    '   X     X   ',
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
  Q: [   // クアッガ: 縞のある馬
    'XX            ',
    'XeX           ',
    ' XXX          ',
    '  XXXXXXXXXX  ',
    '  XXXXXXXXXXX ',
    '  XXXXXXXXXX X',
    '  X  X   X  X ',
    '  X  X   X  X ',
    ' XX XX  XX XX ',
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
  U: [   // ブラックユニコーン: 角のある馬
    'X             ',
    ' X            ',
    '  XX          ',
    ' XeXX         ',
    '  XXX         ',
    '   XXXXXXXXXX ',
    '   XXXXXXXXXXX',
    '   XXXXXXXXXX ',
    '   X  X  X  X ',
    '   X  X  X  X ',
    '  XX XX XX XX ',
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
  X: [   // ゼロック: 大きな一つ目
    '   XXXXXXX   ',
    '  XX     XX  ',
    ' XX  XXX  XX ',
    ' X  XXeXX  X ',
    ' XX  XXX  XX ',
    '  XX     XX  ',
    '   XXXXXXX   ',
    '  X  X X  X  ',
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
for (const art of Object.values(ART)) {   // 行の長さをそろえる（短い行は右を空白で埋める）
  const n = Math.max(...art.map(r => r.length));
  art.forEach((r, i) => { art[i] = r.padEnd(n); });
}
// 形で描けたら true（近くて、1 升が画面の升の 0.75 倍以上になるとき）
function drawArt(o, u) {
  const art = ART[u.ch];
  if (!art) return false;
  const rows = art.length, cols = art[0].length;
  // 形の 1 升の高さ（縦に長い形ほど背が高くなる。ただし画面の 9 割まで）
  const h = Math.min(o.size * 1.15 / Math.min(rows, 9), trows * tch * 0.9 / rows);
  const bottom = o.py + o.size / 2.3;   // 足元を床にそろえる（札の下の端 = 中心から札の高さの半分下）
  if (h < tch * 0.75) return drawArtSmall(art, u, h, bottom, o.px);
  const w = h / 2, x0 = o.px - cols * w / 2, y0 = bottom - rows * h;
  tctx.font = `700 ${h}px "BIZ UDGothic", monospace`;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const m = art[r][c];
    if (m === ' ') continue;
    const x = x0 + c * w, y = y0 + r * h;
    tctx.fillStyle = '#000'; tctx.fillRect(x - 0.5, y, w + 1, h);   // 後ろの壁の字を消す
    tctx.fillStyle = m === 'e' ? '#ffe08a' : (u.col || '#c8ccd1');
    tctx.fillText(m === 'e' ? '*' : u.ch, x + w / 2, y + h / 2 + h * 0.04);
  }
  return true;
}

// 遠くて形の 1 升が画面の升より小さいとき: 形を画面の升目の粗さに縮めて、升目にそろえて描く。
// 縮めた 1 升に当たる範囲の 3 割以上が埋まっていれば字を置く（細い所が消えないように、少なくとも 1 升は残す）
function drawArtSmall(art, u, h, bottom, cx) {
  const rows = art.length, cols = art[0].length;
  const tr = Math.max(1, Math.round(rows * h / tch)), tc = Math.max(1, Math.round(cols * h / 2 / tcw));
  if (tr * tc <= 1) return false;   // 1 升にしかならないなら 1 文字で
  const gx0 = Math.round(cx / tcw - tc / 2), gy0 = Math.round(bottom / tch - tr);
  tctx.font = `700 ${tch * 0.94}px "BIZ UDGothic", monospace`;
  let drawn = 0;
  for (let r = 0; r < tr; r++) for (let c = 0; c < tc; c++) {
    const r0 = Math.floor(r * rows / tr), r1 = Math.max(r0 + 1, Math.floor((r + 1) * rows / tr));
    const c0 = Math.floor(c * cols / tc), c1 = Math.max(c0 + 1, Math.floor((c + 1) * cols / tc));
    let n = 0, eye = false;
    for (let y = r0; y < r1; y++) for (let x = c0; x < c1; x++) { const m = art[y][x]; if (m !== ' ') n++; if (m === 'e') eye = true; }
    if (n < (r1 - r0) * (c1 - c0) * 0.3) continue;
    const x = (gx0 + c) * tcw, y = (gy0 + r) * tch;
    tctx.fillStyle = '#000'; tctx.fillRect(x, y, tcw, tch);
    tctx.fillStyle = eye && tr >= 3 ? '#ffe08a' : (u.col || '#c8ccd1');
    tctx.fillText(eye && tr >= 3 ? '*' : u.ch, x + tcw / 2, y + tch / 2 + tch * 0.04);
    drawn++;
  }
  return drawn > 0;
}

// 色 #rrggbb を明るさ v（0〜1）で暗くした rgb()
function tint(hex, v) {
  const n = parseInt(hex.slice(1), 16), k = 0.25 + v * 0.75;
  return `rgb(${Math.round((n >> 16 & 255) * k)},${Math.round((n >> 8 & 255) * k)},${Math.round((n & 255) * k)})`;
}

const WALL_RAMP = ' .:-=+*#';    // 壁の濃さ（暗い → 明るい）。@ や % は重すぎるので使わない
const ROCK_RAMP = ' ..::';
function drawTerm() {
  if (!rt) return;
  // 1. 面の種類・明るさ・距離を升目の粗さで描いて読み出す
  const bg = scene.background, gv = glyphGroup.visible, ev = edges.visible;
  scene.background = null; glyphGroup.visible = false; edges.visible = false;
  for (const sp of flying) sp.visible = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0); renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(rt, 0, 0, tcols, trows, tbuf);
  renderer.setRenderTarget(null);
  scene.background = bg; glyphGroup.visible = gv; edges.visible = ev;
  for (const sp of flying) sp.visible = true;

  const C = tcols, R = trows;
  const inside = (x, y) => x >= 0 && y >= 0 && x < C && y < R;
  const at = (x, y) => ((R - 1 - y) * C + x) * 4;   // 読み出しは下の行から
  const depthOf = (x, y) => { if (!inside(x, y)) return 99; const i = at(x, y); return tbuf[i + 3] ? tbuf[i + 3] / 255 * 16 : 99; };

  const lines = drawLines(C, R, depthOf);
  tctx.fillStyle = '#000'; tctx.fillRect(0, 0, C * tcw, (R + 1) * tch);
  tctx.font = `400 ${tch * 0.94}px "BIZ UDGothic", monospace`;
  tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
  for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
    const i = at(x, y);
    // 2. 壁の輪郭の線が通る升は、線の傾きに合った字（drawLines で決めたもの）。面がない所（闇との境）にも引く
    const ln = lines[y * C + x];
    if (!tbuf[i + 3] && !ln) continue;
    const lit = tbuf[i] / 255, kind = tbuf[i + 3] ? Math.round(tbuf[i + 1] / 255 * 15) : 0;
    if (lit < 0.03 && !ln) continue;
    let ch = null, v = lit;
    if (ln) {
      ch = ln.ch; v = Math.min(1, ln.v * 1.2 + 0.12);
    } else if (kind === 1) {
      ch = WALL_RAMP[Math.min(WALL_RAMP.length - 1, Math.floor(lit * WALL_RAMP.length))];
    } else if (kind === 3) {
      ch = ROCK_RAMP[Math.min(ROCK_RAMP.length - 1, Math.floor(lit * ROCK_RAMP.length))]; v = lit * 0.6;
    } else if (kind === 4) { ch = '.'; v = lit * 0.85; }
    else if (kind === 5) { ch = '#'; v = lit * 0.7; }
    else if (kind === 6) { ch = '+'; }
    else if (kind === 8) { ch = tbuf[i + 2] < 64 ? '=' : '#'; v = Math.min(1, lit * 1.1 + 0.1); }   // 下り階段の段（踏み面 = 、蹴込み #）
    else if (kind === 9) { ch = '^'; v = Math.min(1, lit * 1.1 + 0.1); }
    else if (kind === 7) { ch = x % 3 === 0 && y % 2 === 0 ? '`' : ' '; v = lit * 0.4; }   // 天井はまばらに
    if (!ch || ch === ' ') continue;
    const g = Math.round(40 + v * 215);
    tctx.fillStyle = ln ? `rgb(${Math.round(30 + v * 113)},${Math.round(40 + v * 139)},${Math.round(60 + v * 195)})`   // 境界線は青
      : kind === 6 ? `rgb(${g},${Math.round(g * 0.82)},${Math.round(g * 0.5)})`
      : kind === 8 ? tint(stairsColor, v) : kind === 9 ? tint(DECALS['^'].color, v) : `rgb(${g},${g},${Math.min(255, g + 8)})`;
    tctx.fillText(ch, (x + 0.5) * tcw, (y + 0.5) * tch + tch * 0.04);
  }

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
    if (depthOf(ix, iy) < dist - 0.45) continue;   // 壁の向こう
    const hPx = sp.scale.y / (2 * dist * Math.tan(camera.fov * Math.PI / 360)) * R * tch;
    list.push({ sp, dist, px: cx * tcw, py: cy * tch, size: Math.max(tch * 0.95, Math.min(R * tch * 0.6, hPx * 1.15)) });   // 上限は画面の高さに対して（升目の大きさで変わらないように）
  }
  list.sort((a, b) => b.dist - a.dist);   // 遠い物から
  for (const o of list) {
    const u = o.sp.userData;
    const fade = 1 - Math.min(0.75, Math.max(0, (o.dist - 2) / 12));
    tctx.globalAlpha = (u.dim ? 0.5 : 1) * fade;
    const uu = u.flash ? { ...u, col: '#ffffff' } : u;
    if (drawArt(o, uu)) continue;
    tctx.font = `700 ${o.size}px "BIZ UDGothic", monospace`;
    tctx.fillStyle = '#000';
    const w = tctx.measureText(u.ch).width;
    tctx.fillRect(o.px - w / 2 - 1, o.py - o.size / 2, w + 2, o.size);   // 後ろの字を消して読みやすく
    tctx.fillStyle = uu.col || '#c8ccd1';
    tctx.fillText(u.ch, o.px, o.py + o.size * 0.04);
  }
  tctx.globalAlpha = 1;
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
  const k = Math.min(1, (now - t0) / DUR), e = k * (2 - k);
  cam.x = from.x + (to.x - from.x) * e; cam.z = from.z + (to.z - from.z) * e; cam.yaw = from.yaw + (to.yaw - from.yaw) * e;
  draw();
  if (k < 1) requestAnimationFrame(tick); else animating = false;
}

export function turn(d) {
  facing = (facing + d + 8) % 8;
  try { localStorage.setItem('rogue3d-facing', facing); } catch {}
  if (lastGrid) build(lastGrid);   // 床に描いた字（階段・罠）の向きを合わせ直す
  if (player && cam) animateTo(target());
}

// 投げた物が飛んでいく様子: 自分のマスから道筋に沿って滑らかに動かす（ゲームは step × マス数 だけ待っている）
export function missile(m) {
  if (!renderer || !player || !m.path.length) return;
  const col = (m.style & 15) ? PALETTE[(m.style & 15) - 1] : '#c8ccd1';
  const sp = new THREE.Sprite(glyphMat(m.ch, col));
  sp.scale.set(0.4, 0.4, 1);
  sp.userData = { ch: m.ch, col };
  scene.add(sp); flying.add(sp);
  const pts = [player, ...m.path], dur = m.step * m.path.length, t0 = performance.now();
  const frame = now => {
    const k = Math.min(1, (now - t0) / dur) * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(k)), f = k - i;
    const y = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, x = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
    sp.position.set(x + 0.5, 0.42, y + 0.5);
    draw();
    if (k < pts.length - 1) requestAnimationFrame(frame); else { scene.remove(sp); flying.delete(sp); draw(); }
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// 演出: 敵に当てた（白く点滅して震え、ダメージの数字が浮かぶ。倒したら字が飛び散る）、
// 自分がくらった（画面が揺れ、殴ってきた方向の端が赤く光る）。ゲームから rogue_effect で届く
// ---------------------------------------------------------------------------
const fx = { hits: [], nums: [], debris: [], pops: [], shakeT0: -1e9, lastHp: null };
let fxcv, fxctx, hurtEl, fxRunning = false;
const HIT_MS = 260, NUM_MS = 800, DEBRIS_MS = 650, SHAKE_MS = 320, POP_MS = 900;

function initFx(canvas) {
  fxcv = document.createElement('canvas');
  fxcv.id = 'v3fx'; fxcv.setAttribute('aria-hidden', 'true');
  canvas.parentElement.append(fxcv);
  fxctx = fxcv.getContext('2d');
  hurtEl = document.createElement('div');
  hurtEl.id = 'v3hurt'; hurtEl.setAttribute('aria-hidden', 'true');
  canvas.parentElement.append(hurtEl);
}
function sizeFx(w, h) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  fxcv.width = Math.round(w * dpr); fxcv.height = Math.round(h * dpr);
  fxctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function effect(d) {
  const now = performance.now();
  if (d.type === 'hit') {
    const cell = lastGrid && lastGrid[d.y] && lastGrid[d.y][d.x];
    const ch = cell ? cell[0] : '*', col = cell && (cell[1] & 15) ? PALETTE[(cell[1] & 15) - 1] : '#ff6a5c';
    fx.hits.push({ y: d.y, x: d.x, t0: now });
    fx.nums.push({ y: d.y, x: d.x, t0: now, text: '-' + d.dmg });
    if (d.killed) {
      for (let i = 0; i < 16; i++) {
        const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 1.2;
        fx.debris.push({ y: d.y, x: d.x, t0: now, ch, col, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 0.8 + Math.random() * 1.6, h: 0.2 + Math.random() * 0.5 });
      }
    }
  } else if (d.type === 'hurt') {
    hurt(d.y == null ? null : [d.y, d.x]);
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

// 状態行の HP が減ったのに知らせがなかったとき（罠・毒・空腹など）も揺らす
function watchHp(grid) {
  const status = (grid[23] || []).filter(Boolean).map(c => c[0]).join('');
  const m = status.match(/HP:\s*(\d+)/i);
  if (!m) return;
  const hp = +m[1];
  if (fx.lastHp !== null && hp < fx.lastHp && performance.now() - fx.shakeT0 > 400) { hurt(null); startFx(); }
  fx.lastHp = hp;
}

const fxActive = now => now - fx.shakeT0 < SHAKE_MS || fx.hits.length || fx.nums.length || fx.debris.length || fx.pops.length;
function startFx() {
  if (fxRunning) return;
  fxRunning = true;
  requestAnimationFrame(function tick(now) {
    fx.hits = fx.hits.filter(h => now - h.t0 < HIT_MS);
    fx.nums = fx.nums.filter(n => now - n.t0 < NUM_MS);
    fx.debris = fx.debris.filter(p => now - p.t0 < DEBRIS_MS);
    fx.pops = fx.pops.filter(p => now - p.t0 < POP_MS);
    draw();
    if (fxActive(now)) requestAnimationFrame(tick);
    else { fxRunning = false; draw(); }
  });
}

// 当てたモンスターの札を震わせる（draw の間だけ位置をずらす）。点滅は ASCII では drawTerm、ほかは材質を白に
function hitAt(y, x, now) { return fx.hits.find(h => h.y === y && h.x === x && now - h.t0 < HIT_MS); }
function jitterSprites(now, on) {
  if (!fx.hits.length) return;
  for (const sp of glyphGroup.children) {
    const y = Math.round(sp.position.z - 0.5), x = Math.round(sp.position.x - 0.5);
    if (on) {
      const h = hitAt(y, x, now); if (!h) continue;
      const k = 1 - (now - h.t0) / HIT_MS;
      sp.userData.base = sp.position.clone();
      sp.position.x += (Math.random() - 0.5) * 0.12 * k; sp.position.y += (Math.random() - 0.5) * 0.06 * k;
      sp.userData.flash = ((now - h.t0) / 65 | 0) % 2 === 0;
      if (theme !== 'term' && sp.userData.flash) { sp.userData.mat = sp.material; sp.material = glyphMat(sp.userData.ch, '#ffffff'); }
    } else if (sp.userData.base) {
      sp.position.copy(sp.userData.base); sp.userData.base = null; sp.userData.flash = false;
      if (sp.userData.mat) { sp.material = sp.userData.mat; sp.userData.mat = null; }
    }
  }
}

// ダメージの数字と飛び散る字（どの見た目でも上に重ねて描く）
const _v = new THREE.Vector3();
function project(x, y, z) {
  _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  const dist = -_v.z;
  if (dist < 0.12) return null;
  _v.set(x, y, z).project(camera);
  const W2 = fxcv.width / Math.min(devicePixelRatio || 1, 2), H2 = fxcv.height / Math.min(devicePixelRatio || 1, 2);
  return { px: (_v.x + 1) / 2 * W2, py: (1 - _v.y) / 2 * H2, dist, unit: H2 / (2 * dist * Math.tan(camera.fov * Math.PI / 360)) };
}
function drawFx(now) {
  if (!fxctx) return;
  fxctx.clearRect(0, 0, fxcv.width, fxcv.height);
  fxctx.textAlign = 'center'; fxctx.textBaseline = 'middle';
  for (const n of fx.nums) {
    const k = (now - n.t0) / NUM_MS;
    const p = project(n.x + 0.5, 0.95 + k * 0.45, n.y + 0.5); if (!p) continue;
    const size = Math.max(14, Math.min(48, p.unit * 0.3));
    fxctx.globalAlpha = 1 - Math.max(0, (k - 0.5) * 2);
    fxctx.font = `700 ${size}px "BIZ UDGothic", monospace`;
    fxctx.lineWidth = 4; fxctx.strokeStyle = '#000'; fxctx.strokeText(n.text, p.px, p.py);
    fxctx.fillStyle = '#ffe08a'; fxctx.fillText(n.text, p.px, p.py);
  }
  for (const d of fx.debris) {
    const t = (now - d.t0) / 1000, k = (now - d.t0) / DEBRIS_MS;
    const y = Math.max(0.02, d.h + d.vy * t - 4.5 * t * t);
    const p = project(d.x + 0.5 + d.vx * t, y, d.y + 0.5 + d.vz * t); if (!p) continue;
    const size = Math.max(8, Math.min(40, p.unit * 0.16));
    fxctx.globalAlpha = 1 - k;
    fxctx.font = `700 ${size}px "BIZ UDGothic", monospace`;
    fxctx.fillStyle = d.col; fxctx.fillText(d.ch, p.px, p.py);
  }
  // 見つけた扉: + が光りながら大きくなって消える
  for (const o of fx.pops) {
    const k = (now - o.t0) / POP_MS;
    const p = project(o.x + 0.5, 0.5, o.y + 0.5); if (!p) continue;
    const size = Math.max(16, Math.min(160, p.unit * (0.5 + k * 0.6)));
    fxctx.globalAlpha = 1 - k;
    fxctx.font = `700 ${size}px "BIZ UDGothic", monospace`;
    fxctx.shadowColor = '#f0c652'; fxctx.shadowBlur = 24;
    fxctx.fillStyle = '#ffe08a'; fxctx.fillText(o.ch, p.px, p.py);
    fxctx.shadowBlur = 0;
  }
  fxctx.globalAlpha = 1;
}

function draw() {
  if (!renderer || !cam) return;
  const now = performance.now();
  // 自分のマスの少し後ろから見る（真ん中からだと両脇の壁しか見えず窮屈）
  const back = 0.32;
  camera.position.set(cam.x + Math.sin(cam.yaw) * back, EYE, cam.z + Math.cos(cam.yaw) * back);
  camera.rotation.set(0, cam.yaw, 0, 'YXZ');
  const sk = 1 - (now - fx.shakeT0) / SHAKE_MS;   // くらったときの揺れ
  if (sk > 0) {
    camera.position.x += (Math.random() - 0.5) * 0.14 * sk; camera.position.y += (Math.random() - 0.5) * 0.08 * sk;
    camera.rotation.z = (Math.random() - 0.5) * 0.06 * sk;
  }
  camera.updateMatrixWorld();
  torch.position.set(cam.x, 0.8, cam.z);
  jitterSprites(now, true);
  if (theme === 'term') drawTerm(); else renderer.render(scene, camera);
  jitterSprites(now, false);
  drawFx(now);
}
