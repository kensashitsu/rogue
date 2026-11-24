// ブラウザ版: Pyodide でゲーム本体（Python）をそのまま動かす Web Worker
//
// ゲームのキー入力を待つ流れは async（2026-11-24 から）。rogue_getch は Promise を返し、Python が await で待つ。
// キーは app.js が postMessage（type 'key'）で送り、ここの列に溜める。受け取ったら 'took' で知らせる（長押しの歩きで使う）。
// 以前は SharedArrayBuffer＋Atomics.wait で止まって待っていたが、COOP/COEP が要り、アプリの中のブラウザ（X・スレッズ）で動かなかった。
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

let py;
const queue = [];   // 届いたキー
let wake = null;    // キーを待っている Promise を解く関数
const mtimes = {};

function takeKey() {
  if (queue.length) return Promise.resolve(queue.shift());
  return new Promise(r => { wake = r; });
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
self.rogue_missile = json => postMessage({ type: 'missile', data: JSON.parse(json) });
self.rogue_effect = json => postMessage({ type: 'effect', data: JSON.parse(json) });
self.rogue_sleep = ms => new Promise(r => setTimeout(r, ms));   // 待つだけ（投げた物が飛ぶ間）
self.rogue_flushinp = () => { const n = queue.length; queue.length = 0; if (n) postMessage({ type: 'took', n }); };
self.rogue_getch = (kind, valid) => {
  syncSaves();
  postMessage({ type: 'wait', kind, valid });
  return takeKey().then(k => { postMessage({ type: 'took' }); return k; });
};

self.onmessage = async e => {
  if (e.data.type === 'key') {
    if (wake) { const w = wake; wake = null; w(e.data.code); } else queue.push(e.data.code);
    return;
  }
  if (e.data.type !== 'start') return;
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
    await py.runPythonAsync(`
import os, sys
os.chdir('${DIR}')
sys.path.insert(0, '${DIR}')
from game import run_game
try:
    await run_game()
except SystemExit:
    pass
`);
  } catch (err) {
    postMessage({ type: 'error', text: String(err) });
  }
  syncSaves();
  postMessage({ type: 'exit' });
};
