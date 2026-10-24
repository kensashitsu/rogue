# ダンジョン・部屋・通路生成
"""
3×3 グリッドに最大9部屋を配置し、L字通路で接続する。
部屋ごとに ISDARK / ISMAZE / ISGONE フラグを付与する。
アイテム・モンスター配置位置はフロアレベルに応じてスケールする。
"""

import random
from dataclasses import dataclass, field

from constants import (
    # 画面文字
    CH_PASSAGE, CH_DOOR, CH_FLOOR, CH_STAIRS, CH_GOLD,
    CH_POTION, CH_SCROLL, CH_FOOD, CH_WEAPON, CH_ARMOR,
    CH_RING, CH_STICK, CH_AMULET, CH_TRAP,
    # 部屋フラグ
    ISDARK, ISGONE, ISMAZE,
    # マップフラグ
    F_PASS, F_SEEN, F_SECRETDOOR,
    # ゲームパラメータ
    AMULETLEVEL, MAXTHINGS, MAXOBJ, LVL_MONS,
    NTRAPS,
)
from items import (
    _THING_PROBS, _weighted_choice_tuples, _weighted_choice,
    POTION_INFO, SCROLL_INFO, WEAPON_INFO, ARMOR_INFO, RING_INFO, STICK_INFO,
)

# ---------------------------------------------------------------------------
# ダンジョン固定パラメータ
# ---------------------------------------------------------------------------
SCREEN_ROWS = 24           # ターミナル行数
SCREEN_COLS = 80           # ターミナル列数
TOP_MARGIN  = 1            # 上部ステータス行（使用分）
BOT_MARGIN  = 1            # 下部メッセージ行（使用分）
PLAY_ROWS   = SCREEN_ROWS - TOP_MARGIN - BOT_MARGIN  # 22 行

GRID_ROWS   = 3            # グリッド行数
GRID_COLS   = 3            # グリッド列数
MAXROOMS    = GRID_ROWS * GRID_COLS  # 9

SECT_H      = PLAY_ROWS  // GRID_ROWS   # 基本セクション高さ (7)
SECT_W      = SCREEN_COLS // GRID_COLS  # 基本セクション幅  (26)

ROOM_MIN_H  = 4            # 部屋最小高さ（壁を含む）
ROOM_MIN_W  = 4            # 部屋最小幅（壁を含む）


# 歩行可能なタイル文字セット
_WALKABLE = frozenset([
    CH_FLOOR, CH_PASSAGE, CH_DOOR, CH_STAIRS,
    CH_GOLD, CH_POTION, CH_SCROLL, CH_FOOD,
    CH_WEAPON, CH_ARMOR, CH_RING, CH_STICK, CH_AMULET,
    CH_TRAP,
])


# ===========================================================================
# データクラス
# ===========================================================================

@dataclass
class Coord:
    y: int
    x: int


@dataclass
class Tile:
    ch: str = ' '       # 表示文字
    flags: int = 0      # F_PASS / F_SEEN など


@dataclass
class Room:
    top: int    = 0
    left: int   = 0
    height: int = 0
    width: int  = 0
    flags: int  = 0     # ISDARK | ISGONE | ISMAZE
    doors: list = field(default_factory=list)  # list[Coord]

    # ---- 派生プロパティ ----
    @property
    def bottom(self) -> int:
        return self.top + self.height - 1

    @property
    def right(self) -> int:
        return self.left + self.width - 1

    @property
    def is_gone(self) -> bool:
        return bool(self.flags & ISGONE)

    @property
    def is_dark(self) -> bool:
        return bool(self.flags & ISDARK)

    @property
    def is_maze(self) -> bool:
        return bool(self.flags & ISMAZE)

    def random_floor(self, rng: random.Random) -> Coord:
        """部屋内部のランダムな床タイルを返す。"""
        y = rng.randint(self.top + 1, self.bottom - 1)
        x = rng.randint(self.left + 1, self.right - 1)
        return Coord(y, x)


@dataclass
class PlacedObject:
    """ダンジョン上に配置されたアイテム・金の情報（位置＋種別のみ）。"""
    ch: int      # 表示文字
    y: int
    x: int
    which: int = 0    # サブタイプ index（金の場合は gold value）


@dataclass
class PlacedMonster:
    """ダンジョン上に配置されたモンスターの情報（位置＋種別のみ）。"""
    ch: str      # モンスター文字
    y: int
    x: int


@dataclass
class PlacedTrap:
    """ダンジョン上に配置されたトラップ。"""
    y: int
    x: int
    which: int           # T_DOOR / T_ARROW / ... など
    known: bool = False  # プレイヤーに見えているか


# ===========================================================================
# Dungeon クラス
# ===========================================================================

class Dungeon:
    """
    1フロア分のダンジョン。

    生成後の主な公開属性:
      map           : list[list[Tile]]  ── 2D タイルマップ
      rooms         : list[Room]        ── 9 部屋（ISGONE を含む）
      stairs        : Coord             ── 階段位置
      objects       : list[PlacedObject]── アイテム・金の配置情報
      monsters      : list[PlacedMonster]─ モンスターの配置情報
      player_start  : Coord             ── プレイヤー初期位置
    """

    def __init__(self, floor_level: int, seed: int | None = None) -> None:
        self.floor_level = floor_level
        self.rng = random.Random(seed)

        # タイルマップ初期化
        self.map: list[list[Tile]] = [
            [Tile() for _ in range(SCREEN_COLS)]
            for _ in range(SCREEN_ROWS)
        ]

        self.rooms:        list[Room]          = []
        self.stairs:       Coord | None        = None
        self.objects:      list[PlacedObject]  = []
        self.monsters:     list[PlacedMonster] = []
        self.traps:        list[PlacedTrap]    = []
        self.player_start: Coord | None        = None
        self.sense_monsters = False   # 魔物検知の薬を飲んだ階（この階にいる間は敵の居場所が分かる）

        self._generate()

    # ------------------------------------------------------------------
    # 内部ユーティリティ
    # ------------------------------------------------------------------

    def _rnd(self, n: int) -> int:
        """[0, n-1] の一様乱数（Rogue 原作の rnd(n) に対応）。"""
        return self.rng.randint(0, max(0, n - 1))

    def _set(self, y: int, x: int, ch: str) -> None:
        if 0 <= y < SCREEN_ROWS and 0 <= x < SCREEN_COLS:
            self.map[y][x].ch = ch

    def _ch(self, y: int, x: int) -> str:
        if 0 <= y < SCREEN_ROWS and 0 <= x < SCREEN_COLS:
            return self.map[y][x].ch
        return ' '

    def _section_bounds(self, grid_r: int, grid_c: int) -> tuple[int, int, int, int]:
        """(top, left, height, width) を返す。端セクションは余りを吸収する。"""
        top  = TOP_MARGIN + grid_r * SECT_H
        left = grid_c * SECT_W

        if grid_r == GRID_ROWS - 1:
            h = (SCREEN_ROWS - BOT_MARGIN) - top
        else:
            h = SECT_H

        if grid_c == GRID_COLS - 1:
            w = SCREEN_COLS - left
        else:
            w = SECT_W

        return top, left, h, w

    def _real_rooms(self) -> list[Room]:
        return [r for r in self.rooms if not r.is_gone]

    def _random_real_room(self) -> Room:
        return self.rng.choice(self._real_rooms())

    # ------------------------------------------------------------------
    # メイン生成フロー
    # ------------------------------------------------------------------

    def _generate(self) -> None:
        self._place_rooms()
        self._connect_all()
        self._ensure_maze_connectivity()
        self._fix_diagonal_joints()
        self._place_stairs()
        self._place_gold()
        self._place_items()
        if self.floor_level >= AMULETLEVEL:
            self._place_amulet()
        self._place_monsters()
        self._place_monster_closets()
        self._place_traps()
        self._choose_player_start()

    # ------------------------------------------------------------------
    # 部屋配置
    # ------------------------------------------------------------------

    def _place_rooms(self) -> None:
        for grid_r in range(GRID_ROWS):
            for grid_c in range(GRID_COLS):
                idx  = grid_r * GRID_COLS + grid_c
                room = self._make_room(idx, grid_r, grid_c)
                self.rooms.append(room)
                if not room.is_gone:
                    self._draw_room(room)

    def _make_room(self, idx: int, grid_r: int, grid_c: int) -> Room:
        top, left, sh, sw = self._section_bounds(grid_r, grid_c)

        # 最初と最後の部屋は必ず存在させる（プレイヤー開始 / 階段保証）
        if idx not in (0, MAXROOMS - 1) and self._rnd(10) < 3:
            # ISGONE: 通路の中継点としてセクション中心1×1を使う
            cy = top  + sh // 2
            cx = left + sw // 2
            return Room(top=cy, left=cx, height=1, width=1, flags=ISGONE)

        # 部屋サイズをセクション内でランダムに決める
        max_h = sh - 2
        max_w = sw - 2
        rh = ROOM_MIN_H + self._rnd(max(1, max_h - ROOM_MIN_H + 1))
        rw = ROOM_MIN_W + self._rnd(max(1, max_w - ROOM_MIN_W + 1))
        rh = min(rh, max_h)
        rw = min(rw, max_w)

        # セクション内のランダムオフセット
        slack_h = max(0, max_h - rh)
        slack_w = max(0, max_w - rw)
        rt = top  + 1 + (self._rnd(slack_h + 1) if slack_h > 0 else 0)
        rl = left + 1 + (self._rnd(slack_w + 1) if slack_w > 0 else 0)

        # フラグ決定
        flags = 0
        if self.floor_level > 1 and self._rnd(10) < 2:
            flags |= ISDARK
        if self.floor_level > 5 and self._rnd(20) == 0:
            flags |= ISMAZE

        return Room(top=rt, left=rl, height=rh, width=rw, flags=flags)

    def _draw_room(self, room: Room) -> None:
        if room.is_maze:
            self._draw_maze(room)
            return

        # 上下の壁
        for c in range(room.left, room.right + 1):
            self._set(room.top,    c, '-')
            self._set(room.bottom, c, '-')
        # 左右の壁
        for r in range(room.top, room.bottom + 1):
            self._set(r, room.left,  '|')
            self._set(r, room.right, '|')
        # 床
        for r in range(room.top + 1, room.bottom):
            for c in range(room.left + 1, room.right):
                self._set(r, c, CH_FLOOR)

    def _draw_maze(self, room: Room) -> None:
        """
        部屋内部を iterative DFS（再帰バックトラッキング）で迷路化する。
        再帰深さを避けるためスタックを使う。
        """
        # 壁を描く（通常部屋と同じ外枠）
        for c in range(room.left, room.right + 1):
            self._set(room.top,    c, '-')
            self._set(room.bottom, c, '-')
        for r in range(room.top, room.bottom + 1):
            self._set(r, room.left,  '|')
            self._set(r, room.right, '|')

        r_min = room.top  + 1
        r_max = room.bottom - 1
        c_min = room.left + 1
        c_max = room.right - 1

        if r_min > r_max or c_min > c_max:
            return

        visited: set[tuple[int, int]] = set()
        DIRS = [(0, 2), (0, -2), (2, 0), (-2, 0)]

        # 開始セルは内部の奇数オフセット位置
        sr = r_min + (0 if (r_min % 2 == 1) else 1)
        sc = c_min + (0 if (c_min % 2 == 1) else 1)
        if not (r_min <= sr <= r_max and c_min <= sc <= c_max):
            sr, sc = r_min, c_min

        stack = [(sr, sc)]
        visited.add((sr, sc))
        self._set(sr, sc, CH_PASSAGE)

        while stack:
            cr, cc = stack[-1]
            dirs = list(DIRS)
            self.rng.shuffle(dirs)
            moved = False
            for dr, dc in dirs:
                nr, nc = cr + dr, cc + dc
                if (r_min <= nr <= r_max and c_min <= nc <= c_max
                        and (nr, nc) not in visited):
                    # 壁を通路で貫通
                    self._set(cr + dr // 2, cc + dc // 2, CH_PASSAGE)
                    self._set(nr, nc, CH_PASSAGE)
                    visited.add((nr, nc))
                    stack.append((nr, nc))
                    moved = True
                    break
            if not moved:
                stack.pop()

    # ------------------------------------------------------------------
    # 通路接続
    # ------------------------------------------------------------------

    def _fix_diagonal_joints(self) -> None:
        """
        通路の曲がり角が部屋の角などに当たって描けず、斜めにしかつながっていない所に通路を 1 マス足す。
        斜めの移動は diag_ok で角が壁・岩だと通れないので、そのままでは行けない所ができる（約 2000 階に 1 回）。
        """
        def joint(y: int, x: int) -> bool:   # 通路・扉（見つけていない隠し扉も）
            return self._ch(y, x) in (CH_PASSAGE, CH_DOOR) or bool(self.map[y][x].flags & F_SECRETDOOR)
        for y in range(1, SCREEN_ROWS - 2):
            for x in range(SCREEN_COLS - 1):
                if not joint(y, x):
                    continue
                for dx in (-1, 1):
                    ny, nx = y + 1, x + dx
                    if not (0 <= nx < SCREEN_COLS) or not joint(ny, nx):
                        continue
                    c1, c2 = (ny, x), (y, nx)   # 間の角
                    if self._ch(*c1) not in (' ', '-', '|') or self._ch(*c2) not in (' ', '-', '|'):
                        continue
                    if (self.map[c1[0]][c1[1]].flags | self.map[c2[0]][c2[1]].flags) & F_SECRETDOOR:
                        continue
                    for cy, cx in (c1, c2):
                        if self._ch(cy, cx) == ' ':
                            self._set(cy, cx, CH_PASSAGE)
                            self.map[cy][cx].flags |= F_PASS
                            break

    def _connect_all(self) -> None:
        """全部屋を接続する（横方向→縦方向）。"""
        # 同じグリッド行の隣接部屋を横方向に接続
        for gr in range(GRID_ROWS):
            for gc in range(GRID_COLS - 1):
                r1 = self.rooms[gr * GRID_COLS + gc]
                r2 = self.rooms[gr * GRID_COLS + gc + 1]
                self._connect_h(r1, r2)

        # 同じグリッド列の隣接部屋を縦方向に接続
        for gr in range(GRID_ROWS - 1):
            for gc in range(GRID_COLS):
                r1 = self.rooms[gr * GRID_COLS + gc]
                r2 = self.rooms[(gr + 1) * GRID_COLS + gc]
                self._connect_v(r1, r2)

    def _door_y(self, room: Room) -> int:
        """部屋の左右壁に開けるドアのY座標を返す。"""
        if room.is_gone:
            return room.top
        return self.rng.randint(room.top + 1, room.bottom - 1)

    def _door_x(self, room: Room) -> int:
        """部屋の上下壁に開けるドアのX座標を返す。"""
        if room.is_gone:
            return room.left
        return self.rng.randint(room.left + 1, room.right - 1)

    def _draw_passage(self, y: int, x: int) -> None:
        """空白セルにのみ通路を描く（既存の床・壁・部屋内部を上書きしない）。"""
        if self._ch(y, x) != ' ':
            return
        for room in self._real_rooms():
            if not room.is_maze and room.top < y < room.bottom and room.left < x < room.right:
                return
        self._set(y, x, CH_PASSAGE)
        self.map[y][x].flags |= F_PASS

    def _connect_h(self, r1: Room, r2: Room) -> None:
        """
        横方向に隣接する2部屋を L字通路で接続する。

        経路: r1右壁(ドア) → 水平 → mid_x → 垂直 → y2 → 水平 → r2左壁(ドア)

        ISGONE 部屋はドアを持たないため、中心セル自体を通路として描く。
        具体的には:
          - r1 が ISGONE の場合、水平区間を x1（中心列）から開始する
          - r2 が ISGONE の場合、水平区間を x2（中心列）まで含めて終了する
        これにより ISGONE 中心セルが必ず '#' で埋まり、隙間を防ぐ。
        """
        y1 = self._door_y(r1)
        y2 = self._door_y(r2)
        x1 = r1.right if not r1.is_gone else r1.left
        x2 = r2.left  if not r2.is_gone else r2.left

        if not r1.is_gone:
            self._set(y1, x1, CH_DOOR)
            r1.doors.append(Coord(y1, x1))
            if self._rnd(5) == 0:
                self._set(y1, x1, '|')
                self.map[y1][x1].flags |= F_SECRETDOOR
        if not r2.is_gone:
            self._set(y2, x2, CH_DOOR)
            r2.doors.append(Coord(y2, x2))
            if self._rnd(5) == 0:
                self._set(y2, x2, '|')
                self.map[y2][x2].flags |= F_SECRETDOOR

        # ギャップ内でミッドポイントを選ぶ
        gap_lo = x1 + 1
        gap_hi = x2 - 1
        if gap_hi < gap_lo:
            gap_hi = gap_lo
        mid_x = self.rng.randint(gap_lo, gap_hi)

        # 水平(右向き): r1 が ISGONE なら中心セル x1 自体から開始（ドアなし）
        #                r1 が実部屋なら x1 はドア済みなので x1+1 から開始
        x1_start = x1 if r1.is_gone else x1 + 1
        for x in range(x1_start, mid_x + 1):
            self._draw_passage(y1, x)

        # 垂直 y1 ↔ y2 の間（折れ曲がり列 mid_x を通る）
        y_lo, y_hi = (y1, y2) if y1 <= y2 else (y2, y1)
        for y in range(y_lo, y_hi + 1):
            self._draw_passage(y, mid_x)

        # 水平(右向き): r2 が ISGONE なら中心セル x2 自体まで含める（ドアなし）
        #                r2 が実部屋なら x2 はドア済みなので x2-1 まで（range末端 = x2）
        x2_end = x2 + 1 if r2.is_gone else x2
        for x in range(mid_x, x2_end):
            self._draw_passage(y2, x)

    def _connect_v(self, r1: Room, r2: Room) -> None:
        """
        縦方向に隣接する2部屋を L字通路で接続する。

        経路: r1下壁(ドア) → 垂直 → mid_y → 水平 → x2 → 垂直 → r2上壁(ドア)

        ISGONE 部屋はドアを持たないため、中心セル自体を通路として描く。
        具体的には:
          - r1 が ISGONE の場合、垂直区間を y1（中心行）から開始する
          - r2 が ISGONE の場合、垂直区間を y2（中心行）まで含めて終了する
        """
        x1 = self._door_x(r1)
        x2 = self._door_x(r2)
        y1 = r1.bottom if not r1.is_gone else r1.top
        y2 = r2.top    if not r2.is_gone else r2.top

        if not r1.is_gone:
            self._set(y1, x1, CH_DOOR)
            r1.doors.append(Coord(y1, x1))
            if self._rnd(5) == 0:
                self._set(y1, x1, '-')
                self.map[y1][x1].flags |= F_SECRETDOOR
        if not r2.is_gone:
            self._set(y2, x2, CH_DOOR)
            r2.doors.append(Coord(y2, x2))
            if self._rnd(5) == 0:
                self._set(y2, x2, '-')
                self.map[y2][x2].flags |= F_SECRETDOOR

        gap_lo = y1 + 1
        gap_hi = y2 - 1
        if gap_hi < gap_lo:
            gap_hi = gap_lo
        mid_y = self.rng.randint(gap_lo, gap_hi)

        # 垂直(下向き): r1 が ISGONE なら中心セル y1 自体から開始（ドアなし）
        #                r1 が実部屋なら y1 はドア済みなので y1+1 から開始
        y1_start = y1 if r1.is_gone else y1 + 1
        for y in range(y1_start, mid_y + 1):
            self._draw_passage(y, x1)

        # 水平 x1 ↔ x2 の間（折れ曲がり行 mid_y を通る）
        x_lo, x_hi = (x1, x2) if x1 <= x2 else (x2, x1)
        for x in range(x_lo, x_hi + 1):
            self._draw_passage(mid_y, x)

        # 垂直(下向き): r2 が ISGONE なら中心セル y2 自体まで含める（ドアなし）
        #                r2 が実部屋なら y2 はドア済みなので y2-1 まで（range末端 = y2）
        y2_end = y2 + 1 if r2.is_gone else y2
        for y in range(mid_y, y2_end):
            self._draw_passage(y, x2)

    def _ensure_maze_connectivity(self) -> None:
        """
        迷路部屋の扉と内部を確実に接続する。

        DFS はステップ2で動くため、扉の内側セルが DFS の偶奇ずれで到達されない
        ことがある。扉から部屋内側へ直線（縦 or 横）にトレースし、既存の通路セル
        に到達するまで ' ' をすべて CH_PASSAGE で埋める。これにより斜め接続が
        生じず、扉 → 迷路内部の縦横経路が常に保証される。
        """
        for room in self.rooms:
            if not room.is_maze:
                continue
            r_min = room.top  + 1
            r_max = room.bottom - 1
            c_min = room.left + 1
            c_max = room.right - 1
            for door in room.doors:
                dy, dx = door.y, door.x
                if dy == room.top:
                    for r in range(r_min, r_max + 1):
                        if self._ch(r, dx) == ' ':
                            self._set(r, dx, CH_PASSAGE)
                        else:
                            break
                elif dy == room.bottom:
                    for r in range(r_max, r_min - 1, -1):
                        if self._ch(r, dx) == ' ':
                            self._set(r, dx, CH_PASSAGE)
                        else:
                            break
                elif dx == room.left:
                    for c in range(c_min, c_max + 1):
                        if self._ch(dy, c) == ' ':
                            self._set(dy, c, CH_PASSAGE)
                        else:
                            break
                else:
                    for c in range(c_max, c_min - 1, -1):
                        if self._ch(dy, c) == ' ':
                            self._set(dy, c, CH_PASSAGE)
                        else:
                            break

    # ------------------------------------------------------------------
    # 階段・金・アイテム・モンスター配置
    # ------------------------------------------------------------------

    def _place_stairs(self) -> None:
        """ランダムな非 ISGONE 部屋の床に階段を配置する。"""
        pos = self._find_floor()
        if pos:
            self._set(pos.y, pos.x, CH_STAIRS)
            self.stairs = pos

    def _place_gold(self) -> None:
        """各実部屋に 50% の確率で金を配置する。"""
        for room in self._real_rooms():
            if self._rnd(2) == 0:
                continue
            pos = self._find_floor_in(room)
            if pos is None:
                continue
            gold_val = self._rnd(50 + 10 * self.floor_level) + 2
            self._set(pos.y, pos.x, CH_GOLD)
            self.objects.append(PlacedObject(CH_GOLD, pos.y, pos.x, gold_val))

    def _place_items(self) -> None:
        """フロアレベルに応じた数のアイテムをランダムに配置する。"""
        n = min(MAXOBJ, self._rnd(4) + self.floor_level // 3 + 2)
        for _ in range(n):
            pos = self._find_floor()
            if pos is None:
                continue
            ch = _weighted_choice_tuples(_THING_PROBS)
            which = self._item_which(ch)
            self._set(pos.y, pos.x, ch)
            self.objects.append(PlacedObject(ch, pos.y, pos.x, which))

    def _place_amulet(self) -> None:
        """AMULETLEVEL 以降のフロアにアミュレットを配置する。"""
        pos = self._find_floor()
        if pos:
            self._set(pos.y, pos.x, CH_AMULET)
            self.objects.append(PlacedObject(CH_AMULET, pos.y, pos.x, 0))

    def _place_monsters(self) -> None:
        """フロアレベルに応じた数のモンスターをランダムに配置する。"""
        n = min(MAXTHINGS, self._rnd(4) + self.floor_level // 4 + 2)
        for _ in range(n):
            pos = self._find_floor()
            if pos is None:
                continue
            ch = self._rand_monster()
            self.monsters.append(PlacedMonster(ch, pos.y, pos.x))

    def _place_monster_closets(self) -> None:
        """モンスタークローゼット: 1部屋をモンスターとアイテムで満たす。"""
        if self.floor_level < 5 or self._rnd(5) != 0:
            return
        rooms = self._real_rooms()
        if not rooms:
            return
        room = self.rng.choice(rooms)
        for _ in range(3 + self._rnd(3)):
            pos = self._find_floor_in(room)
            if pos is None:
                break
            self.monsters.append(PlacedMonster(self._rand_monster(), pos.y, pos.x))
        for _ in range(1 + self._rnd(3)):
            pos = self._find_floor_in(room)
            if pos is None:
                break
            ch = _weighted_choice_tuples(_THING_PROBS)
            self._set(pos.y, pos.x, ch)
            self.objects.append(PlacedObject(ch, pos.y, pos.x, self._item_which(ch)))

    def _place_traps(self) -> None:
        """フロアにトラップをランダム配置する（隠し状態）。"""
        n = 1 + self._rnd(NTRAPS // 2)
        for _ in range(n):
            pos = self._find_floor()
            if pos is None:
                continue
            which = self._rnd(NTRAPS)
            self.traps.append(PlacedTrap(pos.y, pos.x, which))

    def _item_which(self, ch: str) -> int:
        if ch == CH_POTION: return _weighted_choice(POTION_INFO)
        if ch == CH_SCROLL: return _weighted_choice(SCROLL_INFO)
        if ch == CH_WEAPON: return _weighted_choice(WEAPON_INFO)
        if ch == CH_ARMOR:  return _weighted_choice(ARMOR_INFO)
        if ch == CH_RING:   return _weighted_choice(RING_INFO)
        if ch == CH_STICK:  return _weighted_choice(STICK_INFO)
        if ch == CH_FOOD:   return 1 if self.rng.randint(0, 9) == 0 else 0
        return 0

    def _rand_monster(self) -> str:
        """
        原作の randmonster() に準拠したモンスター選択。
        d = level + rnd(10) - 6、範囲外は端に丸める。
        """
        d = self.floor_level + self._rnd(10) - 6
        if d < 0:
            d = self._rnd(5)
        elif d > 25:
            d = self._rnd(5) + 21
        d = max(0, min(d, len(LVL_MONS) - 1))
        return LVL_MONS[d]

    # ------------------------------------------------------------------
    # プレイヤー開始位置
    # ------------------------------------------------------------------

    def _choose_player_start(self) -> None:
        """階段・モンスターと被らない床タイルをプレイヤー初期位置に選ぶ。"""
        monster_pos = {(m.y, m.x) for m in self.monsters}
        def _blocked(pos: "Coord") -> bool:
            if (pos.y, pos.x) in monster_pos:
                return True
            if self.stairs and (pos.y, pos.x) == (self.stairs.y, self.stairs.x):
                return True
            return False

        for _ in range(100):
            pos = self._find_floor()
            if pos and not _blocked(pos):
                self.player_start = pos
                return
        # フォールバック: マップ全体で最初に見つかった空き床
        for r in range(SCREEN_ROWS):
            for c in range(SCREEN_COLS):
                if self.map[r][c].ch == CH_FLOOR and (r, c) not in monster_pos:
                    self.player_start = Coord(r, c)
                    return

    # ------------------------------------------------------------------
    # 床タイル探索ヘルパー
    # ------------------------------------------------------------------

    def _find_floor(self) -> "Coord | None":
        """ランダムな実部屋から空き床タイルを探す。最大50回試行。"""
        for _ in range(50):
            room = self._random_real_room()
            pos  = room.random_floor(self.rng)
            if self._ch(pos.y, pos.x) == CH_FLOOR:
                return pos
        return None

    def _find_floor_in(self, room: Room) -> "Coord | None":
        """指定部屋から空き床タイルを探す。最大20回試行。"""
        for _ in range(20):
            pos = room.random_floor(self.rng)
            if self._ch(pos.y, pos.x) == CH_FLOOR:
                return pos
        return None

    # ------------------------------------------------------------------
    # 公開 API
    # ------------------------------------------------------------------

    def get_tile(self, y: int, x: int) -> Tile:
        return self.map[y][x]

    def mark_seen(self, y: int, x: int) -> None:
        self.map[y][x].flags |= F_SEEN

    def is_walkable(self, y: int, x: int) -> bool:
        return self._ch(y, x) in _WALKABLE

    def diag_ok(self, sy: int, sx: int, ey: int, ex: int) -> bool:
        """
        5.4 diag_ok: 斜めに動く・殴るときは、間の角の 2 マスが両方とも壁・岩でないこと。
        扉の口から斜めに出入りできず、壁越しに斜めの相手と殴り合えない。
        """
        if sy == ey or sx == ex:
            return True
        return self._ch(ey, sx) not in (' ', '-', '|') and self._ch(sy, ex) not in (' ', '-', '|')

    def find_room_at(self, y: int, x: int) -> "Room | None":
        """座標 (y, x) を含む部屋を返す。"""
        for room in self._real_rooms():
            if room.top <= y <= room.bottom and room.left <= x <= room.right:
                return room
        return None

    def search(self, py: int, px: int) -> list[Coord]:
        """隣接8マスの隠し扉を1枚発見したら CH_DOOR に変えて返す。"""
        found: list[Coord] = []
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                if dy == 0 and dx == 0:
                    continue
                y, x = py + dy, px + dx
                if 0 <= y < SCREEN_ROWS and 0 <= x < SCREEN_COLS:
                    if self.map[y][x].flags & F_SECRETDOOR:
                        self.map[y][x].flags &= ~F_SECRETDOOR
                        self._set(y, x, CH_DOOR)
                        self.mark_seen(y, x)
                        found.append(Coord(y, x))
        return found

    def search_traps(self, py: int, px: int) -> list["PlacedTrap"]:
        """隣接9マス（自分含む）の隠しトラップを発見する（発動しない）。"""
        found: list[PlacedTrap] = []
        for trap in self.traps:
            if trap.known:
                continue
            if abs(trap.y - py) <= 1 and abs(trap.x - px) <= 1:
                trap.known = True
                self._set(trap.y, trap.x, CH_TRAP)
                found.append(trap)
        return found

    def get_trap_at(self, y: int, x: int) -> "PlacedTrap | None":
        """座標 (y, x) にあるトラップを返す。"""
        for trap in self.traps:
            if trap.y == y and trap.x == x:
                return trap
        return None

    def teleport_player(self, cur_y: int = -1, cur_x: int = -1) -> Coord:
        """テレポート: 現在地を除いたランダムな床タイルを返す。"""
        for _ in range(100):
            pos = self._find_floor()
            if pos is None:
                break
            if pos.y == cur_y and pos.x == cur_x:
                continue
            return pos
        # フォールバック: マップ全体から現在地以外の床を探す
        for r in range(SCREEN_ROWS):
            for c in range(SCREEN_COLS):
                if self.map[r][c].ch == CH_FLOOR and not (r == cur_y and c == cur_x):
                    return Coord(r, c)
        return Coord(TOP_MARGIN + 1, 1)

    def teleport_monster(self, my: int, mx: int, monsters: list) -> "Coord | None":
        """モンスター用テレポート: 元の位置・他のモンスターと重ならない床タイルを返す。"""
        for _ in range(100):
            pos = self._find_floor()
            if pos is None:
                break
            if pos.y == my and pos.x == mx:
                continue
            occupied = any(
                getattr(m, 'y', None) == pos.y and getattr(m, 'x', None) == pos.x
                and getattr(m, 'is_alive', False)
                for m in monsters
            )
            if not occupied:
                return pos
        return None

    def find_empty_floor(self, occupied: "set[tuple[int,int]]") -> "Coord | None":
        """スポーン用: 指定座標セットと重ならない空き床タイルを探す。"""
        for _ in range(100):
            pos = self._find_floor()
            if pos and (pos.y, pos.x) not in occupied:
                return pos
        return None

    def render_ascii(self, player: "Coord | None" = None) -> str:
        """マップ全体をASCII文字列で返す（デバッグ・テスト用）。"""
        grid = [[t.ch for t in row] for row in self.map]

        # モンスター・アイテムを重ねて表示
        for obj in self.objects:
            grid[obj.y][obj.x] = obj.ch
        for mon in self.monsters:
            grid[mon.y][mon.x] = mon.ch
        if player:
            grid[player.y][player.x] = '@'

        return '\n'.join(''.join(row) for row in grid)

    def __repr__(self) -> str:
        real  = len(self._real_rooms())
        dark  = sum(1 for r in self._real_rooms() if r.is_dark)
        maze  = sum(1 for r in self._real_rooms() if r.is_maze)
        return (
            f"<Dungeon floor={self.floor_level} "
            f"rooms={real}(dark={dark},maze={maze}) "
            f"objects={len(self.objects)} monsters={len(self.monsters)}>"
        )


# ===========================================================================
# 公開ファクトリ関数
# ===========================================================================

def new_level(floor_level: int, seed: int | None = None) -> Dungeon:
    """指定フロアレベルのダンジョンを生成して返す。"""
    return Dungeon(floor_level, seed)


# ===========================================================================
# 通路品質検証（デバッグ用）
# ===========================================================================

def _verify_passages(dungeon: "Dungeon") -> list[str]:
    """
    生成済みダンジョンの通路を検査し、問題点のリストを返す。
    問題がなければ空リストを返す。

    検査内容:
      1. 斜め接続のみの孤立通路セル
         '#' セルの上下左右に歩行可能セルが1つもない場合、
         その '#' は斜め方向にしか接続されていない。
      2. ISGONE 部屋中心の未描画
         ISGONE 部屋の中心セルが ' '（未描画）のまま残っている場合。
    """
    PASSABLE = frozenset('.#%+!?:)]=/*,')
    issues: list[str] = []

    # 検査1: 孤立（斜めのみ接続）通路セル
    for y in range(1, SCREEN_ROWS - 1):
        for x in range(1, SCREEN_COLS - 1):
            if dungeon.map[y][x].ch != CH_PASSAGE:
                continue
            ortho_ok = any(
                dungeon.map[y + dy][x + dx].ch in PASSABLE
                for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1))
                if 0 <= y + dy < SCREEN_ROWS and 0 <= x + dx < SCREEN_COLS
            )
            if not ortho_ok:
                issues.append(
                    f"孤立通路セル(斜め接続のみ) at ({y},{x})"
                )

    # 検査2: ISGONE 中心セルが未描画
    for r in dungeon.rooms:
        if r.is_gone and dungeon.map[r.top][r.left].ch == ' ':
            issues.append(
                f"ISGONE 中心セル未描画 at ({r.top},{r.left})"
            )

    return issues


def verify_all_floors(
    floors: int = 26,
    seeds_per_floor: int = 20,
) -> bool:
    """
    全フロア × 複数シードでダンジョンを生成し、通路品質を検証する。

    Returns:
        True  = 問題なし
        False = 問題あり（標準出力に詳細を表示）
    """
    ok = True
    for fl in range(1, floors + 1):
        for seed in range(seeds_per_floor):
            d = Dungeon(fl, seed)
            issues = _verify_passages(d)
            if issues:
                ok = False
                for msg in issues:
                    print(f"Floor {fl:2d} seed={seed:2d}: {msg}")
    if ok:
        print(f"OK: 全 {floors} フロア × {seeds_per_floor} シードで問題なし")
    return ok
