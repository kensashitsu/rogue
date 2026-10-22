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
let meshes = {}, themes = {}, edges, tcv, tctx;
const flying = new Set();   // 飛んでいる最中の物（投げた物）
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
    // ASCII: 場面を升目の粗さで描いて、升目ごとに文字へ置き換える（drawTerm）。ここでの材質は「何の面か」を書き出すだけ
    term: {
      bg: '#000000', fog: [2, 13], light: false, term: true,
      mat: { hwalls: kindMat(1), vwalls: kindMat(1), rocks: kindMat(3), floors: kindMat(4), dirts: kindMat(5),
        doors: kindMat(6), ceils: kindMat(7), lintels: null },
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
      sp.userData = { ch: c, col: fg, dim: !!(s & 512) };
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
        float lit = vB * face * (1.0 - 0.9 * smoothstep(0.6, 10.0, vD));   // 遠いほど暗く（薄い字に）
        gl_FragColor = vec4(lit, kind / 8.0, side / 2.0, max(clamp(vD / 16.0, 0.0, 1.0), 1.0 / 255.0));
      }`,
  });
}

const CELL_W = 7.5;   // 升目 1 つの横幅（CSS の px）。縦はその 2 倍
let tcols = 0, trows = 0, tcw = 0, tch = 0, rt = null, tbuf = null;
function sizeTerm(w, h) {
  tcols = Math.max(24, Math.round(w / CELL_W)); tcw = w / tcols;
  tch = tcw * 2; trows = Math.max(12, Math.floor(h / tch));
  const dpr = Math.min(devicePixelRatio || 1, 2);
  tcv.width = Math.round(w * dpr); tcv.height = Math.round(h * dpr);
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (rt) rt.dispose();
  rt = new THREE.WebGLRenderTarget(tcols, trows, { depthBuffer: true });
  tbuf = new Uint8Array(tcols * trows * 4);
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
  const keyOf = (x, y) => { if (!inside(x, y)) return -1; const i = at(x, y); return tbuf[i + 3] ? Math.round(tbuf[i + 1] / 255 * 8) * 3 + Math.round(tbuf[i + 2] / 255 * 2) : -1; };
  const depthOf = (x, y) => { if (!inside(x, y)) return 99; const i = at(x, y); return tbuf[i + 3] ? tbuf[i + 3] / 255 * 16 : 99; };

  tctx.fillStyle = '#000'; tctx.fillRect(0, 0, C * tcw, (R + 1) * tch);
  tctx.font = `400 ${tch * 0.94}px "BIZ UDGothic", monospace`;
  tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
  for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) {
    const i = at(x, y);
    if (!tbuf[i + 3]) continue;
    const lit = tbuf[i] / 255, kind = Math.round(tbuf[i + 1] / 255 * 8), d = tbuf[i + 3] / 255 * 16;
    if (lit < 0.03) continue;
    // 2. 境目（面の種類・向きが変わる所、手前と奥の段差）なら、境目の向きの字（| - / \）
    const k = keyOf(x, y);
    const differs = (nx, ny) => {
      const nk = keyOf(nx, ny), nd = depthOf(nx, ny);
      if (nk === k && Math.abs(nd - d) < 0.25 + d * 0.12) return false;
      return d <= nd + 0.05;   // 線は手前側の升だけに引く（二重にならないように）
    };
    const L = differs(x - 1, y), Rt = differs(x + 1, y), U = differs(x, y - 1), D = differs(x, y + 1);
    let ch = null, v = lit;
    if (kind !== 7 && (L || Rt || U || D)) {
      if ((U || D) && !(L || Rt)) ch = D ? '_' : '-';
      else if ((L || Rt) && !(U || D)) ch = '|';
      else ch = (D && Rt) || (U && L) ? '/' : '\\';
      v = Math.min(1, lit * 1.25 + 0.1);
    } else if (kind === 1) {
      ch = WALL_RAMP[Math.min(WALL_RAMP.length - 1, Math.floor(lit * WALL_RAMP.length))];
    } else if (kind === 3) {
      ch = ROCK_RAMP[Math.min(ROCK_RAMP.length - 1, Math.floor(lit * ROCK_RAMP.length))]; v = lit * 0.6;
    } else if (kind === 4) { ch = '.'; v = lit * 0.85; }
    else if (kind === 5) { ch = '#'; v = lit * 0.7; }
    else if (kind === 6) { ch = '+'; }
    else if (kind === 7) { ch = x % 3 === 0 && y % 2 === 0 ? '`' : ' '; v = lit * 0.4; }   // 天井はまばらに
    if (!ch || ch === ' ') continue;
    const g = Math.round(40 + v * 215);
    tctx.fillStyle = kind === 6 ? `rgb(${g},${Math.round(g * 0.82)},${Math.round(g * 0.5)})` : `rgb(${g},${g},${Math.min(255, g + 8)})`;
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
    list.push({ sp, dist, px: cx * tcw, py: cy * tch, size: Math.max(tch * 0.95, Math.min(tch * 8, hPx * 1.15)) });
  }
  list.sort((a, b) => b.dist - a.dist);   // 遠い物から
  for (const o of list) {
    const u = o.sp.userData;
    const fade = 1 - Math.min(0.75, Math.max(0, (o.dist - 2) / 12));
    tctx.globalAlpha = (u.dim ? 0.5 : 1) * fade;
    tctx.font = `700 ${o.size}px "BIZ UDGothic", monospace`;
    tctx.fillStyle = '#000';
    const w = tctx.measureText(u.ch).width;
    tctx.fillRect(o.px - w / 2 - 1, o.py - o.size / 2, w + 2, o.size);   // 後ろの字を消して読みやすく
    tctx.fillStyle = u.col || '#c8ccd1';
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

function draw() {
  if (!renderer || !cam) return;
  // 自分のマスの少し後ろから見る（真ん中からだと両脇の壁しか見えず窮屈）
  const back = 0.32;
  camera.position.set(cam.x + Math.sin(cam.yaw) * back, EYE, cam.z + Math.cos(cam.yaw) * back);
  camera.rotation.set(0, cam.yaw, 0, 'YXZ');
  torch.position.set(cam.x, 0.8, cam.z);
  if (theme === 'term') drawTerm(); else renderer.render(scene, camera);
}
