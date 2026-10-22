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
  rock: glyphTile('.', 4, 4, '#3a3f46', 3),      // 通路の両脇: ごく薄い点の面（原作の地図では空白の所なので目立たせない）
  ceil: glyphTile('.', 1, 1, '#6a7078', 6),      // 天井: 床の点を薄くしたもの
};

// ---------------------------------------------------------------------------
// 場面
// ---------------------------------------------------------------------------
let renderer, scene, camera, torch, ambient, cv;
const MAX = W * (MAP_BOT - MAP_TOP + 1);
let hwalls, vwalls, rocks, floors, dirts, doors, ceils, lintels;
let meshes = {}, themes = {}, edges;
let theme = 'ascii';
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
  };
  ({ hwalls, vwalls, rocks, floors, dirts, doors, ceils, lintels } = meshes);
  // 見た目ごとの材質（null は描かない）
  const lam = o => new THREE.MeshLambertMaterial(o), basic = map => new THREE.MeshBasicMaterial({ map });
  const stone = lam({ map: stoneTex }), stoneFloor = lam({ map: floorTex });
  themes = {
    stone: {
      bg: '#050607', fog: [1.5, 11], light: true,
      mat: { hwalls: stone, vwalls: stone, rocks: lam({ map: rockTex }), floors: stoneFloor, dirts: lam({ map: dirtTex }),
        doors: stoneFloor, ceils: lam({ color: '#1c1916' }), lintels: lam({ color: '#5a3d22' }) },
    },
    // 文字: 天井も岩もない真っ暗な中に、地図の記号だけが並ぶ
    ascii: {
      bg: '#000000', fog: [2, 13], light: false,
      mat: { hwalls: basic(asciiTex.hwall), vwalls: basic(asciiTex.vwall), rocks: basic(asciiTex.rock), floors: basic(asciiTex.floor),
        dirts: basic(asciiTex.passage), doors: basic(asciiTex.door), ceils: basic(asciiTex.ceil), lintels: null },
      edges: true,
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
  const th = themes[theme] || themes.ascii;
  for (const [name, mesh] of Object.entries(meshes)) {
    const m = th.mat[name];
    mesh.visible = !!m;
    if (m) mesh.material = m;
  }
  scene.background.set(th.bg);
  scene.fog.color.set(th.bg); [scene.fog.near, scene.fog.far] = th.fog;
  ambient.visible = torch.visible = th.light;
  edges.visible = !!th.edges;
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
let player = null, lastSig = '';

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
  const learned = learnRock(grid, pos);
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
  const put = (mesh, name, x, y, z, bright) => {
    dummy.position.set(x + 0.5, y, z + 0.5); dummy.updateMatrix();
    const i = counts[name]++;
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, color.setScalar(bright));
  };
  glyphGroup.clear();
  const solid = new Float32Array(W * 24);   // 壁・岩のマス（値は明るさ）。輪郭線を引くのに使う
  for (let y = MAP_TOP; y <= MAP_BOT; y++) {
    for (let x = 0; x < W; x++) {
      const [c, s] = cellAt(grid, y, x);
      const bright = s & 512 ? 0.38 : 1;   // 覚えているだけの所は暗く
      if (c === '-') { put(hwalls, 'hwalls', x, 0.5, y, bright); solid[y * W + x] = bright; continue; }
      if (c === '|') { put(vwalls, 'vwalls', x, 0.5, y, bright); solid[y * W + x] = bright; continue; }
      if (c === ' ') {
        // 何もない所: 隣に立って確かめた岩だけを岩にする（通路の壁）。まだ分からない所や、暗い部屋のまだ見ていない床は闇のまま
        if (!rock.has(y * W + x)) continue;
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
      if (c === '+') put(doors, 'doors', x, 0, y, bright);
      else if (corr) put(dirts, 'dirts', x, 0, y, bright); else put(floors, 'floors', x, 0, y, bright);
      put(ceils, 'ceils', x, 1, y, bright);
      if (c === '+') put(lintels, 'lintels', x, 0.89, y, bright);
      if (TERRAIN.has(c) || c === '@') continue;
      // モンスター（大文字）は立たせ、それ以外（アイテム・階段・罠）は床の近くに浮かべる
      const fg = (s & 15) ? PALETTE[(s & 15) - 1] : '#c8ccd1';
      const sp = new THREE.Sprite(glyphMat(c, fg));
      const mon = c >= 'A' && c <= 'Z';
      const size = mon ? 0.78 : 0.42;
      sp.scale.set(size, size, 1);
      sp.position.set(x + 0.5, mon ? 0.42 : 0.24, y + 0.5);
      if (s & 512) { sp.material = sp.material.clone(); sp.material.opacity = 0.5; }
      glyphGroup.add(sp);
    }
  }
  buildEdges(solid);
  for (const [name, mesh] of Object.entries(meshes)) {
    mesh.count = counts[name];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}

// 壁・岩の面のうち、開いた側を向いた面の輪郭を線にする。床と天井との境目は面ごとに、
// 縦の線は面が途切れる所（部屋の角・通路の曲がり角）にだけ引く（マスごとに引くと格子になってうるさい）
function buildEdges(solid) {
  const pos = [], col = [];
  const isSolid = (y, x) => y >= MAP_TOP && y <= MAP_BOT && x >= 0 && x < W && solid[y * W + x] > 0;
  const line = (ax, ay, az, bx, by, bz, b) => {
    pos.push(ax, ay, az, bx, by, bz);
    const v = 0.5 * b; col.push(v, v * 1.04, v * 1.1, v, v * 1.04, v * 1.1);
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
  edges.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  edges.geometry = g;
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
  if (player && cam) animateTo(target());
}

// 投げた物が飛んでいく様子: 自分のマスから道筋に沿って滑らかに動かす（ゲームは step × マス数 だけ待っている）
export function missile(m) {
  if (!renderer || !player || !m.path.length) return;
  const col = (m.style & 15) ? PALETTE[(m.style & 15) - 1] : '#c8ccd1';
  const sp = new THREE.Sprite(glyphMat(m.ch, col));
  sp.scale.set(0.4, 0.4, 1);
  scene.add(sp);
  const pts = [player, ...m.path], dur = m.step * m.path.length, t0 = performance.now();
  const frame = now => {
    const k = Math.min(1, (now - t0) / dur) * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(k)), f = k - i;
    const y = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, x = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
    sp.position.set(x + 0.5, 0.42, y + 0.5);
    draw();
    if (k < pts.length - 1) requestAnimationFrame(frame); else { scene.remove(sp); draw(); }
  };
  requestAnimationFrame(frame);
}

function draw() {
  if (!renderer || !cam) { renderer && renderer.render(scene, camera); return; }
  // 自分のマスの少し後ろから見る（真ん中からだと両脇の壁しか見えず窮屈）
  const back = 0.32;
  camera.position.set(cam.x + Math.sin(cam.yaw) * back, EYE, cam.z + Math.cos(cam.yaw) * back);
  camera.rotation.set(0, cam.yaw, 0, 'YXZ');
  torch.position.set(cam.x, 0.8, cam.z);
  renderer.render(scene, camera);
}
