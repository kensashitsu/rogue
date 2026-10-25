// ブラウザ版の画面と操作（メインスレッド）
//
// ゲーム本体は worker.js（Pyodide）で動く。ここでは
//   - Worker から届く 80×24 の画面を canvas に描く（縦持ちでは自分の周りだけを表示して付いていく）
//   - ゲームが待っている入力の種類（term.input_hint）に合わせてボタンを出し分け、押されたキーを Worker へ渡す
//   - セーブ・スコア・言語設定のファイルを端末内（localStorage）に保存する
// を受け持つ。

const VERSION = '10-25.6';   // 画面右上に出す版番号。iPhone に新しい版が届いたか確かめる用。公開のたびに上げる
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
const RATIO = 2.05;                  // セルの縦横比
const STORE = 'rogue-files';

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
           ['^', '罠を調べる'], ['/', '記号を調べる'], ['@', '状態'], ['^P', '前の文'], ['o', '言語'], ['?', 'ヘルプ'], ['manual', '説明書'], ['S', '保存して終了'], ['Q', 'あきらめる']],
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
           ['^', 'Trap'], ['/', 'Symbol'], ['@', 'Status'], ['^P', 'Last msg'], ['o', 'Language'], ['?', 'Help'], ['manual', 'Manual (ja)'], ['S', 'Save & quit'], ['Q', 'Quit']],
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
try { const p = JSON.parse(localStorage.getItem('rogue-view') || '{}'); view = p.view || view; viewCols = p.cols || viewCols; } catch {}
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

function render() {
  ensureGlyphs();
  mode = isMap() ? 'map' : 'text';
  const land = innerWidth > innerHeight;
  app.className = `${land ? 'landscape' : 'portrait'} ${mode === 'text' ? 'text' : view}`;
  box.classList.toggle('text', mode === 'text');
  $('zoomSeg').style.visibility = view === 'follow' ? '' : 'hidden';

  if (mode === 'map') {
    const msg = $('msg'), text = rowText(0).trim();
    if (msg.textContent !== text) {
      msg.textContent = text; msg.style.fontSize = '';
      for (let fs = parseFloat(getComputedStyle(msg).fontSize); msg.scrollHeight > msg.clientHeight + 1 && fs > 10; fs -= 1)
        msg.style.fontSize = fs - 1 + 'px';   // 2 行に収まるまで字を小さくする
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
    cw = Math.min(bw / cols, bh / (rows * RATIO), bw / 32);
    cw = Math.max(cw, 6); ox = 0;
  } else if (view === 'full') {
    cols = W; rows = H; cw = Math.min(bw / W, bh / (H * RATIO)); ox = 0;
  } else {
    cols = Math.min(viewCols, W); cw = bw / cols;
    rows = Math.max(1, Math.min(H - 2, Math.floor(bh / (cw * RATIO))));
    const p = findPlayer(); if (p) [py, px] = p;
    follow();
    y0 = vy; ox = vx;
  }
  ch = cw * RATIO;
  const dpr = devicePixelRatio || 1;
  const wpx = Math.floor(cols * cw), hpx = Math.floor(rows * ch);
  if (cv.width !== Math.floor(wpx * dpr) || cv.height !== Math.floor(hpx * dpr)) {
    cv.style.width = wpx + 'px'; cv.style.height = hpx + 'px';
    cv.width = Math.floor(wpx * dpr); cv.height = Math.floor(hpx * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawCells(mode === 'text' ? rowMap : Array.from({ length: rows }, (_, r) => (mode === 'map' && view === 'follow' ? y0 : 0) + r));
  updateMoreHints();
}

// 文字だけの画面が収まらず、まだ見ていない続きがあるとき、その側に印を出す
function updateMoreHints() {
  const text = mode === 'text';
  $('moreRight').hidden = !(text && box.scrollLeft + box.clientWidth < box.scrollWidth - 2);
  $('moreDown').hidden = !(text && box.scrollTop + box.clientHeight < box.scrollHeight - 2);
}
box.addEventListener('scroll', updateMoreHints, { passive: true });
// 印は押すとその側へ送る（押せない印だと、押したつもりの指が下の一覧の行に抜けて、その物を選んでしまう）
tap($('moreDown'), () => { box.scrollTop += box.clientHeight * 0.8; updateMoreHints(); });
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
  ctx.fillStyle = DEFAULT_BG; ctx.fillRect(0, 0, cols * cw, rows * ch);
  ctx.textBaseline = 'middle';
  const size = Math.round(cw * 1.9);
  const family = getComputedStyle(document.documentElement).getPropertyValue('--font-term');
  for (let r = 0; r < rows; r++) {
    const row = grid[lines[r]]; if (!row) continue;
    for (let c = 0; c < cols; c++) {
      const cell = row[ox + c]; if (!cell) continue;
      const [g, s] = cell; const w = s & 4096 ? 2 : 1;
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
const DPAD = [['y', '↖'], ['k', '↑'], ['u', '↗'], ['h', '←'], ['.', ''], ['l', '→'], ['b', '↙'], ['j', '↓'], ['n', '↘']];
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

function buildButtons() {
  const T = t();
  $('vFollow').textContent = T.follow; $('vFull').textContent = T.full;
  [...$('zoomSeg').children].forEach((b, i) => { b.textContent = [T.small, T.mid, T.large][i]; });

  const dp = $('dpad'); dp.textContent = '';
  for (const [k, arrow] of DPAD) {
    const rest = k === '.';
    const b = makeKey(rest ? T.rest : arrow, rest ? '.' : '', dp, rest ? 'rest' : '');
    if (rest) restKey = b;
    b.setAttribute('aria-label', rest ? T.rest : k);
    let timer = 0;
    // 長押し: 押している間 1 歩ずつ歩き続ける（休むも同じ）。前の 1 歩をゲームが受け取ってから次を送るので、
    // 離せばすぐ止まる。メッセージの「次へ」待ちなどになったら止まる
    const repeat = () => {
      debug(`repeat ${k} hint=${hint} queued=${Atomics.load(keys, 0) - keys[1]}`);
      if (hint === 'command' && Atomics.load(keys, 0) === keys[1]) send(k);
      timer = setTimeout(repeat, 110);
    };
    const press = () => {
      b.classList.add('on'); clearTimeout(timer);
      if (hint === 'direction') { answer(rest ? 27 : k); return; }
      if (hint !== 'command') return;
      send(k);
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
    const b = makeKey(label, k === 'manual' ? '' : k, mg);
    tap(b, () => { $('more').hidden = true; if (k === 'manual') openManual(); else if (hint === 'command') answer(keyCode(k)); });
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
    btn('↑', '', r, () => { answer(KEY.PPAGE); }); btn('↓', '', r, () => { answer(KEY.NPAGE); });   // 1 ページずつ送る
    btn(T.cancel, 'ESC', row(), () => answer(27));
  } else if (hint === 'text' || hint === 'name' || hint === 'char') {
    textEntry(c, T, keep);
  } else {
    // ボタンは置かない（画面のどこをタップしても進む。案内はメッセージの下の #tapHint）
  }
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

// 画面のタップ: 「次へ」待ちなら進める、一覧なら行の記号を選ぶ
cv.addEventListener('click', e => {
  if (hint !== 'list') return;
  const y = rowMap[Math.floor(e.offsetY / ch)];
  if (y === undefined) return;
  const m = rowText(y).match(/^\s*(\S)\)/);
  if (m && valid.includes(m[1])) answer(m[1]);
});
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
addEventListener('resize', () => { $('status').dataset.text = ''; $('msg').textContent = ''; requestDraw(); });   // 幅が変わったら詰め直す

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
let coverFn = null;
tap($('coverBtn'), () => coverFn && coverFn());
function cover(text, btnLabel, fn) {
  $('cover').hidden = false; $('coverText').textContent = text;
  const b = $('coverBtn'); b.hidden = !btnLabel;
  if (btnLabel) { b.textContent = btnLabel; coverFn = fn; }
}

// 投げた物が飛んでいく様子: 道筋のマスに 1 つずつ字を置いて描く（ゲームはその間待っている）。
// 途中でゲームが行を描き直したら、その行は戻さない
function animateMissile(m) {
  let i = 0, placed = null;
  const step = () => {
    if (placed && grid[placed.y][placed.x] === placed.cell) grid[placed.y][placed.x] = placed.prev;
    if (i >= m.path.length) { requestDraw(); return; }
    const [y, x] = m.path[i++];
    placed = { y, x, prev: grid[y][x], cell: [m.ch, m.style] };
    grid[y][x] = placed.cell;
    requestDraw();
    setTimeout(step, m.step);
  };
  step();
}

function start() {
  const files = loadFiles();
  readLang(files);
  if (!files['rogue.cfg']) {   // 初回は端末の言語で始める（名前入力画面の Tab で切り替えられる）
    const cfg = new TextEncoder().encode(JSON.stringify({ lang }));
    saveFile('rogue.cfg', cfg); files['rogue.cfg'] = loadFiles()['rogue.cfg'];
  }
  cover(t().loading);
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
      $('cover').hidden = true;
      const changed = hint !== d.kind || valid !== d.valid;
      if (d.kind === 'more' || d.kind === 'any') moreSince = performance.now();   // メッセージが続くときも 1 つごとに数え直す
      hint = d.kind; valid = d.valid; waiting = true;
      if (changed) { debug(`wait ${d.kind}`); updateControls(); }
      requestDraw();
    }
    else if (d.type === 'file') saveFile(d.name, d.data);
    else if (d.type === 'missile') animateMissile(d.data);
    else if (d.type === 'flash') { const f = $('flash'); f.style.opacity = .35; setTimeout(() => { f.style.opacity = 0; }, 90); }
    else if (d.type === 'exit') {
      const saved = 'rogue.sav' in loadFiles();
      cover(saved ? t().saved : t().over, saved ? t().resume : t().again, () => location.reload());
    }
    else if (d.type === 'error') { console.error(d.text); cover(t().crash + '\n' + d.text.split('\n').slice(-3).join('\n'), t().reload, () => location.reload()); }
  };
}
start();
document.fonts && document.fonts.ready.then(requestDraw);
