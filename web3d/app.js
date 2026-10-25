// 3D 版（試作）の画面と操作（メインスレッド）。web/app.js を元に、地図の画面を r3d.js の一人称表示に置き換えた。
// 2D の地図は右上の小さな地図として残す。セーブは 2D 版と分ける（rogue3d-files）
//
// 以下は web/app.js の説明:
// ゲーム本体は worker.js（Pyodide）で動く。ここでは
//   - Worker から届く 80×24 の画面を canvas に描く（縦持ちでは自分の周りだけを表示して付いていく）
//   - ゲームが待っている入力の種類（term.input_hint）に合わせてボタンを出し分け、押されたキーを Worker へ渡す
//   - セーブ・スコア・言語設定のファイルを端末内（localStorage）に保存する
// を受け持つ。

import * as r3d from './r3d.js';

const VERSION = '3d-1.01';   // 画面右上に出す版番号。iPhone に新しい版が届いたか確かめる用。公開のたびに上げる
const W = 80, H = 24, KEYQ = 64;

// URL の末尾に #debug を付けて開くと、操作の出来事を画面の下に出す（実機で原因を調べる用）
const DEBUG = location.hash === '#debug';
const debugLines = [];
function debug(s) {
  if (!DEBUG) return;
  debugLines.push(`${(performance.now() / 1000).toFixed(2)} ${s}`);
  if (debugLines.length > 8) debugLines.shift();
  document.getElementById('debug').textContent = debugLines.join('\n');
}
const KEY = { DOWN: 0x102, UP: 0x103, LEFT: 0x104, RIGHT: 0x105, NPAGE: 0x152, PPAGE: 0x153 };
const PALETTE = ['#0b0d0f', '#ff6a5c', '#7fd17a', '#f0c652', '#6f9df2', '#d58cf0', '#6cc6d6', '#c8ccd1'];
const DEFAULT_FG = '#c8ccd1', DEFAULT_BG = '#0b0d0f';
const LIST_ROW = 30;                  // 選ぶ一覧の 1 行の高さ（px）の下限
const RATIO = 2.05;                  // セルの縦横比
const STORE = 'rogue3d-files';

const $ = id => document.getElementById(id);
const app = $('app'), cv = $('cv'), ctx = cv.getContext('2d'), box = $('screenBox');

// ---------------------------------------------------------------------------
// 表示文言（ゲームの表示言語に合わせる）
// ---------------------------------------------------------------------------
const L = {
  ja: {
    follow: '追従', full: '全体', small: '小', mid: '中', large: '大',
    acts: [['i', '持ち物'], ['e', '食べる'], ['q', '飲む'], ['r', '読む'], ['t', '投げる'], ['z', '杖を振る'], ['s', '探す'], ['>', '降りる'], ['more', 'その他']],
    more: [['w', '武器を持つ'], ['W', '鎧を着る'], ['T', '鎧を脱ぐ'], ['P', '指輪をはめる'], ['R', '指輪を外す'], ['d', '置く'], ['f', '戦う'], ['<', '昇る'], ['Z', '回復するまで休む'],
           ['^', '罠を調べる'], ['/', '記号を調べる'], ['@', '状態'], ['^P', '前の文'], ['o', '言語'], ['?', 'ヘルプ'], ['manual', '説明書'], ['S', '保存して終了'], ['Q', 'あきらめる'], ['export', 'セーブを書き出す'], ['import', 'セーブを読み込む']],
    noSave: '書き出せるセーブがありません。先に「保存して終了」で保存してください', badSave: 'セーブのファイルではありません',
    askImport: '今のセーブ（と記録）は、読み込んだセーブで置き換わります。よろしいですか？',
    moreTitle: 'その他のコマンド（小さな字は元のキー）', close: '閉じる', rest: '休む',
    next: '次へ', tapAnywhere: 'タップして次へ進む', cancel: 'やめる', ok: '決定', lang: 'English',
    dir: '方向を選んでください', list: '一覧の行をタップして選びます', listMore: '（↓ で続き）', name: '名前', text: '文字を入力',
    char: { y: 'はい', n: 'いいえ', l: '左', r: '右', e: 'English', j: '日本語' },
    loading: '読み込み中…', loadPy: 'Python を読み込み中…\n初回は数十秒かかります', loadGame: 'ゲームを準備中…',
    over: 'ゲームが終わりました', again: 'もう一度遊ぶ', saved: '保存しました。\n続きはいつでも遊べます', resume: '続きを遊ぶ',
    noIso: 'このブラウザでは動かせませんでした。\nSafari か Chrome の通常のウィンドウで開いてください。',
    crash: 'エラーで止まりました', reload: '読み込み直す',
  },
  en: {
    follow: 'Follow', full: 'Whole', small: 'S', mid: 'M', large: 'L',
    acts: [['i', 'Pack'], ['e', 'Eat'], ['q', 'Quaff'], ['r', 'Read'], ['t', 'Throw'], ['z', 'Zap'], ['s', 'Search'], ['>', 'Down'], ['more', 'More']],
    more: [['w', 'Wield'], ['W', 'Wear'], ['T', 'Take off'], ['P', 'Put on'], ['R', 'Remove'], ['d', 'Drop'], ['f', 'Fight'], ['<', 'Up'], ['Z', 'Rest to heal'],
           ['^', 'Trap'], ['/', 'Symbol'], ['@', 'Status'], ['^P', 'Last msg'], ['o', 'Language'], ['?', 'Help'], ['manual', 'Manual (ja)'], ['S', 'Save & quit'], ['Q', 'Quit'], ['export', 'Export save'], ['import', 'Import save']],
    noSave: 'There is no save to export. Use “Save & quit” first', badSave: 'This is not a save file',
    askImport: 'Your current save (and scores) will be replaced by the imported one. Continue?',
    moreTitle: 'More commands (small text = original key)', close: 'Close', rest: 'Rest',
    next: 'Next', tapAnywhere: 'Tap to continue', cancel: 'Cancel', ok: 'OK', lang: '日本語',
    dir: 'Choose a direction', list: 'Tap a line to choose', listMore: ' (↓ for more)', name: 'Name', text: 'Type here',
    char: { y: 'Yes', n: 'No', l: 'Left', r: 'Right', e: 'English', j: '日本語' },
    loading: 'Loading…', loadPy: 'Loading Python…\nThe first time takes a while', loadGame: 'Preparing the game…',
    over: 'The game is over', again: 'Play again', saved: 'Game saved.\nYou can continue any time', resume: 'Continue',
    noIso: 'This browser could not run the game.\nOpen it in a normal Safari or Chrome window.',
    crash: 'Stopped by an error', reload: 'Reload',
  },
};
let lang = 'ja';
const t = () => L[lang];

// ---------------------------------------------------------------------------
// 端末内のファイル（セーブ・スコア・言語設定）
// ---------------------------------------------------------------------------
function loadFiles() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; }
}
function saveFile(name, data) {
  const files = loadFiles();
  if (data === null) delete files[name];
  else { let s = ''; for (const b of data) s += String.fromCharCode(b); files[name] = btoa(s); }
  try { localStorage.setItem(STORE, JSON.stringify(files)); } catch (e) { console.warn(e); }
  if (name === 'rogue.cfg') readLang(files);
}
const decode = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function readLang(files) {
  try { lang = JSON.parse(new TextDecoder().decode(decode(files['rogue.cfg']))).lang === 'en' ? 'en' : 'ja'; }
  catch { lang = (navigator.language || '').startsWith('ja') ? 'ja' : 'en'; }
  buildButtons();
}

// ---------------------------------------------------------------------------
// 画面（Worker から届いた行を貯める。全角は 2 セルで右半分は null）
// 文字幅は term.py の判定（スタイルの 4096）に従う。罫線など曖昧幅の字は 1 マス
// ---------------------------------------------------------------------------
const blankRow = () => Array.from({ length: W }, () => [' ', 0]);
const grid = Array.from({ length: H }, blankRow);
function putRow(y, chars, styles) {
  const row = []; let i = 0;
  for (const c of chars) {
    if (row.length >= W) break;
    const s = styles[i++];
    row.push([c, s]);
    if (s & 4096) row.push(null);
  }
  while (row.length < W) row.push([' ', 0]);
  grid[y] = row.slice(0, W);
}
const rowText = y => grid[y].filter(Boolean).map(c => c[0]).join('');
const isMap = () => grid[H - 1].some(c => c && (c[1] & 2048 || ((c[1] >> 4) & 15) === 8));   // 状態行（白地）があれば地図の画面
function findPlayer() {
  for (let y = 1; y < H - 1; y++)
    for (let x = 0; x < W; x++) { const c = grid[y][x]; if (c && c[0] === '@' && (c[1] & 15) === 4) return [y, x]; }
  return null;
}

let view = 'follow', viewCols = 40, mode = 'map';
let rowMap = [];   // 文字だけの画面で、描く行 → ゲーム画面の行
// vx, vy は追従表示の視点。持ち物などほかの画面を開いても保つ（戻ったときに地図がずれないように）。
// ox は今描いている画面の左端の列
let cw = 8, ch = 16, cols = 40, rows = 22, vx = 0, vy = 1, ox = 0, py = 12, px = 40;
// 3D 版は小さな地図だけなので、表示の切り替え（追従・全体・大きさ）は使わない
const saveView = () => { try { localStorage.setItem('rogue-view', JSON.stringify({ view, cols: viewCols })); } catch {} };

let drawQueued = false;
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; render(); }); } }

// 日本語フォントは字ごとの小分けで届くが、キャンバスに描くだけでは取り寄せられない。
// 画面に新しい字が出たら取り寄せ、届いたら描き直す（それまでは別のフォントで描かれる）
const fontChars = new Set();
function ensureGlyphs() {
  if (!document.fonts) return;
  let fresh = '';
  for (const row of grid) for (const c of row) if (c && c[0] > '~' && !fontChars.has(c[0])) { fontChars.add(c[0]); fresh += c[0]; }
  if (fresh) Promise.all([400, 700].map(w => document.fonts.load(`${w} 16px "BIZ UDGothic"`, fresh))).then(requestDraw, () => {});
}

// メッセージを端末に打ち込むように一字ずつ出す（1 フレームに 3 字）。末尾のカーソルは入力待ちの間点滅する
let typeRaf = 0;
function typeMsg(text, from) {
  const msg = $('msg');
  cancelAnimationFrame(typeRaf);
  let n = from;
  const put = () => {
    const cur = document.createElement('span'); cur.className = 'cur'; cur.textContent = '▌';
    if (n < text.length) cur.classList.add('typing');
    msg.replaceChildren(text.slice(0, n), ...(text ? [cur] : []));
  };
  const step = () => { n = Math.min(text.length, n + 3); put(); if (n < text.length) typeRaf = requestAnimationFrame(step); };
  put();
  if (n < text.length) typeRaf = requestAnimationFrame(step);
}

function render() {
  ensureGlyphs();
  mode = isMap() ? 'map' : 'text';
  const land = innerWidth > innerHeight;
  app.className = `${land ? 'landscape' : 'portrait'} ${mode === 'text' ? 'text' : view}${fullMap ? ' fullmap' : ''}`;
  box.classList.toggle('text', mode === 'text');
  box.classList.toggle('list', mode === 'text' && hint === 'list');
  if (mode === 'text' && hint === 'list') box.scrollLeft = 0;
  $('zoomSeg').style.visibility = view === 'follow' ? '' : 'hidden';

  if (mode === 'map') {
    const msg = $('msg'), text = rowText(0).trim();
    if (msg.dataset.text !== text) {
      const prev = msg.dataset.text || '';
      msg.dataset.text = text; msg.textContent = text + (text ? '▌' : ''); msg.style.fontSize = '';
      for (let fs = parseFloat(getComputedStyle(msg).fontSize); msg.scrollHeight > msg.clientHeight + 1 && fs > 10; fs -= 1)
        msg.style.fontSize = fs - 1 + 'px';   // 2 行に収まるまで字を小さくする
      typeMsg(text, text.startsWith(prev) ? prev.length : 0);   // 続きが足されたときは足された所だけ打つ
    }
    const st = $('status'), stText = rowText(H - 1).trim();
    if (st.dataset.text !== stText) {
      st.dataset.text = stText; st.textContent = ''; st.style.fontSize = ''; st.style.gap = '';
      for (const s of stText.split(/\s{2,}/)) { const e = document.createElement('span'); e.textContent = s; st.append(e); }
      let fs = parseFloat(getComputedStyle(st).fontSize), gap = 14;
      while (st.scrollWidth > st.clientWidth + 1 && fs > 9) {   // 1 行に収まるまで間隔、次に字を詰める
        if (gap > 6) gap -= 2; else fs -= 0.5;
        st.style.gap = gap + 'px'; st.style.fontSize = fs + 'px';
      }
    }
  }

  const bw = box.clientWidth, bh = box.clientHeight;
  let y0 = 0;
  if (mode === 'text') {
    // 続く空行は 1 行に詰める（持ち物一覧の下の大きな空きなど）。rowMap[画面の行] = ゲーム画面の行
    let used = 20, blank = 0;
    rowMap = [];
    for (let y = 0; y < H; y++) {
      // 「── ↑↓ でスクロール … ──」のようなキーボード向けの案内行は出さない（下のボタン欄が同じ役目）
      if (/^\s*── .*\S.* ──\s*$/.test(rowText(y))) continue;
      let end = 0;
      grid[y].forEach((c, x) => { if (c && c[0] !== ' ') end = x + (c[1] & 4096 ? 2 : 1); });
      used = Math.max(used, end + 1);
      if (end) blank = 0; else if (++blank > 1) continue;
      rowMap.push(y);
    }
    while (rowMap.length && !rowText(rowMap[rowMap.length - 1]).trim()) rowMap.pop();
    cols = Math.min(W, used); rows = Math.max(1, rowMap.length);
    // 幅と高さの両方に収める。ただし字が小さくなりすぎるとき（1 マス 6px 未満）は収めずにスクロールさせる。
    // 短い画面で字が大きくなりすぎないよう、地図の「大」（32 桁）より大きくはしない
    // 選ぶ一覧（どれを飲む？など）は高さに収めず、字を小さくしない（行が多いと縦にスクロールする。指で選びやすく）
    // 一覧から選んだ直後の方向待ち（投げる・杖を振る）も一覧が残っているので、同じ字の大きさのままにする
    const listLike = hint === 'list' || hint === 'direction';
    cw = listLike ? Math.min(bw / cols, bw / 32) : Math.min(bw / cols, bh / (rows * RATIO), bw / 32);
    cw = Math.max(cw, 6); ox = 0;
  } else {
    const p = findPlayer(); if (p) [py, px] = p;
    if (fullMap) {
      // 全体の地図（地図をタップで切り替え）: 階全体（1〜22 行目）を 3D の画面の上に収める
      cols = W; rows = H - 2; cw = Math.min(bw / W, bh / (rows * RATIO));
      vx = 0; vy = 1;
    } else {
      // 右上の小さな地図: 自分を真ん中にして周りだけ
      cols = MINI_COLS; cw = Math.min(bw * 0.42 / cols, 190 / cols, bh * 0.45 / (MINI_ROWS * RATIO)) * 0.7;   // 横持ちでは高さで抑える。3D の画面を邪魔しないよう 7 割に（ユーザー指定）
      rows = MINI_ROWS;
      vx = Math.max(0, Math.min(W - cols, px - (cols >> 1)));
      vy = Math.max(1, Math.min(H - 1 - rows, py - (rows >> 1)));
    }
    y0 = vy; ox = vx;
    r3d.update(grid, p);
  }
  ch = cw * RATIO;
  if (mode === 'text' && (hint === 'list' || hint === 'direction')) ch = Math.max(ch, LIST_ROW);   // 一覧の行は指で押せる高さに（字の大きさは変えず行の間を空ける）
  const dpr = devicePixelRatio || 1;
  const wpx = Math.floor(cols * cw), hpx = Math.floor(rows * ch);
  if (cv.width !== Math.floor(wpx * dpr) || cv.height !== Math.floor(hpx * dpr)) {
    cv.style.width = wpx + 'px'; cv.style.height = hpx + 'px';
    cv.width = Math.floor(wpx * dpr); cv.height = Math.floor(hpx * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawCells(mode === 'text' ? rowMap : Array.from({ length: rows }, (_, r) => y0 + r));
  if (mode === 'map') drawFacing();
  updateMoreHints();
}

const MINI_COLS = 23, MINI_ROWS = 11;
// 小さな地図に出さない字: モンスター（大文字）とアイテム。3D の画面で前を見ないと分からない（全体の地図には出す）
const HIDE_ON_MINI = /^[A-Z!?)\]=\/:*,]$/;
let fullMap = false;   // 地図をタップすると、階全体の地図と小さな地図を切り替える
// 小さな地図の @ に、向いている方向の印を付ける
function drawFacing() {
  const p = findPlayer(); if (!p) return;
  const [dy, dx] = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]][r3d.getFacing()];
  const cx = (p[1] - ox + 0.5) * cw, cy = (p[0] - vy + 0.5) * ch;
  const len = Math.max(cw, ch * 0.5) * 1.1, ang = Math.atan2(dy * ch / ch, dx);
  ctx.save(); ctx.translate(cx + dx * len, cy + dy * len); ctx.rotate(ang);
  ctx.fillStyle = '#f0c652';
  const a = cw * 0.9;
  ctx.beginPath(); ctx.moveTo(a, 0); ctx.lineTo(-a * 0.6, a * 0.7); ctx.lineTo(-a * 0.6, -a * 0.7); ctx.closePath(); ctx.fill();
  ctx.restore();
}
function turnView(d) { r3d.turn(d); requestDraw(); }

// 文字だけの画面が収まらず、まだ見ていない続きがあるとき、その側に印を出す
function updateMoreHints() {
  const text = mode === 'text';
  $('moreRight').hidden = !(text && box.scrollLeft + box.clientWidth < box.scrollWidth - 2);
  // 一覧に次のページがある間（「(↓ 続き)」が出ている）も、下端まで来たあと出したままにする
  $('moreDown').hidden = !(text && (box.scrollTop + box.clientHeight < box.scrollHeight - 2 || hint === 'list' && /↓/.test(rowText(21))));
}
box.addEventListener('scroll', updateMoreHints, { passive: true });
tap($('moreDown'), () => { if (hint === 'list') pageList(1); else { box.scrollTop += box.clientHeight * 0.8; updateMoreHints(); } });
tap($('moreRight'), () => { box.scrollLeft += box.clientWidth * 0.8; updateMoreHints(); });

// @ が表示の端から 1/4 以内に来たら視点をずらす（地図は 1〜22 行目）
function follow() {
  const mx = Math.floor(cols / 4), my = Math.floor(rows / 4);
  if (px < vx + mx) vx = px - mx;
  if (px >= vx + cols - mx) vx = px - cols + mx + 1;
  if (py < vy + my) vy = py - my;
  if (py >= vy + rows - my) vy = py - rows + my + 1;
  vx = Math.max(0, Math.min(W - cols, vx));
  vy = Math.max(1, Math.min(H - 1 - rows, vy));
}

function drawCells(lines) {   // lines[画面の行] = ゲーム画面の行
  // 地図は 3D の画面に重ねるので地を塗らず透かす（背景は CSS の半透明の色だけ）。文字の画面は塗りつぶす
  if (mode === 'text') { ctx.fillStyle = DEFAULT_BG; ctx.fillRect(0, 0, cols * cw, rows * ch); }
  else ctx.clearRect(0, 0, cols * cw, rows * ch);
  ctx.textBaseline = 'middle';
  const size = Math.round(cw * 1.9);
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-term');
  for (let r = 0; r < rows; r++) {
    const row = grid[lines[r]]; if (!row) continue;
    for (let c = 0; c < cols; c++) {
      const cell = row[ox + c]; if (!cell) continue;
      let [g, s] = cell; const w = s & 4096 ? 2 : 1;
      if (mode === 'map' && g !== '@' && !(s & 2048) && lines[r] >= 1 && lines[r] <= 22 && !r3d.isSeen(lines[r], ox + c)) continue;   // 3D の画面に映った所だけ
      if (mode === 'map' && !fullMap && !(s & 2048) && HIDE_ON_MINI.test(g)) {   // 探知で出た字（反転）は小さな地図にも出す   // 小さな地図には地形だけ。物の下は周りから床か通路かを決める
        const ns = [lines[r] - 1, lines[r] + 1].map(y => (grid[y] && grid[y][ox + c] || [' '])[0]).concat([row[ox + c - 1], row[ox + c + 1]].map(n => (n || [' '])[0]));
        g = ns.includes('#') && !ns.includes('.') ? '#' : '.'; s = 0;
      }
      let fg = (s & 15) ? PALETTE[(s & 15) - 1] : null, bg = ((s >> 4) & 15) ? PALETTE[((s >> 4) & 15) - 1] : null;
      if (s & 2048) [fg, bg] = [bg || DEFAULT_BG, fg || DEFAULT_FG];
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(c * cw, r * ch, cw * w + 0.5, ch + 0.5); }
      if (g === ' ') continue;
      ctx.font = `${s & 256 ? 700 : 400} ${size}px ${family}`;
      ctx.fillStyle = fg || DEFAULT_FG;
      ctx.globalAlpha = s & 512 ? 0.6 : 1;
      // 罫線やブロック（█ ═ ┌ など）は Python では半角 1 マスだが、フォントでは全角幅のことがある。マスの幅に縮めて描く
      const mw = ctx.measureText(g).width, cellW = w * cw, ty = r * ch + ch / 2 + cw * 0.08;
      if (mw > cellW * 1.05) {
        ctx.save(); ctx.translate(c * cw, 0); ctx.scale(cellW / mw, 1); ctx.fillText(g, 0, ty); ctx.restore();
      } else {
        ctx.fillText(g, c * cw + (cellW - mw) / 2, ty);
      }
      if (s & 1024) ctx.fillRect(c * cw, r * ch + ch - 2, cw * w, 1);
      ctx.globalAlpha = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// キー（SharedArrayBuffer のリングバッファで Worker に渡す）
// ---------------------------------------------------------------------------
let keys = null;
let waiting = false;   // ゲームが入力を待っていて、まだ何も送っていない
function send(...codes) {
  if (!keys) return;
  waiting = false;
  for (const k of codes) {
    const code = typeof k === 'number' ? k : k.codePointAt(0);
    const w = Atomics.load(keys, 0);
    if (w - keys[1] >= KEYQ) return;
    keys[2 + (w % KEYQ)] = code;
    Atomics.store(keys, 0, w + 1);
  }
  Atomics.notify(keys, 0);
}
const keyCode = k => k === '^P' ? 16 : k;
// ボタンの答えは、ゲームが今の質問で待っているときだけ送る。素早い二度押しで、次の質問の答えや
// コマンドとして使われないように（「飲む」直後の「食べる」の e が「どれを飲む？」の答えになる、など）
function answer(...codes) { if (waiting) send(...codes); }

// ---------------------------------------------------------------------------
// ボタン
// ---------------------------------------------------------------------------
// 十字キーは向きに対して: 斜め前・前・斜め前 / 左を向く・休む・右を向く / 左へ・後ろへ・右へ。
// 数字は向いている方向から右回りに数えた 8 方向（0 = 前）。turn は向きを変えるだけでターンを使わない
const DPAD = [[7, '↖'], [0, '↑'], [1, '↗'], ['turnL', '↶'], ['.', ''], ['turnR', '↷'], [6, '←'], [4, '↓'], [2, '→']];
const dirKey = k => typeof k === 'number' ? r3d.keyFor(k) : k;
let hint = 'any', valid = '';

// iOS Safari は長押しで拡大鏡を出すので、画面以外の touchstart を止める（下の preventTouch）。
// そうすると click が来なくなるため、ボタンは「押して、ボタンの上で離した」ときに動かす。
function tap(el, fn) {
  let down = false;
  el.addEventListener('pointerdown', () => { down = true; });
  el.addEventListener('pointerleave', () => { down = false; });
  el.addEventListener('pointercancel', () => { down = false; });
  el.addEventListener('pointerup', e => { if (down) { down = false; fn(e); } });
  el.addEventListener('click', e => { if (e.detail === 0) fn(e); });   // キーボードで押したとき
}

function makeKey(label, sub, parent, cls) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'key' + (cls ? ' ' + cls : '');
  const bl = document.createElement('b'); bl.textContent = label; b.append(bl);
  if ([...label].length >= 7 && /[^ -]/.test(label)) bl.className = 'long';   // 「回復するまで休む」など長い名前は字を詰めて収める
  if (sub) { const i = document.createElement('i'); i.textContent = sub; b.append(i); }
  parent.append(b); return b;
}

// セーブの書き出し・読み込み。iPhone のホーム画面のアプリは Safari と別の保存場所を持ち、アイコンを消すとセーブも消えるので、
// 外に持ち出せるようにする。書き出すのは端末に保存してあるもの（最後に「保存して終了」した所）と記録・設定
const SAVE_HEAD = 'ROGUE3D-SAVE 1';
async function exportSave() {
  const files = loadFiles();
  if (!files['rogue.sav']) { alert(t().noSave); return; }
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  const name = `rogue3d-save-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  const file = new File([SAVE_HEAD + '\n' + btoa(JSON.stringify(files)) + '\n'], name, { type: 'text/plain' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {   // iPhone: 共有の画面（「ファイル」に保存・メモに送る など）
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function importSave() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,text/plain';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    let files = null;
    try {
      const [head, body] = (await f.text()).split(/\r?\n/);
      if (head.trim() === SAVE_HEAD) files = JSON.parse(atob(body.trim()));
    } catch { files = null; }
    if (!files || typeof files !== 'object' || !files['rogue.sav']) { alert(t().badSave); return; }
    if (!confirm(t().askImport)) return;
    try { localStorage.setItem(STORE, JSON.stringify(files)); } catch (e) { alert(String(e)); return; }
    location.reload();   // 読み込み直すと、ゲームはこのセーブから始まる
  });
  inp.click();
}

function buildButtons() {
  const T = t();
  $('vFollow').textContent = T.follow; $('vFull').textContent = T.full;
  [...$('zoomSeg').children].forEach((b, i) => { b.textContent = [T.small, T.mid, T.large][i]; });

  const dp = $('dpad'); dp.textContent = '';
  for (const [k, arrow] of DPAD) {
    const rest = k === '.';
    const b = makeKey(rest ? T.rest : arrow, rest ? '.' : '', dp, rest ? 'rest' : (typeof k === 'string' ? 'turn' : ''));
    if (rest) restKey = b;
    b.setAttribute('aria-label', rest ? T.rest : k);
    let timer = 0;
    // 長押し: 押している間 1 歩ずつ歩き続ける（休むも同じ）。前の 1 歩をゲームが受け取ってから次を送るので、
    // 離せばすぐ止まる。メッセージの「次へ」待ちなどになったら止まる
    const repeat = () => {
      debug(`repeat ${k} hint=${hint} queued=${Atomics.load(keys, 0) - keys[1]}`);
      if (hint === 'command' && Atomics.load(keys, 0) === keys[1]) send(dirKey(k));
      timer = setTimeout(repeat, 110);
    };
    const press = () => {
      b.classList.add('on'); clearTimeout(timer);
      if (k === 'turnL' || k === 'turnR') { turnView(k === 'turnL' ? -1 : 1); return; }
      if (hint === 'direction') { answer(rest ? 27 : dirKey(k)); return; }
      if (hint !== 'command') return;
      send(dirKey(k));
      timer = setTimeout(repeat, 300);
    };
    const release = () => { b.classList.remove('on'); clearTimeout(timer); };
    // 指はタッチイベントで扱う（iOS ではこれがいちばん確実）。マウス・ペンはポインターイベント
    b.addEventListener('touchstart', e => { e.preventDefault(); debug(`touchstart ${k} hint=${hint}`); press(); }, { passive: false });
    b.addEventListener('touchend', e => { e.preventDefault(); debug(`touchend ${k}`); release(); }, { passive: false });
    b.addEventListener('touchcancel', () => { debug(`touchcancel ${k}`); release(); });
    b.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch {}   // 少しずれても離すまで押したまま
      press();
    });
    b.addEventListener('pointerup', e => { if (e.pointerType !== 'touch') release(); });
    b.addEventListener('pointercancel', e => { debug(`pointercancel ${e.pointerType} ${k}`); if (e.pointerType !== 'touch') release(); });
    b.addEventListener('contextmenu', e => e.preventDefault());
  }

  const acts = $('acts'); acts.textContent = '';
  for (const [k, label] of T.acts) {
    const b = makeKey(label, k === 'more' ? '…' : k, acts);
    tap(b, () => { if (k === 'more') $('more').hidden = false; else if (hint === 'command') answer(k); });
  }
  const mg = $('moreGrid'); mg.textContent = '';
  for (const [k, label] of T.more) {
    const b = makeKey(label, ['manual', 'export', 'import'].includes(k) ? '' : k, mg);
    tap(b, () => {
      $('more').hidden = true;
      if (k === 'manual') openManual();
      else if (k === 'export') exportSave();
      else if (k === 'import') importSave();
      else if (hint === 'command') answer(keyCode(k));
    });
  }
  $('moreTitle').textContent = T.moreTitle; $('moreClose').textContent = T.close;
  updateControls();
}

// ゲームが待っている入力に合わせて右側（横持ちでは右列）を切り替える
let restKey = null;
function updateControls() {
  const T = t(), c = $('ctx');
  const th = $('tapHint'); th.textContent = T.tapAnywhere; th.classList.toggle('on', hint === 'more' || hint === 'any');
  if (restKey) {   // 十字キーの真ん中: ふだんは「休む」、方向を聞かれている間は「やめる」
    const dir = hint === 'direction';
    restKey.querySelector('b').textContent = dir ? T.cancel : T.rest;
    restKey.querySelector('i').textContent = dir ? 'ESC' : '.';
  }
  const cmd = hint === 'command';
  $('acts').hidden = !cmd;
  c.hidden = cmd;
  $('dpad').classList.toggle('off', !(cmd || hint === 'direction'));
  if (!cmd) $('more').hidden = true;
  if (cmd) return;

  const keep = (hint === 'name' || hint === 'text') ? ($('txt')?.value || '') : '';   // 言語の切り替えで作り直しても入力を残す
  c.textContent = '';
  const note = s => { const p = document.createElement('div'); p.className = 'hint'; p.textContent = s; c.append(p); };
  const row = () => { const r = document.createElement('div'); r.className = 'row'; c.append(r); return r; };
  const btn = (label, sub, parent, fn, cls) => { const b = makeKey(label, sub, parent, cls); tap(b, fn); return b; };

  if (hint === 'direction') {
    note(T.dir);
    btn(T.cancel, 'ESC', row(), () => answer(27));
  } else if (hint === 'char' && valid) {
    const r = row();
    for (const k of valid) btn(T.char[k] || k, k, r, () => answer(k));
    btn(T.cancel, 'ESC', row(), () => answer(27));
  } else if (hint === 'list') {
    // 持ち物が多くて 1 画面に収まらないときは ↑↓ で前後のページを出す
    note(T.list + (/↓/.test(rowText(21)) ? T.listMore : ''));
    const r = row();
    btn('↑', '', r, () => pageList(-1)); btn('↓', '', r, () => pageList(1));
    btn(T.cancel, 'ESC', row(), () => answer(27));
  } else if (hint === 'text' || hint === 'name' || hint === 'char') {
    textEntry(c, T, keep);
  } else {
    // ボタンは置かない（画面のどこをタップしても進む。案内はメッセージの下の #tapHint）
  }
}

// 一覧の ↑↓: 行が高いので一覧は画面の中でスクロールする。まず画面の中を送り、端まで来ていたらゲームに前後のページを頼む
// （新しいページは、↓ なら末尾・↑ なら先頭が見えるように合わせる）
let pageEnd = 0;
function pageList(dir) {
  // 端かどうかは実際に動いたかで見る（iPhone では scrollHeight からの計算が端でもぴったりにならない）
  const before = box.scrollTop;
  box.scrollTop = before + dir * Math.max(60, box.clientHeight * 0.8);
  updateMoreHints();
  if (Math.abs(box.scrollTop - before) >= 2) return;
  if (!waiting) return;
  pageEnd = dir;
  answer(dir > 0 ? KEY.NPAGE : KEY.PPAGE);
}

function textEntry(c, T, keep) {
  const name = hint === 'name';
  const f = document.createElement('form'); f.className = 'ctx';
  const inp = document.createElement('input');
  inp.id = 'txt'; inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false;
  inp.enterKeyHint = 'done';
  inp.placeholder = name ? T.name : T.text;
  if (name) inp.maxLength = 23;
  if (hint === 'char') inp.maxLength = 1;
  inp.value = keep;
  // iOS はキーボードを閉じた後、ページが上にずれたまま残ることがあるので戻す
  inp.addEventListener('blur', () => setTimeout(() => window.scrollTo(0, 0), 50));
  f.append(inp);
  const r = document.createElement('div'); r.className = 'row'; f.append(r);
  const ok = makeKey(T.ok, '↵', r);   // submit にすると tap と既定の送信で 2 回送られる。Enter キーは入力欄 1 つのフォームなので送信される
  tap(ok, () => f.requestSubmit());
  if (name) tap(makeKey(T.lang, 'Tab', r), () => answer(9));
  else tap(makeKey(T.cancel, 'ESC', r), () => answer(27));
  f.addEventListener('submit', e => {
    e.preventDefault();
    let s = inp.value;
    if (name) s = [...s].filter(ch => ch >= ' ' && ch !== '\x7f').join('').slice(0, 23);
    if (!waiting) return;
    if (hint === 'char') { if (s) send(s[0]); return; }
    send(...s, 13);
    inp.blur();
  });
  c.append(f);
}

tap(cv, () => {
  if (mode !== 'map') return;
  fullMap = !fullMap; app.classList.toggle('fullmap', fullMap); requestDraw();
});

// 画面のタップ: 「次へ」待ちなら進める、一覧なら行の記号を選ぶ
cv.addEventListener('click', e => {
  if (hint !== 'list') return;
  const y = rowMap[Math.floor(e.offsetY / ch)];
  if (y === undefined) return;
  // 「(↑ 続き)」「(↓ 続き)」の字を押したら、そのページへ送る（両方あるときは押した所に近いほう）
  const line = rowText(y), up = line.indexOf('↑'), down = line.indexOf('↓');
  if (up >= 0 || down >= 0) {
    const col = Math.floor(e.offsetX / cw);
    pageList(down < 0 || up >= 0 && Math.abs(col - up) < Math.abs(col - down) ? -1 : 1);
    return;
  }
  const m = line.match(/^\s*(\S)\)/);
  if (!m || !valid.includes(m[1]) || !waiting) return;
  // 押した行を一瞬光らせてから答える（どれを選んだか目で分かるように）
  const r = Math.floor(e.offsetY / ch);
  ctx.fillStyle = 'rgba(240,198,82,0.28)'; ctx.fillRect(0, r * ch, cols * cw, ch);
  waiting = false;
  setTimeout(() => send(m[1]), 110);
});
// 3D の画面を左右にスワイプして向きを変える（90 度）。景色を指でつかんで回す向き: 左へ払うと右を向く。
// 地図（#cv）の上から始めたときは地図のタップなので回さない
let swipe = null;
box.addEventListener('pointerdown', e => {
  swipe = mode === 'map' && !e.target.closest('#cv') ? { x: e.clientX, y: e.clientY } : null;
});
box.addEventListener('pointerup', e => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y; swipe = null;
  if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  if (hint === 'command' || hint === 'direction') turnView(dx < 0 ? 2 : -2);
});
box.addEventListener('pointercancel', () => { swipe = null; });
// 「次へ」待ちの間は、画面のどこをタップしても次へ進む（十字キーや行動ボタンの上でも）。
// 読み飛ばしを防ぐため、待ちになってから 0.3 秒以内に指を置いたタップは数えない
// （歩くつもりの連打や、長押しで歩いていて離した指では進まない）。上の設定ボタンは除く
let moreSince = 0, downAt = 0;
const advancing = () => hint === 'more' || hint === 'any';
document.addEventListener('pointerdown', () => { downAt = performance.now(); }, true);
document.addEventListener('pointerup', e => {
  if (!advancing() || e.target.closest('.bar, #ver')) return;
  if (downAt - moreSince < 300) return;
  answer(32);
}, true);
cv.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('touchstart', e => {   // preventTouch: 入力欄と画面（スクロールする）以外
  if (!e.target.closest('#txt, #screenBox, #manualBody')) e.preventDefault();
}, { passive: false });

// パソコンのキーボードでも遊べるように
addEventListener('keydown', e => {
  if (document.activeElement && document.activeElement.id === 'txt') return;
  if (!$('manual').hidden) { if (e.key === 'Escape') $('manual').hidden = true; return; }   // 説明書を開いている間はゲームに送らない
  const named = { Enter: 13, Escape: 27, Backspace: 8, Tab: 9, ArrowUp: KEY.UP, ArrowDown: KEY.DOWN, ArrowLeft: KEY.LEFT, ArrowRight: KEY.RIGHT, PageUp: KEY.PPAGE, PageDown: KEY.NPAGE };
  if ((hint === 'command' || hint === 'direction') && e.key.startsWith('Arrow')) {   // 矢印: ←→ で向きを変え、↑↓ で前後へ
    e.preventDefault();
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') turnView(e.key === 'ArrowLeft' ? -1 : 1);
    else if (hint === 'command') send(r3d.keyFor(e.key === 'ArrowUp' ? 0 : 4));
    else answer(r3d.keyFor(e.key === 'ArrowUp' ? 0 : 4));
    return;
  }
  let code = named[e.key];
  if (code === undefined && e.ctrlKey && e.key.length === 1) code = e.key.toUpperCase().charCodeAt(0) - 64;
  else if (code === undefined && e.key.length === 1 && !e.metaKey) code = e.key;
  if (code === undefined) return;
  e.preventDefault(); send(code);
});

function setView(v) {
  view = v; saveView();
  $('vFollow').setAttribute('aria-pressed', v === 'follow'); $('vFull').setAttribute('aria-pressed', v === 'full');
  render();
}
tap($('vFollow'), () => setView('follow'));
tap($('vFull'), () => setView('full'));
[...$('zoomSeg').children].forEach(b => tap(b, () => {
  viewCols = +b.dataset.cols; saveView();
  [...$('zoomSeg').children].forEach(o => o.setAttribute('aria-pressed', o === b));
  render();
}));
[...$('zoomSeg').children].forEach(o => o.setAttribute('aria-pressed', +o.dataset.cols === viewCols));
setView(view);
$('ver').textContent = 'v' + VERSION;

// 落ちた跡を残す。iPhone の Safari はタブが落ちると黙って読み込み直すので、画面を見ている間に止まったら、次に開いたとき前回の様子を上に出す
const ALIVE = 'rogue3d-alive';
const lastRun = (() => { try { const o = JSON.parse(localStorage.getItem(ALIVE) || 'null'); return o && !o.clean ? o : null; } catch { return null; } })();
const alive = { v: VERSION, t0: Date.now(), beat: Date.now(), err: '', clean: false, last: [] };   // last: 止まる直前の出来事（演出の種類など）
const saveAlive = () => { try { localStorage.setItem(ALIVE, JSON.stringify(alive)); } catch {} };
saveAlive();
setInterval(() => { alive.beat = Date.now(); saveAlive(); }, 5000);
addEventListener('pagehide', () => { alive.clean = true; saveAlive(); });
document.addEventListener('visibilitychange', () => { alive.clean = document.hidden; alive.beat = Date.now(); saveAlive(); });   // 裏に回っている間に閉じられたのは落ちたのではない
addEventListener('error', e => { alive.err = String(e.message).slice(0, 120); saveAlive(); });
addEventListener('unhandledrejection', e => { alive.err = String(e.reason).slice(0, 120); saveAlive(); });
if (lastRun) {
  const min = Math.round((lastRun.beat - lastRun.t0) / 60000), el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:99;padding:8px 10px;background:#2a1c14;color:#f0d0b0;border:1px solid #6a4a30;border-radius:6px;font:13px/1.5 sans-serif';
  el.textContent = (lang === 'ja' ? `前回は画面が途中で止まりました（v${lastRun.v}・開いてから約${min}分）` : `The page stopped last time (v${lastRun.v}, about ${min} min after opening)`) + (lastRun.err ? '\n' + lastRun.err : '') + (lastRun.last && lastRun.last.length ? '\n' + (lang === 'ja' ? '直前: ' : 'Last: ') + lastRun.last.join(' ') : '') + (lastRun.mem ? `\nPython: ${lastRun.mem0}MB → ${lastRun.mem}MB` : '');
  el.style.whiteSpace = 'pre-wrap';
  document.body.appendChild(el);
  tap(el, () => el.remove());
  setTimeout(() => el.remove(), 20000);
}

// 新しい版が出ていたら版番号の所に知らせる（iPhone はページを開いたまま保つので、自分では読み込み直さない）。
// 遊んでいる途中で勝手に読み込み直すと保存していない冒険が消えるので、押されたときだけ読み込み直す
async function checkUpdate() {
  try {
    const src = await (await fetch('app.js', { cache: 'no-store' })).text();
    const m = src.match(/const VERSION = '([^']+)'/);
    if (!m || m[1] === VERSION) return;
    const v = $('ver');
    v.textContent = lang === 'ja' ? '新しい版があります ↻' : 'Update available ↻';
    v.classList.add('update');
  } catch {}
}
tap($('ver'), () => { if ($('ver').classList.contains('update')) location.reload(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
setInterval(checkUpdate, 10 * 60 * 1000);
tap($('moreClose'), () => { $('more').hidden = true; });

// ---------------------------------------------------------------------------
// 説明書（exe 版と同じ manual.txt を読み込んで、スマホの幅で読めるように組む）
// ---------------------------------------------------------------------------
let manualLoaded = false;
async function openManual() {
  $('manual').hidden = false;
  $('manualClose').textContent = t().close;
  $('manualTop').textContent = lang === 'ja' ? '↑ 目次へ' : '↑ Contents';
  if (manualLoaded) return;
  const body = $('manualBody');
  body.textContent = t().loading;
  try {
    const r = await fetch('../manual.txt', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    buildManual(body, await r.text());
    manualLoaded = true;
  } catch (e) { body.textContent = String(e); }
}
// 見た目の桁数（全角 = 2）
const textCols = s => [...s].reduce((n, c) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(c) ? 2 : 1), 0);
function buildManual(body, text) {
  body.textContent = '';
  const add = (tag, cls, s) => { const el = document.createElement(tag); if (cls) el.className = cls; if (s != null) el.textContent = s; body.append(el); return el; };
  const lines = text.replace(/\r/g, '').split('\n');
  const isRule = l => /^\s*[=─-]{8,}\s*$/.test(l);
  const isBox = l => /^\s*[┌│└]/.test(l);
  // 4 列以上ある行か、深く字下げした続きの行（表の右端の列）
  const isTable = l => (l.trim().match(/\S {2,}(?=\S)/g) || []).length >= 3 || (l.trim() && l.match(/^ */)[0].length >= 30);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // ===== で挟まれた 1〜3 行は見出し
    if (/^=+$/.test(l.trim())) {
      let j = i + 1;
      while (j < lines.length && j - i <= 4 && !/^=+$/.test(lines[j].trim())) j++;
      if (j < lines.length && j - i <= 4 && j > i + 1) {
        add('h2', '', lines.slice(i + 1, j).map(s => s.trim()).filter(Boolean).join('\n'));
        i = j;
      }
      continue;
    }
    // 段落の頭で、図や列の多い表（モンスター図鑑など）なら段落ごと崩さずに出し、横にスクロールして見る。
    // 狭い幅で折り返すと、右の列が数文字ずつの縦読みになるため
    const prev = i ? lines[i - 1].trim() : '';
    if (l.trim() && (!prev || /^=+$/.test(prev))) {
      let j = i;
      while (j < lines.length && lines[j].trim() && !/^=+$/.test(lines[j].trim())) j++;
      const para = lines.slice(i, j);
      if (para.some(s => isBox(s) || isTable(s))) {
        const n = Math.min(...para.map(s => s.match(/^ */)[0].length));
        add('pre', 'wide', para.map(s => s.slice(n)).join('\n'));
        i = j - 1;
        continue;
      }
    }
    if (isRule(l)) { add('hr'); continue; }
    if (!l.trim()) { add('div', 'gap'); continue; }
    const ind = l.match(/^ */)[0].length;
    const d = add('div', 'ln', l.slice(ind));
    // 折り返した行の字下げ（半角 2 文字 = 1em）。「名前    説明」の表の行は、説明の列に揃えて折り返す
    const m = l.slice(ind).match(/^(\S.*?\S|\S) {2,}(?=\S)/);
    const hang = m && textCols(m[0]) <= 40 ? textCols(m[0]) : 0;
    // 深い字下げは画面の半分までに抑える（はみ出すとスクロールのたびに左右にぶれる）
    const pad = `min(${(ind + hang) / 2}em, 45vw)`;
    d.style.paddingLeft = pad;
    if (hang) d.style.textIndent = `max(${-hang / 2}em, calc(${ind / 2}em - ${pad}))`;
  }
  // 目次の「1. はじめに」などをタップすると、その章の見出しへ飛ぶ
  const heads = [...body.querySelectorAll('h2')];
  for (const d of body.querySelectorAll('.ln')) {
    if (heads[1] && !(d.compareDocumentPosition(heads[1]) & Node.DOCUMENT_POSITION_FOLLOWING)) break;   // 目次は最初の章より前だけ
    const m = d.textContent.match(/^(\d+)\.\s/);
    const h = m && heads.find(h => h.textContent.startsWith(m[1] + '.'));
    if (!h) continue;
    d.classList.add('toc');
    d.addEventListener('click', () => body.scrollTo({ top: h.offsetTop - body.offsetTop - 8, behavior: 'smooth' }));
  }
}
$('manualBody').addEventListener('scroll', e => { $('manualTop').hidden = e.target.scrollTop < 400; }, { passive: true });
tap($('manualTop'), () => $('manualBody').scrollTo({ top: 0, behavior: 'smooth' }));
tap($('manualClose'), () => { $('manual').hidden = true; });
addEventListener('resize', () => { $('status').dataset.text = ''; $('msg').dataset.text = ' '; requestDraw(); });   // 幅が変わったら詰め直す

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
// ゲーム本体のソース（この世界を作っているコード）。読み込み画面・階の生成・死んだときの表示で、端末の出力のように見せる
const SOURCE_FILES = ['main.py', 'game.py', 'dungeon.py', 'monsters.py', 'player.py', 'items.py', 'combat.py', 'ui.py', 'term.py'];
const sources = {};   // ファイル名 → 行の配列
(async () => {
  for (const f of SOURCE_FILES) {
    try { sources[f] = (await (await fetch('../' + f)).text()).split('\n'); } catch { /* 読めなくてもゲームは続ける */ }
  }
})();
// 演出に出すのは英数字だけ（ユーザー指定）。日本語のコメントは削り、それでも日本語が残る行（説明文など）は null で飛ばす
function asciiLine(l) {
  if (!/[^\x00-\x7f]/.test(l)) return l;
  const cm = l.indexOf('#');
  if (cm >= 0 && !/[^\x00-\x7f]/.test(l.slice(0, cm)) && /\w/.test(l.slice(0, cm))) return l.slice(0, cm).replace(/\s+$/, '');   // 削って記号だけ残る行も飛ばす
  return null;
}
const CODE_KW = /\b(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|self|None|True|False|try|except|with|lambda|yield|break|continue|pass)\b/g;
const CODE_FONT = 'ui-monospace, Menlo, Consolas, monospace';

// コードの 1 行を色分けして描く（命令の言葉は琥珀、コメントは灰色、ほかは白）。a は濃さ
function paintCode(ctx, line, x, y, a) {
  const t = line.replace(/\t/g, '    ');
  const cm = t.indexOf('#'), body = cm >= 0 && !/['"]/.test(t.slice(0, cm)) ? t.slice(0, cm) : t;
  ctx.fillStyle = `rgba(200,204,209,${a})`; ctx.fillText(body, x, y);
  ctx.fillStyle = `rgba(240,198,82,${a})`;
  for (const m of body.matchAll(CODE_KW)) ctx.fillText(m[0], x + ctx.measureText(body.slice(0, m.index)).width, y);
  if (body !== t) { ctx.fillStyle = `rgba(125,134,144,${a * 0.8})`; ctx.fillText(t.slice(cm), x + ctx.measureText(body).width, y); }
}

// 読み込みの間、ソースを流す
const rain = (() => {
  const cfg = { size: 11, rate: 60 };   // 字の大きさ・1 秒に流す行数（試験用に window.__rain から変えられる）
  const cv = $('codeRain'), ctx = cv.getContext('2d');
  let src = [], out = [], at = 0, acc = 0, last = 0, hold = 0, raf = 0, fed = 0;
  function feed() {   // 読めたファイルから順に流す行を並べる
    const n = Object.keys(sources).length;
    if (n === fed) return;
    fed = n; src = [];
    for (const f of SOURCE_FILES) if (sources[f]) src.push({ t: `$ python -c "import ${f.replace('.py', '')}"`, cmd: 1 }, ...sources[f].map(asciiLine).filter(t => t !== null).map(t => ({ t })));
  }
  function step(now) {
    raf = requestAnimationFrame(step);
    const dt = Math.min(0.1, (now - (last || now)) / 1000); last = now;
    feed();
    if (hold > 0) hold -= dt;
    else if (src.length) {
      acc += dt * cfg.rate * (0.6 + 0.8 * Math.random());
      while (acc >= 1 && hold <= 0) {
        acc -= 1;
        const l = src[at++ % src.length];
        out.push(l); if (out.length > 400) out.splice(0, 200);
        if (l.cmd) hold = 0.35;                                   // コマンドの後は一呼吸
        else if (/^(def |class )/.test(l.t) && Math.random() < 0.3) hold = 0.08 + 0.2 * Math.random();
      }
    }
    draw();
  }
  function draw() {
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lh = Math.round(cfg.size * 1.3), rows = Math.floor((h - 8) / lh), from = Math.max(0, out.length - rows);
    ctx.font = `${cfg.size}px ${CODE_FONT}`; ctx.textBaseline = 'top';
    for (let i = from; i < out.length; i++) {
      const l = out[i], y = 4 + (i - from) * lh, age = out.length - 1 - i;
      const a = age === 0 ? 0.95 : 0.22 + 0.3 * Math.max(0, 1 - age / 12);
      if (l.cmd) { ctx.fillStyle = `rgba(240,198,82,${a + 0.2})`; ctx.fillText(l.t, 8, y); }
      else paintCode(ctx, l.t, 8, y, a);
    }
    // 真ん中の題字の所は暗く沈める
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.45);
    g.addColorStop(0, 'rgba(11,13,15,0.92)'); g.addColorStop(0.45, 'rgba(11,13,15,0.7)'); g.addColorStop(1, 'rgba(11,13,15,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  return {
    cfg,
    start() { if (!raf) { last = 0; raf = requestAnimationFrame(step); } },
    stop() { cancelAnimationFrame(raf); raf = 0; cv.width = cv.height = 0; },   // 大きなキャンバスは手放す（iPhone はメモリが厳しい）
  };
})();
window.__rain = rain;

// 画面の上に重ねる端末の出力（新しい階を作るとき・死んだとき）。
// 行は { t: 文字, at: 出る時刻 ms, kind: 'cmd' | 'code' | 'out' | 'ok' | 'err', type: 1 なら一字ずつ打つ }。
// ms たったら薄れて消え、下のゲーム画面が現れる
const termFx = (() => {
  const cv = $('termFx'), ctx = cv.getContext('2d');
  let lines = [], t0 = 0, until = 0, raf = 0, fading = 0;
  const COL = { cmd: '240,198,82', out: '200,204,209', ok: '127,209,122', err: '255,106,92' };
  function show(list, ms) {
    const r = box.getBoundingClientRect();
    Object.assign(cv.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', transition: 'none', opacity: 1 });
    cv.hidden = false; clearTimeout(fading);
    lines = list; t0 = performance.now(); until = t0 + ms;
    if (!raf) raf = requestAnimationFrame(step);
  }
  function step(now) {
    draw(now - t0, now);
    if (now < until) { raf = requestAnimationFrame(step); return; }
    raf = 0;
    cv.style.transition = 'opacity .35s'; cv.style.opacity = 0;
    fading = setTimeout(() => { cv.hidden = true; cv.width = cv.height = 0; }, 400);
  }
  function draw(el, now) {
    const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0d0f'; ctx.fillRect(0, 0, w, h);
    const size = w < 360 ? 10 : 11, lh = Math.round(size * 1.35), x0 = 8;
    ctx.font = `${size}px ${CODE_FONT}`; ctx.textBaseline = 'top';
    const vis = lines.filter(l => l.at <= el);
    const rows = Math.floor((h - 8) / lh), from = Math.max(0, vis.length - rows);
    let cx = x0, cy = 4;
    for (let i = from; i < vis.length; i++) {
      const l = vis[i], y = 4 + (i - from) * lh;
      const t = l.type ? l.t.slice(0, Math.floor((el - l.at) / 18)) : l.t;   // 一字ずつ打つ行は 1 字 18ms
      if (l.kind === 'code') paintCode(ctx, t, x0, y, 0.55);
      else { ctx.fillStyle = `rgba(${COL[l.kind] || COL.out},0.95)`; ctx.fillText(t, x0, y); }
      cx = x0 + ctx.measureText(t).width; cy = y;
    }
    if (Math.floor(now / 400) % 2 === 0) { ctx.fillStyle = 'rgba(240,198,82,0.9)'; ctx.fillRect(cx + 1, cy, size * 0.6, size * 1.1); }   // カーソル
  }

  // ソースの中で needle を含む行を探し、Python のエラー表示の 1 段（File "…", line N, in 関数）にする
  function frame(file, needle, after) {
    const src = sources[file]; if (!src) return [];
    const start = after ? Math.max(0, src.findIndex(l => l.includes(after))) : 0;
    const i = src.findIndex((l, k) => k >= start && l.includes(needle)); if (i < 0) return [];
    const ind = src[i].search(/\S/);
    let fn = '<module>';
    for (let k = i - 1; k >= 0; k--) {
      const m = src[k].match(/^(\s*)def (\w+)/);
      if (m && m[1].length < ind) { fn = m[2]; break; }
    }
    return [`  File "${file}", line ${i + 1}, in ${fn}`, '    ' + (asciiLine(src[i]) || '').trim()];
  }

  return {
    // 新しい階: dungeon.py のどこかを流してから、出来た階の中身を出す
    level(d, ms) {
      const src = (sources['dungeon.py'] || []).map(asciiLine).filter(t => t !== null);
      const defs = src.map((l, i) => /^def /.test(l) ? i : -1).filter(i => i >= 0);
      const s = defs.length ? defs[Math.floor(Math.random() * defs.length)] : 0;
      const list = [{ t: `>>> dungeon.new_level(${d.depth})`, at: 0, kind: 'cmd', type: 1 }];
      let at = 330;
      for (const t of src.slice(s, s + 28)) { list.push({ t, at, kind: 'code' }); at += 10; }
      at += 60;
      for (const [k, v] of [['rooms', d.rooms], ['monsters', d.mons], ['objects', d.items], ['traps', d.traps]]) {
        list.push({ t: `  ${k.padEnd(9, ' ')}${String(v).padStart(3, ' ')}`, at, kind: 'out' }); at += 50;
      }
      list.push({ t: `<Level ${d.depth}: ok>`, at: at + 40, kind: 'ok' });
      show(list, ms);
    },
    // 死んだとき: その死に方に至った呼び出しを Python のエラー表示のように出す
    died(d, ms) {
      const cause = String(d.cause || 'unknown cause');
      let frames;
      if (cause === 'quit') frames = [frame('game.py', 'if ui.confirm_quit():')];
      else if (cause.startsWith('starved')) frames = [frame('game.py', 'msgs = self.player.tick()'), frame('player.py', 'self.hp = 0')];
      else if (cause.startsWith('killed by')) frames = [
        frame('game.py', 'if _run_monsters():', 'def _end_turn'), frame('game.py', 'msgs = m.do_turn('),
        frame('monsters.py', 'monster_attacks_player('), frame('combat.py', 'player.take_damage(', 'def monster_attacks_player'),
        frame('player.py', 'self.hp = max(0, self.hp - amount)'),
      ];
      else frames = [frame('game.py', 'self._end_turn(ui)')];
      const list = [{ t: 'Traceback (most recent call last):', at: 0, kind: 'out' }];
      let at = 260;
      for (const f of frames) for (const [j, t] of f.entries()) { list.push({ t, at, kind: j ? 'code' : 'out' }); at += j ? 200 : 70; }
      const err = cause === 'quit' ? 'SystemExit: quit' : `PlayerDied: ${cause} (floor ${d.floor})`;
      list.push({ t: err, at: at + 150, kind: 'err', type: 1 });
      show(list, ms);
    },
  };
})();
// 読み込み画面のロゴ（タイトル画面と同じ ROGUE と、その右下に水色の 3D）。罫線やブロックの字はフォントで幅が変わるので升目に縮めて描く
function drawCoverLogo() {
  const ROGUE = [
    '██████╗  ██████╗  ██████╗ ██╗   ██╗███████╗',
    '██╔══██╗██╔═══██╗██╔════╝ ██║   ██║██╔════╝',
    '██████╔╝██║   ██║██║  ███╗██║   ██║█████╗  ',
    '██╔══██╗██║   ██║██║   ██║██║   ██║██╔══╝  ',
    '██║  ██║╚██████╔╝╚██████╔╝╚██████╔╝███████╗',
    '╚═╝  ╚═╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚══════╝',
  ];
  const D3 = ['██████╗ ██████╗ ', '╚════██╗██╔══██╗', ' █████╔╝██║  ██║', ' ╚═══██╗██║  ██║', '██████╔╝██████╔╝', '╚═════╝ ╚═════╝ '];
  const cols = 44, rows = 12, cv = $('coverLogo'), dpr = devicePixelRatio || 1;
  const cw = 3.4, ch = cw * 2;   // 横幅は以前の題字（ROGUE の文字）と同じくらい
  cv.style.width = cols * cw + 'px'; cv.style.height = rows * ch + 'px';
  cv.width = Math.round(cols * cw * dpr); cv.height = Math.round(rows * ch * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `bold ${ch * 0.95}px ui-monospace, Menlo, Consolas, monospace`; ctx.textBaseline = 'middle';
  const put = (lines, y0, x0, color) => {
    ctx.fillStyle = color;
    lines.forEach((line, y) => [...line].forEach((c, x) => {
      if (c === ' ') return;
      const px = (x0 + x) * cw, py = (y0 + y) * ch;
      if (c === '█') ctx.fillRect(px, py + ch * 0.06, cw + 0.3, ch * 0.88);
      else ctx.fillText(c, px, py + ch / 2, cw);
    }));
  };
  put(ROGUE, 0, 0, PALETTE[3]);
  put(D3, 6, 28, PALETTE[6]);
}
drawCoverLogo();
addEventListener('resize', drawCoverLogo);
let coverFn = null;
tap($('coverBtn'), () => coverFn && coverFn());
function cover(text, btnLabel, fn) {
  $('cover').hidden = false; $('coverText').textContent = text;
  const b = $('coverBtn'); b.hidden = !btnLabel;
  if (btnLabel) { b.textContent = btnLabel; coverFn = fn; }
}

function start() {
  const files = loadFiles();
  readLang(files);
  if (!files['rogue.sav']) r3d.forgetRock();
  if (!files['rogue.cfg']) {   // 初回は端末の言語で始める（名前入力画面の Tab で切り替えられる）
    const cfg = new TextEncoder().encode(JSON.stringify({ lang }));
    saveFile('rogue.cfg', cfg); files['rogue.cfg'] = loadFiles()['rogue.cfg'];
  }
  cover(t().loading); rain.start();
  if (!window.crossOriginIsolated) {
    // coi-serviceworker が登録後に読み込み直す。それでも駄目なら諦める
    setTimeout(() => cover(t().noIso, t().reload, () => location.reload()), 6000);
    return;
  }
  const sab = new SharedArrayBuffer(4 * (2 + KEYQ));
  keys = new Int32Array(sab);
  const worker = new Worker('worker.js', { type: 'module' });
  const bin = {}; for (const [k, v] of Object.entries(files)) bin[k] = decode(v);
  worker.postMessage({ type: 'start', sab, files: bin });
  worker.onmessage = e => {
    const d = e.data;
    if (d.type === 'progress') cover(d.text === 'python' ? t().loadPy : t().loadGame);
    else if (d.type === 'draw') { for (const [y, chars, styles] of JSON.parse(d.rows)) putRow(y, chars, styles); requestDraw(); }
    else if (d.type === 'wait') {
      if (pageEnd) { const dir = pageEnd; pageEnd = 0; requestAnimationFrame(() => requestAnimationFrame(() => { box.scrollTop = dir > 0 ? box.scrollHeight : 0; updateMoreHints(); })); }
      $('cover').hidden = true; rain.stop();
      const changed = hint !== d.kind || valid !== d.valid;
      if (d.kind === 'more' || d.kind === 'any') moreSince = performance.now();   // メッセージが続くときも 1 つごとに数え直す
      hint = d.kind; valid = d.valid; waiting = true;
      if (changed) { debug(`wait ${d.kind}`); updateControls(); }
      requestDraw();
    }
    else if (d.type === 'file') saveFile(d.name, d.data);
    else if (d.type === 'mem') { alive.mem = Math.round(d.wasm / 1048576); if (!alive.mem0) alive.mem0 = alive.mem; }
    else if (d.type === 'missile') { alive.last.push('missile'); if (alive.last.length > 8) alive.last.shift(); r3d.missile(d.data); }
    else if (d.type === 'effect') {
      alive.last.push(d.data.type); if (alive.last.length > 8) alive.last.shift();
      if (d.data.type === 'newlevel') termFx.level(d.data, d.data.dur);
      else if (d.data.type === 'died') termFx.died(d.data, d.data.dur);
      else r3d.effect(d.data);
    }
    else if (d.type === 'flash') { const f = $('flash'); f.style.opacity = .35; setTimeout(() => { f.style.opacity = 0; }, 90); }
    else if (d.type === 'exit') {
      rain.stop();
      const saved = 'rogue.sav' in loadFiles();
      cover(saved ? t().saved : t().over, saved ? t().resume : t().again, () => location.reload());
    }
    else if (d.type === 'error') { rain.stop(); console.error(d.text); cover(t().crash + '\n' + d.text.split('\n').slice(-3).join('\n'), t().reload, () => location.reload()); }
  };
}
r3d.init($('v3'));
window.__rogue = { rowText, findPlayer, r3d, grid, termFx };   // 試験用（自動で歩かせて撮る）
new ResizeObserver(() => { r3d.resize(); }).observe(box);
start();
document.fonts && document.fonts.ready.then(requestDraw);
