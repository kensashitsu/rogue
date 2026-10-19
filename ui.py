# 画面表示・メッセージ
"""
ゲーム UI。描画と入力は term.py（curses 互換の VT 描画レイヤー）を curses として使う。
windows-curses は全角文字の幅を扱えず日本語表示が崩れるため使わない。

画面レイアウト（24×80 ターミナル）:
  Row  0      : メッセージ行
  Rows 1–22   : ダンジョンマップ
  Row  23     : ステータスバー

"""

from __future__ import annotations

import term as curses
import random
from typing import TYPE_CHECKING, Optional

from i18n import tr, name as tr_name, get_lang, set_lang, cause as tr_cause
from term import text_width, char_width
from constants import F_SEEN, CH_DOOR, LAMPDIST, ISINVIS, ISKNOW, CH_FOOD, CH_GOLD, CH_AMULET, CH_WEAPON, CH_ARMOR
from items import get_knowledge

if TYPE_CHECKING:
    from dungeon import Dungeon
    from player import Player

# ---------------------------------------------------------------------------
# キーマッピング: 押下キー文字 → アクション名
# ---------------------------------------------------------------------------
KEY_MAP: dict[str, str] = {
    # 8方向移動 (vi キー / ローグライク標準)
    'h': 'move_w',    'j': 'move_s',    'k': 'move_n',    'l': 'move_e',
    'y': 'move_nw',   'u': 'move_ne',   'b': 'move_sw',   'n': 'move_se',
    # 走行（大文字 = 壁・ドア・モンスターに当たるまで走り続ける）
    'H': 'run_w',     'J': 'run_s',     'K': 'run_n',     'L': 'run_e',
    'Y': 'run_nw',    'U': 'run_ne',    'B': 'run_sw',    'N': 'run_se',
    # テンキー移動（NumLock ON 時: 数字文字として届く）
    # 注意: NumLock ON 時はテンキーと通常数字キーを区別できない（windows-curses の制限）
    '8': 'move_n',    '2': 'move_s',    '4': 'move_w',    '6': 'move_e',
    '7': 'move_nw',   '9': 'move_ne',   '1': 'move_sw',   '3': 'move_se',
    '5': 'rest',      # テンキー5 = 待機
    # 階段
    '>': 'descend',   '<': 'ascend',
    # アイテム操作
    'i': 'inventory', 'd': 'drop',      'e': 'eat',
    'r': 'read',      'q': 'quaff',
    # 装備（Rogue 5.4 準拠: w=wield w=wear W=wear T=takeoff）
    'w': 'wield',     'W': 'wear',      'T': 'takeoff',
    'P': 'put_on_ring',                 'R': 'remove_ring',
    # 戦闘・投擲・杖
    't': 'throw',     'z': 'zap',       'f': 'fight',
    # 探索・情報
    '^': 'check_trap', '/': 'identify', 's': 'search',
    '.': 'rest',      '@': 'show_status', '?': 'help',
    # システム
    'Q': 'quit',      'S': 'save',
    'o': 'language',  # 表示言語（英語 / 日本語）の切り替え
    '\x10': 'repeat_msg',    # Ctrl-P: 直前のメッセージを再表示
    '\x12': 'redraw',        # Ctrl-R: 画面再描画
    '\x07': 'godmode',       # Ctrl-G: デバッグ無敵モード切替
}


# 矢印などの特殊キーのコード。文字コードと重なるので、名前入力では文字として扱わない
_SPECIAL_KEY_CODES = {
    curses.KEY_DOWN, curses.KEY_UP, curses.KEY_LEFT, curses.KEY_RIGHT, curses.KEY_HOME,
    curses.KEY_BACKSPACE, curses.KEY_F1, curses.KEY_NPAGE, curses.KEY_PPAGE, curses.KEY_END,
    curses.KEY_B2, curses.KEY_RESIZE,
}


def _build_int_key_map() -> dict[int, str]:
    """
    整数キーコード（矢印キー・テンキー NumLock OFF 時）→ アクション名。
    curses 定数が存在しない環境でも安全に動作する。
    """
    m: dict[int, str] = {}
    # 矢印キー（NumLock ON/OFF 問わず常に有効）
    m[curses.KEY_UP]    = 'move_n'
    m[curses.KEY_DOWN]  = 'move_s'
    m[curses.KEY_LEFT]  = 'move_w'
    m[curses.KEY_RIGHT] = 'move_e'
    # テンキー NumLock OFF 時の斜め・中央キー
    # KEY_HOME=7, KEY_PPAGE=9, KEY_END=1, KEY_NPAGE=3, KEY_B2=5 に相当
    for attr, action in (
        ('KEY_HOME',  'move_nw'),   # Numpad 7 (Home)
        ('KEY_PPAGE', 'move_ne'),   # Numpad 9 (Page Up)
        ('KEY_END',   'move_sw'),   # Numpad 1 (End)
        ('KEY_NPAGE', 'move_se'),   # Numpad 3 (Page Down)
        ('KEY_B2',    'rest'),      # Numpad 5 (中央)
        ('KEY_F1',    'help'),      # F1 = ヘルプ（日本語キーボードで ? が入力できない場合の代替）
    ):
        code = getattr(curses, attr, None)
        if code is not None:
            m[code] = action
    return m


# 整数キーコード → アクション名（モジュール読み込み時に構築）
_INT_KEY_MAP: dict[int, str] = _build_int_key_map()

# prompt_direction 用: 整数キーコード → (dy, dx)
_INT_DIR_MAP: dict[int, tuple[int, int]] = {
    curses.KEY_UP:    (-1,  0),
    curses.KEY_DOWN:  ( 1,  0),
    curses.KEY_LEFT:  ( 0, -1),
    curses.KEY_RIGHT: ( 0,  1),
}
# テンキー NumLock OFF 斜め
for _attr, _delta in (
    ('KEY_HOME',  (-1, -1)),
    ('KEY_PPAGE', (-1,  1)),
    ('KEY_END',   ( 1, -1)),
    ('KEY_NPAGE', ( 1,  1)),
    ('KEY_B2',    ( 0,  0)),   # 5 = 待機 → (0,0) でキャンセル扱い
):
    _code = getattr(curses, _attr, None)
    if _code is not None:
        _INT_DIR_MAP[_code] = _delta

# 移動アクション → (dy, dx) デルタ
MOVE_DELTAS: dict[str, tuple[int, int]] = {
    'move_n':  (-1,  0), 'move_s':  ( 1,  0),
    'move_e':  ( 0,  1), 'move_w':  ( 0, -1),
    'move_ne': (-1,  1), 'move_nw': (-1, -1),
    'move_se': ( 1,  1), 'move_sw': ( 1, -1),
    'run_n':   (-1,  0), 'run_s':   ( 1,  0),
    'run_e':   ( 0,  1), 'run_w':   ( 0, -1),
    'run_ne':  (-1,  1), 'run_nw':  (-1, -1),
    'run_se':  ( 1,  1), 'run_sw':  ( 1, -1),
}

# 走行アクションかどうかを判定するセット
RUN_ACTIONS: frozenset[str] = frozenset(
    a for a in MOVE_DELTAS if a.startswith('run_')
)

# ---------------------------------------------------------------------------
# カラーペア番号（curses.init_pair で初期化）
# ---------------------------------------------------------------------------
_CP_DEFAULT = 1    # 通常テキスト（白）
_CP_PLAYER  = 2    # プレイヤー '@'（黄・太字）
_CP_MONSTER = 3    # モンスター（赤）
_CP_ITEM    = 4    # アイテム全般（緑）
_CP_GOLD    = 5    # 金 '*'（黄）
_CP_STAIRS  = 6    # 階段 '%'（シアン）
_CP_SEEN    = 7    # 既訪問・不可視タイル（薄い白）
_CP_MESSAGE = 8    # メッセージ（白）
_CP_STATUS  = 9    # ステータスバー（黒地に白）
_CP_PASSAGE = 10   # 通路 '#'（白・薄い）

# タイル文字 → カラーペア番号
_TILE_CP: dict[str, int] = {
    '*': _CP_GOLD,
    '%': _CP_STAIRS,
    '#': _CP_PASSAGE,
    '!': _CP_ITEM,
    '?': _CP_ITEM,
    ':': _CP_ITEM,
    ')': _CP_ITEM,
    ']': _CP_ITEM,
    '=': _CP_ITEM,
    '/': _CP_ITEM,
    ',': _CP_ITEM,
    '$': _CP_ITEM,
}

# ---------------------------------------------------------------------------
# シンボル説明テーブル ('/' コマンド用)
# ---------------------------------------------------------------------------
_SYMBOL_DESC: dict[str, str] = {
    '@': "The hero (you)",
    '#': "A passage",
    '.': "The floor of a room",
    '+': "A door",
    '-': "A horizontal wall",
    '|': "A vertical wall",
    '%': "A staircase",
    '*': "Some gold",
    '!': "A potion",
    '?': "A scroll",
    ':': "Some food",
    ')': "A weapon",
    ']': "Armor",
    '=': "A ring",
    '/': "A wand or staff",
    ',': "The Amulet of Yendor",
    '^': "A trap",
}

# ---------------------------------------------------------------------------
# ヘルプテキスト
# ---------------------------------------------------------------------------
_HELP_LINES = [
    " Rogue – Command Reference",
    " " + "─" * 38,
    "  h/j/k/l/y/u/b/n  Move (vi keys)",
    "  H/J/K/L/Y/U/B/N  Run in direction",
    "  Arrows / Numpad   Move (8 dirs; 5=rest)",
    "  >  Descend stairs   <  Ascend stairs",
    "  i  Inventory        d  Drop item",
    "  e  Eat food         r  Read scroll",
    "  q  Quaff potion     w  Wield weapon",
    "  W  Wear armor       T  Take off armor",
    "  P  Put on ring      R  Remove ring",
    "  t  Throw item       z  Zap wand/staff",
    "  f  Fight monster    s  Search",
    "  .  Rest one turn    @  Show status",
    "  ?/F1  This help      ^  Check for traps",
    "  /  Identify symbol",
    "  S  Save & quit      Q  Quit (no save)",
    "  Ctrl-P  Repeat last message",
    "  Ctrl-R  Redraw screen",
    "  o  Language (English / Japanese)",
    " " + "─" * 38,
    "  Press any key to continue...",
]


# タイトルのロゴ
_TITLE_BANNER = [
    "  ██████╗  ██████╗  ██████╗ ██╗   ██╗███████╗",
    "  ██╔══██╗██╔═══██╗██╔════╝ ██║   ██║██╔════╝",
    "  ██████╔╝██║   ██║██║  ███╗██║   ██║█████╗  ",
    "  ██╔══██╗██║   ██║██║   ██║██║   ██║██╔══╝  ",
    "  ██║  ██║╚██████╔╝╚██████╔╝╚██████╔╝███████╗",
    "  ╚═╝  ╚═╝ ╚═════╝  ╚═════╝  ╚═════╝ ╚══════╝",
]


def _fit(s: str, width: int = 79) -> str:
    """見た目の幅（全角 = 2）で width に切り詰め、足りなければ空白で埋める。"""
    out, w = [], 0
    for c in s:
        cw = char_width(c)
        if w + cw > width:
            break
        out.append(c)
        w += cw
    return "".join(out) + " " * (width - w)


# ===========================================================================
# UI クラス
# ===========================================================================

class UI:
    """
    curses ベースのゲーム UI。

    使用例::
        with UI() as ui:
            ui.draw_all(dungeon, player)
            action, key = ui.get_command()
    """

    MSG_ROW    = 0     # メッセージ行
    MAP_TOP    = 1     # マップ開始行
    MAP_BOT    = 22    # マップ終了行
    STATUS_ROW = 23    # ステータスバー行

    _EVENT_LOG_LIMIT = 100

    def __init__(self) -> None:
        self.stdscr: Optional[curses.window] = None
        self._msgs:        list[str] = []    # 表示待ちメッセージキュー
        self._last_msg:    str       = ""    # 直前に表示したメッセージ
        self._has_color:   bool      = False
        self._cleaned_up:  bool      = False
        self._event_log:   list[str] = []    # ゲームオーバーログ用メッセージ履歴

    # =========================================================================
    # 初期化 / クリーンアップ
    # =========================================================================

    def init(self) -> None:
        """curses を初期化する。ターミナルが 80×24 未満の場合は RuntimeError を送出する。"""
        self.stdscr = curses.initscr()
        rows, cols = self.stdscr.getmaxyx()
        if rows < 24 or cols < 80:
            curses.endwin()
            raise RuntimeError(tr(
                "Terminal too small: {cols}\xd7{rows}.  Rogue requires at least 80\xd724 characters.",
                cols=cols, rows=rows,
            ))
        curses.noecho()
        curses.cbreak()
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        self.stdscr.keypad(True)
        self.stdscr.timeout(-1)   # blocking getch

        self._has_color = curses.has_colors()
        if self._has_color:
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(_CP_DEFAULT, curses.COLOR_WHITE,   -1)
            curses.init_pair(_CP_PLAYER,  curses.COLOR_YELLOW,  -1)
            curses.init_pair(_CP_MONSTER, curses.COLOR_RED,     -1)
            curses.init_pair(_CP_ITEM,    curses.COLOR_GREEN,   -1)
            curses.init_pair(_CP_GOLD,    curses.COLOR_YELLOW,  -1)
            curses.init_pair(_CP_STAIRS,  curses.COLOR_CYAN,    -1)
            curses.init_pair(_CP_SEEN,    curses.COLOR_WHITE,   -1)
            curses.init_pair(_CP_MESSAGE, curses.COLOR_WHITE,   -1)
            curses.init_pair(_CP_STATUS,  curses.COLOR_BLACK,   curses.COLOR_WHITE)
            curses.init_pair(_CP_PASSAGE, curses.COLOR_WHITE,   -1)

    def cleanup(self) -> None:
        """ターミナルを復元する（二重呼び出し安全）。"""
        if self._cleaned_up:
            return
        self._cleaned_up = True
        try:
            if self.stdscr:
                self.stdscr.keypad(False)
            curses.nocbreak()
            curses.echo()
            try:
                curses.curs_set(1)
            except curses.error:
                pass
            curses.endwin()
        except curses.error:
            pass

    def __enter__(self) -> "UI":
        self.init()
        return self

    def __exit__(self, *_) -> None:
        self.cleanup()

    def _cp(self, n: int) -> int:
        """カラーペア属性値を返す。色なしの場合は 0。"""
        return curses.color_pair(n) if self._has_color else 0

    # =========================================================================
    # メッセージシステム
    # =========================================================================

    def add_message(self, msg: str) -> None:
        """メッセージをキューに積む。"""
        if msg:
            self._msgs.append(msg)
            self._event_log.append(msg)
            if len(self._event_log) > self._EVENT_LOG_LIMIT:
                self._event_log.pop(0)

    def get_event_log(self) -> list[str]:
        """直近 _EVENT_LOG_LIMIT 件のメッセージ履歴を返す。"""
        return list(self._event_log)

    def add_messages(self, msgs: list[str]) -> None:
        for m in msgs:
            self.add_message(m)

    def flush_messages(self) -> None:
        """
        キューのメッセージを全件表示する。
        複数ある場合は '--More--' をメッセージ末尾に付加してキー待ちする。
        """
        while self._msgs:
            msg = self._msgs.pop(0)
            self._last_msg = msg
            if self._msgs:
                self._raw_message(self._with_more(msg))
                if self.stdscr:
                    self._wait_advance()
            else:
                self._raw_message(msg)

    def _raw_message(self, msg: str) -> None:
        """メッセージ行に直接書き込む（フラッシュなし）。"""
        if self.stdscr is None:
            return
        attr = self._cp(_CP_MESSAGE)
        try:
            self.stdscr.move(self.MSG_ROW, 0)
            self.stdscr.clrtoeol()
            self.stdscr.addstr(self.MSG_ROW, 0, _fit(msg).rstrip(), attr)
        except curses.error:
            pass
        self.stdscr.refresh()

    @staticmethod
    def _with_more(msg: str) -> str:
        """メッセージ末尾に --More-- を付ける。長すぎる場合は本文を削って必ず見えるようにする。"""
        more = "  " + tr("--More--")
        return _fit(msg, 79 - text_width(more)).rstrip() + more

    def clear_message(self) -> None:
        """メッセージ行を消去する。"""
        if self.stdscr is None:
            return
        try:
            self.stdscr.move(self.MSG_ROW, 0)
            self.stdscr.clrtoeol()
        except curses.error:
            pass

    def show_message(self, msg: str) -> None:
        """即座に 1 件表示する（キュー経由しない）。"""
        self._raw_message(msg)
        self._last_msg = msg

    # =========================================================================
    # 入力
    # =========================================================================

    def _getch(self, hint: str = 'any', keys: str = '') -> int:
        """
        curses getch のラッパー。stdscr が None なら -1 を返す。
        hint / keys は何の入力を待っているか（スマホ版がボタンの出し分けに使う。端末では無視）:
          command / direction / more / char（keys = 受け付ける文字）/ text / name / list（keys = 選べる記号）/ any
        """
        if self.stdscr is None:
            return -1
        curses.input_hint(hint, keys)
        return self.stdscr.getch()

    def _wait_advance(self) -> None:
        """スペース・エンター・エスケープで進む --More-- キー待ち。"""
        _ADVANCE = {ord(' '), ord('\n'), ord('\r'), 27}
        while True:
            ch = self._getch('more')
            if ch in (-1, curses.KEY_RESIZE):
                continue
            if ch in _ADVANCE:
                break

    def get_command(self) -> tuple[str, str]:
        """
        キー入力を待ち (action, key) を返す。
        未割り当てキーは action='noop' で返す。
        キー待ちの前にキューに溜まったメッセージをフラッシュする。

        処理順序:
          1. 整数コード (_INT_KEY_MAP): 矢印キー・テンキー NumLock OFF
          2. 文字コード (KEY_MAP): vi キー・テンキー NumLock ON（数字）・その他
        """
        self.flush_messages()

        while True:
            ch = self._getch('command')
            if ch == -1:
                continue

            # 矢印キー・テンキー NumLock OFF（整数コードで届く）
            int_action = _INT_KEY_MAP.get(ch)
            if int_action is not None:
                return int_action, ''

            try:
                key = chr(ch)
            except (ValueError, OverflowError):
                key = ''

            action = KEY_MAP.get(key, 'noop')

            if action == 'repeat_msg':
                self._raw_message(f"  {self._last_msg}")
                continue
            if action == 'redraw':
                if self.stdscr:
                    self.stdscr.clear()
                    self.stdscr.refresh()
                return 'redraw', key

            return action, key

    def prompt_char(self, msg: str, valid: str = "") -> str:
        """
        1 文字入力プロンプト。
        valid が空でなければそのいずれかが入力されるまで繰り返す。
        ESC / Q で空文字を返す。
        """
        self._raw_message(msg)
        while True:
            ch = self._getch('char', valid)
            if ch in (27, ord('Q')):   # ESC
                self.clear_message()
                return ''
            try:
                c = chr(ch)
            except (ValueError, OverflowError):
                continue
            if not valid or c in valid:
                self.clear_message()
                return c

    def prompt_str(self, msg: str) -> str:
        """
        1 行テキスト入力プロンプト。
        Enter で確定、ESC でキャンセル（空文字を返す）。
        """
        if self.stdscr is None:
            return ''
        self._raw_message(msg)
        curses.echo()
        curses.curs_set(1)
        buf: list[str] = []
        try:
            while True:
                ch = self._getch('text')
                if ch == 27:
                    buf = []
                    break
                if ch in (10, 13):
                    break
                if ch in (8, 127, curses.KEY_BACKSPACE):
                    if buf:
                        buf.pop()
                elif 32 <= ch < 127:
                    buf.append(chr(ch))
        finally:
            curses.noecho()
            curses.curs_set(0)
        self.clear_message()
        return ''.join(buf)

    # =========================================================================
    # 描画：メイン
    # =========================================================================

    def draw_all(
        self,
        dungeon:  "Dungeon",
        player:   "Player",
        monsters: list = [],
        objects:  list = [],
    ) -> None:
        """マップ＋ステータスバーを一括描画する。"""
        if self.stdscr is None:
            return
        self.clear_message()
        self._draw_map(dungeon, player, monsters, objects)
        self._draw_status_bar(player)
        self.stdscr.refresh()

    # =========================================================================
    # 描画：マップ
    # =========================================================================

    def _is_visible(
        self, dungeon: "Dungeon", player: "Player", y: int, x: int
    ) -> bool:
        """座標 (y, x) がプレイヤーに現在見えるかを判定する。"""
        dy = abs(y - player.y)
        dx = abs(x - player.x)

        # 盲目: 自分のいるマスのみ
        if player.status.blind:
            return dy == 0 and dx == 0

        # 隣接マスは常に見える
        if dy <= 1 and dx <= 1:
            return True

        # プレイヤーが部屋内にいる場合は同じ部屋全体が見える（明るい部屋のみ）
        p_room = dungeon.find_room_at(player.y, player.x)
        if p_room is None or p_room.is_dark or p_room.is_maze:
            return False   # 通路 or 暗い部屋 or 迷路部屋: 隣接のみ

        # 暗い部屋でランプがあれば LAMPDIST 以内も見える
        # (将来: ランプアイテム実装後に拡張)

        # 同じ部屋のタイルは見える
        t_room = dungeon.find_room_at(y, x)
        if t_room is p_room:
            return True

        # 部屋の境界ドアも見える
        tile = dungeon.get_tile(y, x)
        return (
            tile.ch == CH_DOOR
            and p_room.top  <= y <= p_room.bottom
            and p_room.left <= x <= p_room.right
        )

    def _tile_attr(self, ch: str, visible: bool) -> int:
        """タイル文字と可視性からcurses表示属性を返す。"""
        if not visible:
            # 既訪問タイル: 薄く表示
            return self._cp(_CP_SEEN) | curses.A_DIM

        cp   = _TILE_CP.get(ch, _CP_DEFAULT)
        attr = self._cp(cp)

        # アイテム系は太字で強調
        if ch in ('!', '?', ':', ')', ']', '=', '/', ',', '$', '*', '%'):
            attr |= curses.A_BOLD
        elif ch == '#':
            attr |= curses.A_DIM

        return attr

    def _draw_map(
        self,
        dungeon:  "Dungeon",
        player:   "Player",
        monsters: list,
        objects:  list,
    ) -> None:
        """マップ部分（Row 1–22）を描画する。"""
        if self.stdscr is None:
            return

        # 位置インデックス構築（死亡済みモンスターは除外）
        mon_at: dict[tuple[int, int], object] = {
            (m.y, m.x): m for m in monsters if m.is_alive
        }
        obj_at: dict[tuple[int, int], str] = {
            (o.y, o.x): o.ch for o in objects
        }

        for y in range(self.MAP_TOP, self.MAP_BOT + 1):
            for x in range(80):
                tile    = dungeon.get_tile(y, x)
                visible = self._is_visible(dungeon, player, y, x)

                if visible:
                    tile_room = dungeon.find_room_at(y, x)
                    if tile_room is None or not tile_room.is_dark:
                        dungeon.mark_seen(y, x)

                seen    = bool(tile.flags & F_SEEN)

                if not visible and (not seen or player.status.blind):
                    self._addch(y, x, ' ')
                    continue

                # プレイヤー自身（不可視中は床タイルとして描画）
                if y == player.y and x == player.x:
                    if player.status.invisible:
                        ch = tile.ch if tile.ch else ' '
                        self._addch(y, x, ch, self._tile_attr(ch, visible))
                    else:
                        self._addch(
                            y, x, '@',
                            self._cp(_CP_PLAYER) | curses.A_BOLD,
                        )
                    continue

                if visible:
                    # モンスター（幻覚中はランダム大文字）
                    if (y, x) in mon_at:
                        m = mon_at[(y, x)]
                        # 不可視モンスター: see invisible がなければ描画しない
                        if (m.flags & ISINVIS) and not player.status.can_see_invisible:
                            pass  # fall through to tile drawing
                        else:
                            mch = m.ch
                            if player.status.hallucinating:
                                mch = chr(random.randint(ord('A'), ord('Z')))
                            self._addch(
                                y, x, mch,
                                self._cp(_CP_MONSTER) | curses.A_BOLD,
                            )
                            continue

                    # アイテム（幻覚中はランダムアイテム文字）
                    if (y, x) in obj_at:
                        och = obj_at[(y, x)]
                        if player.status.hallucinating:
                            och = random.choice('!?:)]=/')
                        cp = _TILE_CP.get(och, _CP_ITEM)
                        self._addch(
                            y, x, och,
                            self._cp(cp) | curses.A_BOLD,
                        )
                        continue

                # タイル本体（visible or seen）
                ch = tile.ch if tile.ch else ' '
                self._addch(y, x, ch, self._tile_attr(ch, visible))

    def _addch(self, y: int, x: int, ch: str, attr: int = 0) -> None:
        """curses.addch の安全ラッパー。右下端の例外を無視する。"""
        if self.stdscr is None:
            return
        try:
            self.stdscr.addch(y, x, ch, attr)
        except curses.error:
            pass   # 右下端への書き込みは無視

    # =========================================================================
    # 描画：ステータスバー
    # =========================================================================

    def _draw_status_bar(self, player: "Player") -> None:
        """Row 23 にステータスバーを描画する。"""
        if self.stdscr is None:
            return
        line = _fit(player.status_line(), 80)
        attr = self._cp(_CP_STATUS) | curses.A_BOLD
        try:
            self.stdscr.addstr(self.STATUS_ROW, 0, line, attr)
        except curses.error:
            pass
        # 空腹状態を目立つ色でハイライト描画（判定は英語のキー、表示は訳語）
        state = player.hunger_state
        if state:
            hunger = tr(state)
            if state == "Faint":
                h_attr = self._cp(_CP_MONSTER) | curses.A_BOLD | curses.A_REVERSE
            elif state == "Weak":
                h_attr = self._cp(_CP_MONSTER) | curses.A_BOLD
            else:  # Hungry
                h_attr = self._cp(_CP_GOLD) | curses.A_BOLD
            idx = line.find(hunger)
            col = text_width(line[:idx]) if idx >= 0 else -1
            if col >= 0:
                try:
                    self.stdscr.addstr(self.STATUS_ROW, col, hunger, h_attr)
                except curses.error:
                    pass

    # =========================================================================
    # インベントリ画面
    # =========================================================================

    def show_inventory(
        self,
        player:           "Player",
        title:            str  = "",
        type_filter:      str  = "",
        display_only:     bool = False,
        include_equipped: bool = False,
    ) -> Optional[str]:
        """
        インベントリ画面を表示し、選択されたスロット文字を返す。
        キャンセル（ESC）の場合は None を返す。

        type_filter: 絞り込む表示文字（空文字 = 全表示）
        """
        if self.stdscr is None:
            return None

        items = sorted(player.pack.items())
        if type_filter:
            items = [
                (ch, it) for ch, it in items
                if getattr(it, 'ch', '') == type_filter
                   or getattr(it, 'o_type', '') == type_filter
            ]

        # 装備中アイテム: include_equipped=True のときのみ表示・選択可能
        equip_slots: list[tuple[str, str]] = []
        if include_equipped:
            if player.weapon is not None:
                name = getattr(player.weapon, 'name', repr(player.weapon))
                equip_slots.append(('=', tr("Wielding: {name}", name=name)))
            if player.armor is not None:
                name = getattr(player.armor, 'name', repr(player.armor))
                equip_slots.append(('[', tr("Wearing:  {name}", name=name)))
            for slot_idx, ring in enumerate(player.rings):
                if ring is not None:
                    key  = '(' if slot_idx == 0 else ')'
                    name = getattr(ring, 'name', repr(ring))
                    label = (tr("Left ring: {name}", name=name) if slot_idx == 0
                             else tr("Right ring: {name}", name=name))
                    equip_slots.append((key, label))

        if not items and not equip_slots:
            self.add_message(tr('You are carrying nothing.'))
            self.flush_messages()
            return None

        # ヘッダ行数: タイトル + セパレータ + 装備スロット行 + 装備セパレータ
        header_rows = 2
        if equip_slots:
            header_rows += len(equip_slots) + 1

        # 1ページに表示できるアイテム数
        # row 22 をフッタ、row 21 をスクロール表示に使い、残りをアイテム領域とする
        page_size = 21 - header_rows

        valid_slots = {ch for ch, _ in items}
        if include_equipped:
            valid_slots |= {key for key, _ in equip_slots}

        offset = 0  # スクロールオフセット

        if display_only:
            footer = tr("── Press any key to continue ──")
        elif include_equipped:
            footer = tr("── Select slot (a–z / = [ ( )) or ESC ──")
        else:
            footer = tr("── ↑↓ to scroll  Select slot (a–w) or ESC ──")
        title = title or tr("Inventory")

        while True:
            self.stdscr.clear()
            row = 0

            # タイトル
            try:
                self.stdscr.addstr(row, 0, f" {title}", curses.A_BOLD)
            except curses.error:
                pass
            row += 1
            try:
                self.stdscr.addstr(row, 0, " " + "─" * 38)
            except curses.error:
                pass
            row += 1

            # 装備スロット (include_equipped=True のみ)
            for key, label in equip_slots:
                try:
                    self.stdscr.addstr(row, 0, f"  {key}) " + label)
                except curses.error:
                    pass
                row += 1
            if equip_slots:
                try:
                    self.stdscr.addstr(row, 0, " " + "─" * 38)
                except curses.error:
                    pass
                row += 1

            # パック内アイテム一覧 (スクロール対応)
            visible = items[offset:offset + page_size]
            for ch, item in visible:
                name = getattr(item, 'name', None) or getattr(item, 'ch', '?')
                flags = getattr(item, 'o_flags', 0)
                o_type = getattr(item, 'o_type', '')
                if o_type in (CH_FOOD, CH_GOLD, CH_AMULET):
                    unid = False
                elif o_type in (CH_WEAPON, CH_ARMOR):
                    unid = not bool(flags & ISKNOW)
                else:
                    unid = not get_knowledge().is_known(o_type, getattr(item, 'o_which', 0))
                try:
                    self.stdscr.addstr(row, 0, f"  {ch})  ")
                    self.stdscr.addstr(name, self._cp(_CP_GOLD) if unid else 0)
                except curses.error:
                    pass
                row += 1

            # スクロールインジケータ
            if offset > 0:
                try:
                    self.stdscr.addstr(21, 42, tr("(↑ more)"))
                except curses.error:
                    pass
            if offset + page_size < len(items):
                try:
                    self.stdscr.addstr(21, 52, tr("(↓ more)"))
                except curses.error:
                    pass

            try:
                self.stdscr.addstr(22, 0, f" {footer}")
            except curses.error:
                pass
            self.stdscr.refresh()

            inp = self._getch('more' if display_only else 'list', ''.join(sorted(valid_slots)))

            # スクロール操作
            if inp == curses.KEY_UP and offset > 0:
                offset -= 1
                continue
            if inp == curses.KEY_DOWN and offset + page_size < len(items):
                offset += 1
                continue
            if inp == curses.KEY_PPAGE:
                offset = max(0, offset - page_size)
                continue
            if inp == curses.KEY_NPAGE:
                offset = min(max(0, len(items) - page_size), offset + page_size)
                continue

            if display_only:
                return None

            if inp == 27:   # ESC
                return None
            try:
                c = chr(inp)
            except (ValueError, OverflowError):
                continue
            if c in valid_slots:
                return c

    # =========================================================================
    # アイテム検出表示（P_TFIND / S_FDET）
    # =========================================================================

    def show_all_objects(
        self,
        dungeon:     "Dungeon",
        player:      "Player",
        monsters:    list,
        floor_items: list,
        title_msg:   str = "",
    ) -> None:
        """
        全フロアアイテムをマップ上に重ねて表示し、キー入力待ちする。
        Rogue 5.4 P_TFIND / S_FDET 準拠。
        """
        if self.stdscr is None:
            return
        self.redraw(dungeon, player, monsters, floor_items)
        for fi in floor_items:
            och = getattr(fi, 'ch', None) or getattr(getattr(fi, 'item', fi), 'o_type', '?')
            item = getattr(fi, 'item', fi)
            ch = getattr(item, 'o_type', getattr(item, 'ch', '?'))
            y  = getattr(fi, 'y', getattr(item, 'y', None))
            x  = getattr(fi, 'x', getattr(item, 'x', None))
            if y is None or x is None:
                continue
            try:
                self.stdscr.addch(y, x, ch, self._cp(_CP_ITEM) | curses.A_BOLD | curses.A_REVERSE)
            except curses.error:
                pass
        title_msg = title_msg or tr("You sense the presence of objects.")
        if not floor_items:
            title_msg = tr("You sense no objects nearby.")
        try:
            self.stdscr.addstr(
                self.MSG_ROW, 0, _fit(self._with_more(title_msg)), curses.A_BOLD,
            )
        except curses.error:
            pass
        self.stdscr.refresh()
        self._wait_advance()

    # =========================================================================
    # モンスター検出表示（P_MFIND）
    # =========================================================================

    def show_all_monsters(
        self,
        dungeon:  "Dungeon",
        player:   "Player",
        monsters: list,
    ) -> None:
        """
        全モンスターをマップ上に重ねて表示し、キー入力待ちする。
        Rogue 5.4 P_MFIND 準拠: 壁越し・暗闇を無視して全モンスターを一時表示。
        """
        if self.stdscr is None:
            return
        self.redraw(dungeon, player, monsters, [])
        for m in monsters:
            if not m.is_alive:
                continue
            mch = m.ch
            if player.status.hallucinating:
                mch = chr(random.randint(ord('A'), ord('Z')))
            try:
                self.stdscr.addch(
                    m.y, m.x, mch,
                    self._cp(_CP_MONSTER) | curses.A_BOLD | curses.A_REVERSE,
                )
            except curses.error:
                pass
        try:
            self.stdscr.addstr(
                self.MSG_ROW, 0,
                _fit(self._with_more(tr("You can sense the presence of monsters."))),
                curses.A_BOLD,
            )
        except curses.error:
            pass
        self.stdscr.refresh()
        self._wait_advance()

    # =========================================================================
    # 情報画面
    # =========================================================================

    def show_help(self) -> None:
        """ヘルプ画面を表示し、キー待ちする。"""
        if self.stdscr is None:
            return
        self.stdscr.clear()
        for i, line in enumerate(_HELP_LINES):
            if i >= 23:
                break
            try:
                self.stdscr.addstr(i, 0, _fit(tr(line)).rstrip())
            except curses.error:
                pass
        self.stdscr.refresh()
        self._getch()

    def show_status(self, player: "Player") -> None:
        """プレイヤーのステータス詳細画面を表示する（'@' コマンド）。"""
        if self.stdscr is None:
            return
        self.stdscr.clear()
        try:
            self.stdscr.addstr(0, 0, tr(" Character Status"), curses.A_BOLD)
            self.stdscr.addstr(1, 0, " " + "─" * 30)
        except curses.error:
            pass
        for i, line in enumerate(player.detail_lines(), 2):
            try:
                self.stdscr.addstr(i, 0, line)
            except curses.error:
                pass
        try:
            self.stdscr.addstr(
                len(player.detail_lines()) + 3, 0, tr(" Press any key...")
            )
        except curses.error:
            pass
        self.stdscr.refresh()
        self._getch()

    def identify_symbol(self) -> None:
        """'/' コマンド: 入力されたシンボルの意味を説明する。"""
        ch = self.prompt_char(tr('What symbol would you like explained? '))
        if not ch:
            return
        if 'A' <= ch <= 'Z':
            desc = tr("A monster")
        else:
            desc = tr(_SYMBOL_DESC.get(ch, "Unknown symbol"))
        self.add_message(f"'{ch}' -- {desc}")
        self.flush_messages()

    def check_trap(self, dungeon: "Dungeon", player: "Player") -> None:
        """'^' コマンド: 足元のトラップを確認する。"""
        trap = dungeon.get_trap_at(player.y, player.x)
        if trap is not None and trap.known:
            _TRAP_NAMES = [
                "trap door", "arrow trap", "sleeping gas trap", "bear trap",
                "teleport trap", "dart trap", "rust trap", "mystery trap",
            ]
            name = tr_name('trap', _TRAP_NAMES[trap.which]
                           if 0 <= trap.which < len(_TRAP_NAMES) else "trap")
            self.add_message(tr('There is a {name} here!', name=name))
        else:
            self.add_message(tr("You don't see any traps."))
        self.flush_messages()

    # =========================================================================
    # ゲーム開始 / 終了画面
    # =========================================================================

    def name_entry_screen(self) -> str:
        """
        名前入力画面。最大 23 文字、Enter で確定。Tab で表示言語（英語 / 日本語）を切り替える。
        空のまま Enter した場合は空文字を返す。
        """
        if self.stdscr is None:
            return ''

        _MAX_NAME = 23
        buf: list[str] = []

        try:
            curses.curs_set(1)
        except curses.error:
            pass

        while True:
            self.stdscr.clear()
            for i, line in enumerate(_TITLE_BANNER):
                try:
                    self.stdscr.addstr(i + 3, 0, line, self._cp(_CP_PLAYER) | curses.A_BOLD)
                except curses.error:
                    pass

            prompt   = tr("  Enter your name: ")
            name_str = ''.join(buf)
            try:
                self.stdscr.addstr(12, 0, prompt, curses.A_BOLD)
                self.stdscr.addstr(12, text_width(prompt), name_str)
                self.stdscr.addstr(
                    14, 0,
                    tr("  (Up to {n} characters  |  Enter to confirm)", n=_MAX_NAME),
                )
                self.stdscr.addstr(16, 0, tr("  Tab: 日本語で遊ぶ"))
            except curses.error:
                pass

            try:
                self.stdscr.move(12, text_width(prompt) + text_width(name_str))
            except curses.error:
                pass

            self.stdscr.refresh()

            ch = self._getch('name')
            if ch in (10, 13):          # Enter
                break
            if ch == 9:                 # Tab: 言語切り替え
                set_lang('ja' if get_lang() == 'en' else 'en')
                continue
            if ch in (8, 127, curses.KEY_BACKSPACE):
                if buf:
                    buf.pop()
            elif (ch >= 32 and ch not in _SPECIAL_KEY_CODES and chr(ch).isprintable()
                  and len(buf) < _MAX_NAME):
                buf.append(chr(ch))   # 日本語の名前も入れられる（Windows Terminal の IME・スマホのキーボード）

        try:
            curses.curs_set(0)
        except curses.error:
            pass

        return ''.join(buf)

    def choose_language(self) -> bool:
        """'o' コマンド: 表示言語を切り替える。切り替えたら True。"""
        c = self.prompt_char(tr("Language: (e)nglish or (j)apanese? "), "ej")
        if not c:
            return False
        set_lang('ja' if c == 'j' else 'en')
        return True

    def title_screen(self) -> None:
        """タイトル画面を表示する。"""
        if self.stdscr is None:
            return
        self.stdscr.clear()
        lines = [""] + _TITLE_BANNER + [
            "",
            tr("     Explore the Dungeon of Doom."),
            tr("     Retrieve the Amulet of Yendor from floor 26."),
            "",
            tr("              Press any key to begin..."),
        ]
        for i, line in enumerate(lines):
            try:
                self.stdscr.addstr(i + 5, 0, line,
                                   self._cp(_CP_PLAYER) | curses.A_BOLD)
            except curses.error:
                pass
        self.stdscr.refresh()
        self._getch()

    def game_over(
        self,
        player: "Player",
        cause:  str  = "killed by a monster",
        rank:   int  = 0,
        scores: list = [],
    ) -> None:
        """
        ゲームオーバー画面を表示する。
          1ページ目: 死亡情報（死因・最終スコア・ランク通知）
          2ページ目: ハイスコア一覧
        """
        if self.stdscr is None:
            return
        score = player.gold + player.exp

        # ---- 死亡情報画面 ----
        self.stdscr.clear()
        lines = [
            tr("  You have died."),
            "",
            tr("  Cause:        {cause}", cause=tr_cause(cause)),
            "",
            tr("  Floor:        {n}", n=player.floor),
            tr("  Level:        {n}", n=player.level),
            tr("  Experience:   {n}", n=player.exp),
            tr("  Gold:         {n}", n=player.gold),
            tr("  Final Score:  {n}", n=score),
            "",
            (tr("  You placed #{rank} on the high score list!", rank=rank)
             if rank > 0
             else tr("  You did not make the high score list.")),
            "",
            tr("  Press any key to continue..."),
        ]
        for i, line in enumerate(lines, 5):
            if i >= 23:
                break
            try:
                self.stdscr.addstr(i, 0, line, curses.A_BOLD)
            except curses.error:
                pass
        self.stdscr.refresh()
        self._wait_advance()

        # ---- ハイスコア画面 ----
        if scores:
            self.show_high_scores(scores, highlight_rank=rank)

    def show_high_scores(self, scores: list, highlight_rank: int = 0) -> None:
        """
        ハイスコア一覧を表示してキー待ちする。
        highlight_rank > 0 の場合、その順位の行を強調表示する。
        scores は .score / .name / .cause / .floor / .gold を持つオブジェクトのリスト。
        """
        if self.stdscr is None:
            return
        self.stdscr.clear()

        sep = " " + "─" * 76
        hdr = (f"  {'#':>2}  {tr('Score'):>6}  {_fit(tr('Name'), 14)}  "
               f"{_fit(tr('Cause'), 26)}  {tr('Fl'):>2}  {tr('Gold'):>6}")

        row = 0
        for text, attr in [
            (tr(" Top 10 Rogues of the Dungeon of Doom"), curses.A_BOLD),
            (sep,  0),
            (hdr,  curses.A_UNDERLINE),
            (sep,  0),
        ]:
            try:
                self.stdscr.addstr(row, 0, _fit(text).rstrip(), attr)
            except curses.error:
                pass
            row += 1

        for i, e in enumerate(scores):
            if row >= 22:
                break
            rank_n = i + 1
            line = (f"  {rank_n:>2}  {e.score:>6}  {_fit(e.name, 14)}  "
                    f"{_fit(tr_cause(e.cause), 26)}  {e.floor:>2}  {e.gold:>6}")
            if rank_n == highlight_rank:
                attr = self._cp(_CP_GOLD) | curses.A_BOLD
            else:
                attr = 0
            try:
                self.stdscr.addstr(row, 0, _fit(line).rstrip(), attr)
            except curses.error:
                pass
            row += 1

        try:
            self.stdscr.addstr(
                min(row + 1, 23), 0,
                tr(" Press any key to exit..."),
                curses.A_BOLD,
            )
        except curses.error:
            pass
        self.stdscr.refresh()
        self._wait_advance()

    def win_screen(self, player: "Player") -> None:
        """アミュレットを持って地上に帰還した場合の勝利画面。"""
        if self.stdscr is None:
            return
        self.stdscr.clear()
        score = player.gold + player.level * 100 + player.exp
        lines = [
            tr("  Congratulations!"),
            "",
            tr("  You have retrieved the Amulet of Yendor"),
            tr("  and escaped the Dungeon of Doom!"),
            "",
            tr("  Final score:    {n}", n=score),
            tr("  Deepest floor:  {n}", n=player.floor),
            tr("  Level:          {n}", n=player.level),
            tr("  Gold:           {n}", n=player.gold),
            "",
            tr("  Press any key to exit."),
        ]
        for i, line in enumerate(lines, 5):
            try:
                self.stdscr.addstr(
                    i, 0, line,
                    self._cp(_CP_GOLD) | curses.A_BOLD,
                )
            except curses.error:
                pass
        self.stdscr.refresh()
        self._getch()

    def confirm_quit(self) -> bool:
        """'Q' コマンドの確認ダイアログ。'y' で True を返す。"""
        curses.flushinp()
        ch = self.prompt_char(tr('Do you really want to quit? (y/n) '), "yn")
        return ch == 'y'

    def confirm_save(self) -> bool:
        """'S' コマンドの確認ダイアログ。"""
        curses.flushinp()
        ch = self.prompt_char(tr('Save and quit? (y/n) '), "yn")
        return ch == 'y'

    # =========================================================================
    # 方向入力
    # =========================================================================

    def prompt_direction(self, msg: str = "") -> tuple[int, int]:
        """
        方向入力プロンプト。hjklyubn・矢印キー・テンキーから (dy, dx) を返す。
        ESC / スペース / Q でキャンセル → (0, 0) を返す。
        """
        _DIR_MAP: dict[str, tuple[int, int]] = {
            # vi キー
            'h': ( 0, -1), 'l': ( 0,  1),
            'k': (-1,  0), 'j': ( 1,  0),
            'y': (-1, -1), 'u': (-1,  1),
            'b': ( 1, -1), 'n': ( 1,  1),
            # テンキー NumLock ON（数字文字）
            '4': ( 0, -1), '6': ( 0,  1),
            '8': (-1,  0), '2': ( 1,  0),
            '7': (-1, -1), '9': (-1,  1),
            '1': ( 1, -1), '3': ( 1,  1),
        }
        self._raw_message(msg or tr("Which direction? "))
        while True:
            ch = self._getch('direction')
            if ch in (27, ord(' '), ord('Q')):
                self.clear_message()
                return (0, 0)
            # 矢印キー・テンキー NumLock OFF（整数コード）
            if ch in _INT_DIR_MAP:
                delta = _INT_DIR_MAP[ch]
                self.clear_message()
                return delta
            try:
                c = chr(ch)
            except (ValueError, OverflowError):
                continue
            if c in _DIR_MAP:
                self.clear_message()
                return _DIR_MAP[c]

    # =========================================================================
    # ユーティリティ
    # =========================================================================

    def redraw(
        self,
        dungeon:  "Dungeon",
        player:   "Player",
        monsters: list = [],
        objects:  list = [],
    ) -> None:
        """Ctrl-R: 画面全体を再描画する。"""
        if self.stdscr:
            self.stdscr.clear()
        self.draw_all(dungeon, player, monsters, objects)

    def flash(self) -> None:
        """画面フラッシュ（ダメージ報告など）。"""
        if self.stdscr:
            try:
                curses.flash()
            except curses.error:
                pass


# ---------------------------------------------------------------------------
# curses.wrapper 用エントリポイント
# ---------------------------------------------------------------------------

def run_with_curses(main_func) -> None:
    """
    curses.wrapper 相当の安全なラッパー。
    `main_func(ui: UI)` を呼び出す。例外時もターミナルを復元する。
    """
    import traceback as _tb
    ui = UI()
    try:
        ui.init()
        main_func(ui)
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception as _exc:
        # クラッシュ内容を画面に表示してからキー待ち
        try:
            if ui.stdscr:
                ui.stdscr.clear()
                lines = _tb.format_exc().splitlines()
                for i, line in enumerate(lines[:21]):
                    try:
                        ui.stdscr.addstr(i, 0, line[:79])
                    except curses.error:
                        pass
                try:
                    ui.stdscr.addstr(22, 0, tr(" The game stopped because of an error. The details are in error.log."))
                    ui.stdscr.addstr(23, 0, tr(" Press any key to exit..."))
                except curses.error:
                    pass
                ui.stdscr.refresh()
                ui.stdscr.getch()
        except Exception:
            pass
        with open("error.log", "a", encoding="utf-8") as _f:
            _f.write("=== crash ===\n")
            _tb.print_exc(file=_f)
        raise
    finally:
        ui.cleanup()
