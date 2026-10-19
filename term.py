# VT エスケープシーケンスによる curses 互換レイヤー
"""
windows-curses の代わりに使う、curses 互換の最小限の描画・入力モジュール。

windows-curses（PDCurses）は全角文字を 1 マスとして扱うため、日本語を部分的に
書き換えると位置ずれや消し残りが起きる。このモジュールは画面を「見た目の列」単位の
バッファで管理し（全角 = 2 マス）、変化した行だけを VT シーケンスで丸ごと書き直す。

ui.py は `import term as curses` として使う。実装しているのは ui.py が使う範囲だけ:
  initscr / endwin / noecho / echo / cbreak / nocbreak / curs_set / has_colors /
  start_color / use_default_colors / init_pair / color_pair / flash / flushinp /
  window.addstr / addch / move / clrtoeol / clear / refresh / getch / keypad /
  timeout / getmaxyx、属性 A_* と KEY_* 定数、error 例外。

入力は Windows の msvcrt を使う（Windows 専用）。

ブラウザ版（Pyodide、sys.platform == 'emscripten'）では VT シーケンスを出さず、
変化した行を web/worker.js の rogue_draw に渡し、キーは rogue_getch から受け取る。
"""

from __future__ import annotations

import json
import os
import sys
import time
import unicodedata

_WEB = sys.platform == 'emscripten'

if os.name == 'nt':
    import ctypes
    import msvcrt
if _WEB:
    import js


class error(Exception):
    """curses.error 互換。"""


# ---------------------------------------------------------------------------
# 属性（curses と同じくビットで持つ。下位 8 ビットは使わず、色ペアは 8〜15 ビット）
# ---------------------------------------------------------------------------
A_NORMAL    = 0
_A_COLOR    = 0xFF00
A_BOLD      = 0x10000
A_DIM       = 0x20000
A_REVERSE   = 0x40000
A_UNDERLINE = 0x80000

COLOR_BLACK, COLOR_RED, COLOR_GREEN, COLOR_YELLOW = 0, 1, 2, 3
COLOR_BLUE, COLOR_MAGENTA, COLOR_CYAN, COLOR_WHITE = 4, 5, 6, 7

# ---------------------------------------------------------------------------
# 特殊キー（curses と重ならないよう 0x100 以上）
# ---------------------------------------------------------------------------
KEY_DOWN, KEY_UP, KEY_LEFT, KEY_RIGHT = 0x102, 0x103, 0x104, 0x105
KEY_HOME, KEY_BACKSPACE, KEY_F1       = 0x106, 0x107, 0x109
KEY_NPAGE, KEY_PPAGE, KEY_END, KEY_B2 = 0x152, 0x153, 0x168, 0x15E
KEY_RESIZE = 0x19A

# msvcrt.getwch で '\x00' / '\xe0' の後に届くコード → KEY_*
_SPECIAL_KEYS = {
    'H': KEY_UP,   'P': KEY_DOWN, 'K': KEY_LEFT, 'M': KEY_RIGHT,
    'G': KEY_HOME, 'O': KEY_END,  'I': KEY_PPAGE, 'Q': KEY_NPAGE,
    'L': KEY_B2,   ';': KEY_F1,
}

_pairs: dict[int, tuple[int, int]] = {}
_screen: "window | None" = None
_out = sys.stdout


def char_width(c: str) -> int:
    """表示幅。全角（W/F）は 2、それ以外は 1。曖昧幅（─ █ など）は 1 として扱う。"""
    return 2 if unicodedata.east_asian_width(c) in 'WF' else 1


def text_width(s: str) -> int:
    return sum(char_width(c) for c in s)


# ---------------------------------------------------------------------------
# 端末制御
# ---------------------------------------------------------------------------

def _enable_vt() -> None:
    """Windows コンソールで VT シーケンスの解釈を有効にする。"""
    if os.name != 'nt':
        return
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.GetStdHandle(-11)   # STD_OUTPUT_HANDLE
    mode = ctypes.c_uint32()
    if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        kernel32.SetConsoleMode(handle, mode.value | 0x0004)   # ENABLE_VIRTUAL_TERMINAL_PROCESSING


def _write(s: str) -> None:
    if not _WEB:
        _out.write(s)


def initscr() -> "window":
    global _screen
    if _WEB:
        _screen = window(24, 80)
        return _screen
    _enable_vt()
    try:
        _out.reconfigure(encoding='utf-8')
    except (AttributeError, ValueError):
        pass
    try:
        cols, rows = os.get_terminal_size()
    except OSError:
        cols, rows = 80, 24
    # 代替画面に切り替え、カーソル非表示・自動折り返し無効
    _write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[0m\x1b[2J")
    _out.flush()
    _screen = window(rows, cols)
    return _screen


def endwin() -> None:
    _write("\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l")
    _out.flush()


def noecho() -> None: pass
def echo() -> None: pass
def cbreak() -> None: pass
def nocbreak() -> None: pass
def has_colors() -> bool: return True
def start_color() -> None: pass
def use_default_colors() -> None: pass


def curs_set(visibility: int) -> None:
    if _screen is not None:
        _screen._cursor_visible = bool(visibility)
    _write("\x1b[?25h" if visibility else "\x1b[?25l")
    _out.flush()


def init_pair(n: int, fg: int, bg: int) -> None:
    _pairs[n] = (fg, bg)


def color_pair(n: int) -> int:
    return (n << 8) & _A_COLOR


def flash() -> None:
    if _WEB:
        js.rogue_flash()
        return
    _write("\x1b[?5h")
    _out.flush()
    time.sleep(0.08)
    _write("\x1b[?5l")
    _out.flush()


def flushinp() -> None:
    if _WEB:
        js.rogue_flushinp()
    elif os.name == 'nt':
        while msvcrt.kbhit():
            msvcrt.getwch()


_hint = ('any', '')


def input_hint(kind: str, keys: str = '') -> None:
    """次の getch が何の入力を待っているかを伝える（ブラウザ版のボタン出し分け用。端末では使わない）。"""
    global _hint
    _hint = (kind, keys)


def _web_style(attr: int) -> int:
    """属性値 → ブラウザ版の描画用の数値（前景+1 | 背景+1 << 4 | 太字 256 | 薄字 512 | 下線 1024 | 反転 2048）。"""
    fg, bg = _pairs.get((attr & _A_COLOR) >> 8, (-1, -1))
    v = (fg + 1) | ((bg + 1) << 4)
    if attr & A_BOLD:
        v |= 256
    if attr & A_DIM:
        v |= 512
    if attr & A_UNDERLINE:
        v |= 1024
    if attr & A_REVERSE:
        v |= 2048
    return v


def _sgr(attr: int) -> str:
    """属性値 → SGR シーケンス（必ずリセットから始める）。"""
    codes = ['0']
    if attr & A_BOLD:
        codes.append('1')
    if attr & A_DIM:
        codes.append('2')
    if attr & A_UNDERLINE:
        codes.append('4')
    if attr & A_REVERSE:
        codes.append('7')
    pair = (attr & _A_COLOR) >> 8
    if pair in _pairs:
        fg, bg = _pairs[pair]
        if fg >= 0:
            codes.append(str(30 + fg))
        if bg >= 0:
            codes.append(str(40 + bg))
    return "\x1b[" + ";".join(codes) + "m"


# ---------------------------------------------------------------------------
# ウィンドウ（画面全体のみ）
# ---------------------------------------------------------------------------

_CONT = ''   # 全角文字の右半分を表す継続セル


class window:
    def __init__(self, rows: int, cols: int) -> None:
        self._rows, self._cols = rows, cols
        self._buf   = [self._blank_row() for _ in range(rows)]
        self._shown: list = [None] * rows      # 端末に出ている内容（None = 不明 → 必ず書く）
        self._cy = self._cx = 0
        self._cursor_visible = False
        self._full_clear = True

    def _blank_row(self) -> list:
        return [(' ', 0) for _ in range(self._cols)]

    # ---- 書き込み ----

    def _put(self, y: int, x: int, c: str, attr: int) -> int:
        """1 文字を書いて次の列を返す。画面外・行末にかかる全角は書かない。"""
        row = self._buf[y]
        w = char_width(c)
        if x < 0 or x + w > self._cols:
            return x + w
        # 全角の片割れを壊す場合は空白にする
        if row[x][0] == _CONT and x > 0:
            row[x - 1] = (' ', row[x - 1][1])
        end = x + w
        if end < self._cols and row[end][0] == _CONT:
            row[end] = (' ', row[end][1])
        row[x] = (c, attr)
        if w == 2:
            row[x + 1] = (_CONT, attr)
        return end

    def addstr(self, *args) -> None:
        """addstr(y, x, s[, attr]) または addstr(s[, attr])（現在位置から）。"""
        if len(args) >= 3 and isinstance(args[0], int):
            y, x, s = args[0], args[1], args[2]
            attr = args[3] if len(args) > 3 else 0
        else:
            y, x = self._cy, self._cx
            s = args[0]
            attr = args[1] if len(args) > 1 else 0
        if not (0 <= y < self._rows):
            raise error("addstr: row out of range")
        for c in s:
            if c == '\n':
                y, x = y + 1, 0
                if y >= self._rows:
                    break
                continue
            x = self._put(y, x, c, attr)
        self._cy, self._cx = y, min(x, self._cols - 1)

    def addch(self, y: int, x: int, ch, attr: int = 0) -> None:
        if isinstance(ch, int):
            ch = chr(ch)
        if not (0 <= y < self._rows):
            raise error("addch: row out of range")
        self._put(y, x, ch, attr)
        self._cy, self._cx = y, min(x + char_width(ch), self._cols - 1)

    def move(self, y: int, x: int) -> None:
        self._cy, self._cx = y, x

    def clrtoeol(self) -> None:
        row = self._buf[self._cy]
        x = self._cx
        if 0 < x < self._cols and row[x][0] == _CONT:
            row[x - 1] = (' ', 0)
        for i in range(max(0, x), self._cols):
            row[i] = (' ', 0)

    def clear(self) -> None:
        self._buf = [self._blank_row() for _ in range(self._rows)]
        self._full_clear = True

    erase = clear

    # ---- 出力 ----

    def _render_row(self, row: list) -> str:
        parts: list[str] = []
        cur = None
        for c, attr in row:
            if c == _CONT:
                continue
            if attr != cur:
                parts.append(_sgr(attr))
                cur = attr
            parts.append(c)
        parts.append("\x1b[0m")
        return "".join(parts)

    def refresh(self) -> None:
        if _WEB:
            self._web_refresh()
            return
        out: list[str] = []
        if self._full_clear:
            out.append("\x1b[0m\x1b[2J")
            self._shown = [None] * self._rows
            self._full_clear = False
        for y, row in enumerate(self._buf):
            if self._shown[y] != row:
                out.append(f"\x1b[{y + 1};1H")
                out.append(self._render_row(row))
                self._shown[y] = list(row)
        if self._cursor_visible:
            out.append(f"\x1b[{self._cy + 1};{self._cx + 1}H")
        if out:
            _write("".join(out))
            _out.flush()

    def _web_refresh(self) -> None:
        rows = []
        for y, row in enumerate(self._buf):
            if self._shown[y] != row:
                cells = [(c, _web_style(a)) for c, a in row if c != _CONT]
                rows.append([y, ''.join(c for c, _ in cells), [a for _, a in cells]])
                self._shown[y] = list(row)
        self._full_clear = False
        if rows:
            js.rogue_draw(json.dumps(rows, ensure_ascii=False))

    # ---- 入力 ----

    def keypad(self, flag: bool) -> None:
        pass

    def timeout(self, delay: int) -> None:
        pass   # ui.py はブロッキング読みのみ使用する

    def getmaxyx(self) -> tuple[int, int]:
        return self._rows, self._cols

    def getch(self) -> int:
        global _hint
        self.refresh()
        if _WEB:
            kind, keys = _hint
            _hint = ('any', '')
            return int(js.rogue_getch(kind, keys))
        c = msvcrt.getwch()
        if c in ('\x00', '\xe0'):
            return _SPECIAL_KEYS.get(msvcrt.getwch(), -1)
        if c == '\x03':
            raise KeyboardInterrupt
        return ord(c)
