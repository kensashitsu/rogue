// ブラウザ版: Pyodide でゲーム本体（Python）をそのまま動かす Web Worker
//
// ゲームはキー入力を「止まって待つ」作りなので、Worker の中で Atomics.wait を使って待つ。
// キーは app.js が SharedArrayBuffer のリングバッファに書き込む:
//   [0] 書いた数  [1] 読んだ数  [2..] キーコード（KEYQ 個で一周）
// 画面は term.py が変化した行を rogue_draw に渡し、ここから app.js へ送る。
// セーブ・スコア・言語設定のファイルは、キー待ちのたびに変化を見て app.js へ送る（app.js が端末内に保存する）。
// モジュール Worker にしているのは、COEP の下でも Pyodide を CORS で読み込めるようにするため（importScripts は通らない）。

import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs';

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const SOURCES = [
  'main.py', 'game.py', 'dungeon.py', 'player.py', 'monsters.py', 'items.py', 'combat.py',
  'ui.py', 'term.py', 'i18n.py', 'i18n_ja.py', 'constants.py', 'data/items.json', 'data/monsters.json',
];
const SAVE_FILES = ['rogue.sav', 'rogue.scr', 'rogue.cfg'];
const DIR = '/rogue/';
const KEYQ = 64;

let keys, py;
const mtimes = {};

function takeKey() {
  for (;;) {
    const w = Atomics.load(keys, 0), r = keys[1];
    if (w !== r) {
      keys[1] = r + 1;
      return keys[2 + (r % KEYQ)];
    }
    Atomics.wait(keys, 0, w);
  }
}

function mtimeOf(name) {
  try { return py.FS.stat(DIR + name).mtime.valueOf(); } catch { return null; }
}

function syncSaves() {
  for (const name of SAVE_FILES) {
    const t = mtimeOf(name);
    if (t === mtimes[name]) continue;
    mtimes[name] = t;
    postMessage({ type: 'file', name, data: t === null ? null : py.FS.readFile(DIR + name) });
  }
}

self.rogue_draw = rows => postMessage({ type: 'draw', rows });
self.rogue_flash = () => postMessage({ type: 'flash' });
self.rogue_flushinp = () => { keys[1] = Atomics.load(keys, 0); };
self.rogue_getch = (kind, valid) => {
  syncSaves();
  postMessage({ type: 'wait', kind, valid });
  return takeKey();
};

self.onmessage = async e => {
  if (e.data.type !== 'start') return;
  keys = new Int32Array(e.data.sab);
  try {
    postMessage({ type: 'progress', text: 'python' });
    py = await loadPyodide({ indexURL: PYODIDE, stdout: () => {}, stderr: s => console.warn(s) });
    postMessage({ type: 'progress', text: 'game' });
    py.FS.mkdirTree(DIR + 'data');
    await Promise.all(SOURCES.map(async f => {
      const res = await fetch('../' + f, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${f}: ${res.status}`);
      py.FS.writeFile(DIR + f, new Uint8Array(await res.arrayBuffer()));
    }));
    for (const [name, data] of Object.entries(e.data.files || {})) py.FS.writeFile(DIR + name, data);
    for (const name of SAVE_FILES) mtimes[name] = mtimeOf(name);
  } catch (err) {
    postMessage({ type: 'error', text: String(err) });
    return;
  }
  try {
    py.runPython(`
import os, sys
os.chdir('${DIR}')
sys.path.insert(0, '${DIR}')
from game import run_game
try:
    run_game()
except SystemExit:
    pass
`);
  } catch (err) {
    postMessage({ type: 'error', text: String(err) });
  }
  syncSaves();
  postMessage({ type: 'exit' });
};
