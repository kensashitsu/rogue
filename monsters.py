# モンスター定義・AI
"""
Rogue 5.4 準拠のモンスター定義と AI。

モンスターの種別フラグは data/monsters.json の creature_flags を使用する。
モンスター出現順は data/monsters.json の lvl_mons に準拠する（26文字）。
HP は Rogue 5.4 の new_monster 公式に従い roll(s_lvl, 8) で決定する。
AMULETLEVEL(26) 超階層では s_lvl・s_arm・s_exp をスケールする。
"""

from __future__ import annotations

import random
import re as _re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

from i18n import tr, name as tr_name
from constants import (
    # クリーチャーフラグ
    ISMEAN, ISFLY, ISGREED, ISRUN, ISHASTE, ISSLOW,
    ISFOUND, ISHUH, ISINVIS, ISREGEN, ISLEVIT, ISHELD, CANHUH, ISCANC,
    # ゲームパラメータ
    AMULETLEVEL, LVL_MONS, WAND_MONS,
    LAMPDIST, BOLT_LENGTH,
    # タイミング（spread() 形式は _TIMING_RAW から解析）
    _TIMING_RAW,
)
from combat import (
    CombatResult,
    roll, roll_damage, calc_exp,
    player_attacks_monster, monster_attacks_player, dragon_breath,
)

if TYPE_CHECKING:
    from dungeon import Dungeon
    from player  import Player


# ---------------------------------------------------------------------------
# spread(n) ヘルパー（data/monsters.json timing_constants 準拠）
# ---------------------------------------------------------------------------

def _spread(n: int) -> int:
    """Rogue 5.4 misc.c spread(nm) = nm - nm/20 + rnd(nm/10)（±5% の揺らぎ）。"""
    return n - n // 20 + (random.randint(0, n // 10 - 1) if n >= 10 else 0)


def _get_spread(name: str, default: int = 70) -> int:
    """_TIMING_RAW から spread(N) 定数を取得し乱数値を返す。"""
    raw = _TIMING_RAW.get(name, f"spread({default})")
    m   = _re.match(r'spread\((\d+)\)', raw)
    return _spread(int(m.group(1))) if m else default


# ---------------------------------------------------------------------------
# Chebyshev 距離（モンスター AI 用）
# ---------------------------------------------------------------------------

def _cheby(y1: int, x1: int, y2: int, x2: int) -> int:
    return max(abs(y2 - y1), abs(x2 - x1))


# ===========================================================================
# MonsterStats: 種別固定ステータス（Rogue 5.4 monst.c 準拠）
# ===========================================================================

@dataclass(frozen=True)
class MonsterStats:
    name:   str
    carry:  int   # アイテムを持つ確率 [%]
    flags:  int   # 初期 creature_flags
    level:  int   # 基本レベル（HP ロール・命中にも使用）
    exp:    int   # 基本経験値
    ac:     int   # アーマークラス（低い＝硬い）
    damage: str   # ダメージ文字列 "NxS/NxS"


# ---------------------------------------------------------------------------
# 26種モンスター定義（Rogue 5.4.4 extern.c monsters[] の値を LVL_MONS 順に並べたもの）
# ---------------------------------------------------------------------------

MONSTER_DB: dict[str, MonsterStats] = {
    'K': MonsterStats("Kestrel",          0, ISMEAN | ISFLY,                1,    1,   7, "1x4"),
    'E': MonsterStats("Emu",              0, ISMEAN,                        1,    2,   7, "1x2"),
    'B': MonsterStats("Bat",              0, ISFLY,                         1,    1,   3, "1x2"),
    'S': MonsterStats("Snake",            0, ISMEAN,                        1,    2,   5, "1x3"),
    'H': MonsterStats("Hobgoblin",        0, ISMEAN,                        1,    3,   5, "1x8"),
    'I': MonsterStats("Ice Monster",      0, 0,                             1,    5,   9, "0x0"),
    'R': MonsterStats("Rattlesnake",      0, ISMEAN,                        2,    9,   3, "1x6"),
    'O': MonsterStats("Orc",             15, ISGREED,                       1,    5,   6, "1x8"),
    'Z': MonsterStats("Zombie",           0, ISMEAN,                        2,    6,   8, "1x8"),
    'L': MonsterStats("Leprechaun",       0, 0,                             3,   10,   8, "1x1"),
    'C': MonsterStats("Centaur",         15, 0,                             4,   17,   4, "1x2/1x5/1x5"),
    'Q': MonsterStats("Quagga",           0, ISMEAN,                        3,   15,   3, "1x5/1x5"),
    'A': MonsterStats("Aquator",          0, ISMEAN,                        5,   20,   2, "0x0/0x0"),
    'N': MonsterStats("Nymph",          100, 0,                             3,   37,   9, "0x0"),
    'Y': MonsterStats("Yeti",            30, 0,                             4,   50,   6, "1x6/1x6"),
    'F': MonsterStats("Venus Flytrap",    0, ISMEAN,                        8,   80,   3, "0x0"),
    'T': MonsterStats("Troll",           50, ISMEAN | ISREGEN,              6,  120,   4, "1x8/1x8/2x6"),
    'W': MonsterStats("Wraith",           0, 0,                             5,   55,   4, "1x6"),
    'P': MonsterStats("Phantom",          0, ISINVIS,                       8,  120,   3, "4x4"),
    'X': MonsterStats("Xeroc",           30, 0,                             7,  100,   7, "4x4"),
    'U': MonsterStats("Black Unicorn",    0, ISMEAN,                        7,  190,  -2, "1x9/1x9/2x9"),
    'M': MonsterStats("Medusa",          40, ISMEAN,                        8,  200,   2, "3x4/3x4/2x5"),
    'V': MonsterStats("Vampire",         20, ISMEAN | ISREGEN,              8,  350,   1, "1x10"),
    'G': MonsterStats("Griffin",         20, ISMEAN | ISFLY | ISREGEN,     13, 2000,   2, "4x3/3x5"),
    'J': MonsterStats("Jabberwock",      70, 0,                            15, 3000,   6, "2x12/2x4"),
    'D': MonsterStats("Dragon",         100, ISMEAN,                       10, 5000,  -1, "1x8/1x8/3x10"),
}

# Xeroc が変装に使う文字セット
_XEROC_CHARS = list("!?:)]=/$,")


# ===========================================================================
# Monster: フロア上の個々のモンスター
# ===========================================================================

@dataclass
class Monster:
    """フロア上に存在する 1 体のモンスター。"""

    letter:   str        # モンスター種別文字
    y:        int
    x:        int
    hp:       int
    max_hp:   int
    level:    int        # 実レベル（深階では基本 + lev_add）
    ac:       int        # 実アーマークラス
    exp:      int        # 撃破時基本経験値（exp_add は calc_exp で加算）
    flags:    int        # 現在の creature_flags

    # 付帯状態
    has_item:      bool = False   # アイテムを所持しているか
    disguise_ch:   str  = ''     # Xeroc の変装文字
    wander_timer:  int  = 0      # 次の徘徊移動までの残ターン

    stolen_gold:   int  = 0              # 盗んだ金塊量（キル時にドロップ）
    stolen_item:   object = field(default=None, repr=False)  # Nymph が盗んだアイテム（キル時にドロップ）

    # スロー用カウンター
    _slow_skip:    bool = field(default=False, repr=False)
    # 拘束残りターン数（0 = 拘束なし）
    _held_turns:   int  = field(default=0,     repr=False)
    # 混乱残りターン数（0 = 混乱なし）
    _huh_turns:    int  = field(default=0,     repr=False)

    # ---- 読み取り専用プロパティ ----

    @property
    def name(self) -> str:
        return tr_name('monster', MONSTER_DB[self.letter].name)

    @property
    def damage(self) -> str:
        return MONSTER_DB[self.letter].damage

    @property
    def is_alive(self) -> bool:
        return self.hp > 0

    @property
    def is_awake(self) -> bool:
        return bool(self.flags & ISRUN)

    @property
    def is_mean(self) -> bool:
        return bool(self.flags & ISMEAN)

    @property
    def is_flying(self) -> bool:
        return bool(self.flags & ISFLY)

    @property
    def is_greedy(self) -> bool:
        return bool(self.flags & ISGREED)

    @property
    def can_confuse(self) -> bool:
        """Medusa の目つき（5.4 では種別 'M' で判定し、フラグは持たない）。"""
        return self.letter == 'M'

    @property
    def regenerates(self) -> bool:
        return bool(self.flags & ISREGEN)

    @property
    def is_hasted(self) -> bool:
        return bool(self.flags & ISHASTE)

    @property
    def is_slowed(self) -> bool:
        return bool(self.flags & ISSLOW)

    def display_name(self, can_see_invisible: bool) -> str:
        """不可視かつ看破できない場合は "something" を返す。"""
        if (self.flags & ISINVIS) and not can_see_invisible:
            return tr('something')
        return self.name

    @property
    def display_ch(self) -> str:
        """描画に使う文字。Xeroc は変装中は disguise_ch を返す。"""
        if self.letter == 'X' and self.disguise_ch:
            return self.disguise_ch
        return self.letter

    @property
    def ch(self) -> str:
        """ui.py の draw_all が参照する描画文字（display_ch のエイリアス）。"""
        return self.display_ch

    # =========================================================================
    # AI メインループ
    # =========================================================================

    def do_turn(
        self,
        dungeon:     "Dungeon",
        player:      "Player",
        monsters:    list["Monster"],
        floor_items: list = [],
    ) -> list[str]:
        """
        1 ターンの AI 処理。
        monster.hp / player.hp / player.status を直接変更することがある。
        返り値: 表示すべきメッセージのリスト。
        """
        if not self.is_alive:
            return []

        msgs: list[str] = []

        # ---- 混乱タイマー（ISHUH）----
        if self._huh_turns > 0:
            self._huh_turns -= 1
            if self._huh_turns == 0:
                self.flags &= ~ISHUH

        # ---- 拘束タイマー（ISHELD）----
        if self._held_turns > 0:
            self._held_turns -= 1
            if self._held_turns == 0:
                self.flags &= ~ISHELD
            return msgs

        # ---- hold monster で止められている（攻撃されるまで動かない: 5.4 chase.c）----
        if self.flags & ISHELD:
            return msgs

        # ---- 自動再生 ----
        if self.regenerates and self.hp < self.max_hp:
            self.hp = min(self.max_hp, self.hp + 1)

        # ---- 減速: 1 ターン置きにスキップ ----
        if self.is_slowed:
            self._slow_skip = not self._slow_skip
            if self._slow_skip:
                return msgs

        # ---- 起床判定 ----
        if not self.is_awake:
            if self._should_wake(dungeon, player):
                self.flags |= ISRUN
                self.flags |= ISFOUND

        # ---- Medusa の目つき（隣接時・プレイヤーが視認できる場合） ----
        if self.is_awake and self.can_confuse and not (self.flags & ISCANC):
            msgs.extend(self._medusa_gaze(dungeon, player))

        # ---- 行動 ----
        if self.is_awake:
            msgs.extend(self._act(dungeon, player, monsters, floor_items))

        # ---- 加速: もう 1 回行動 ----
        if self.is_hasted and self.is_awake and self.is_alive and player.is_alive:
            msgs.extend(self._act(dungeon, player, monsters, floor_items))

        return msgs

    # =========================================================================
    # 起床判定
    # =========================================================================

    def _should_wake(
        self,
        dungeon: "Dungeon",
        player:  "Player",
    ) -> bool:
        """
        Rogue 5.4 wake_monster 準拠:
          ISMEAN かつ同室にプレイヤーがいる → 2/3 の確率で目覚める。
          隣接している場合は必ず目覚める。
        """
        # 隣接: CANSEE または可視プレイヤーなら必ず起床
        if _cheby(self.y, self.x, player.y, player.x) <= 1:
            if (not player.status.invisible) or (self.flags & CANSEE):
                return True

        if not self.is_mean:
            return False

        # 浮遊中のプレイヤーには ISMEAN モンスターが反応しない
        if player.status.is_levitating:
            return False

        # 同室かチェック
        my_room = dungeon.find_room_at(self.y, self.x)
        pl_room = dungeon.find_room_at(player.y, player.x)
        if my_room is None or pl_room is None or my_room is not pl_room:
            return False

        # プレイヤーがステルスリングを装備していれば起床しにくい
        from constants import R_STEALTH
        has_stealth = any(
            getattr(r, 'o_which', -1) == R_STEALTH
            for r in player.rings if r is not None
        )
        if has_stealth:
            return False

        # 2/3 の確率で起床
        return random.randint(0, 2) != 0

    # =========================================================================
    # Medusa の目つき
    # =========================================================================

    def _medusa_gaze(
        self,
        dungeon: "Dungeon",
        player:  "Player",
    ) -> list[str]:
        """
        Medusa が隣接かつ ISFOUND でない状態で初めて見られたとき、
        プレイヤーは VS_MAGIC セーブ or 混乱（HUHDURATION - CONFUSE_CUT ターン）。
        """
        if self.flags & ISFOUND:
            return []
        if _cheby(self.y, self.x, player.y, player.x) > LAMPDIST:
            return []
        if player.status.blind or player.status.hallucinating:
            return []

        self.flags |= ISFOUND
        from combat import save_throw
        from constants import VS_MAGIC, HUHDURATION, CONFUSE_CUT
        if not save_throw(player.level, VS_MAGIC, player.protect_bonus):
            player.apply_confusion(HUHDURATION - CONFUSE_CUT)   # 5.4: HUHDURATION
            return [
                tr("You are confused by the Medusa's hideous visage!")
            ]
        return []

    # =========================================================================
    # 行動（移動 or 攻撃）
    # =========================================================================

    def _act(
        self,
        dungeon:     "Dungeon",
        player:      "Player",
        monsters:    list["Monster"],
        floor_items: list = [],
    ) -> list[str]:
        msgs: list[str] = []

        # Dragon: 同室・一直線・射程内なら 1/5 で炎を吐く（5.4 chase.c）
        if self.letter == 'D' and self._can_breathe(dungeon, player, monsters) \
                and random.randint(0, 4) == 0:
            msgs.append(tr('The Dragon breathes fire!'))
            msgs.extend(dragon_breath(player))
            return msgs

        # 隣接 → 攻撃（不可視プレイヤーには CANSEE 持ちのみ攻撃可）
        # 斜めに隣り合っていても、間の角が壁・岩なら殴れない（5.4 diag_ok）。回り込んでくる
        adjacent = _cheby(self.y, self.x, player.y, player.x) <= 1 \
            and dungeon.diag_ok(self.y, self.x, player.y, player.x)
        can_target = (not player.status.invisible) or bool(self.flags & CANSEE)
        if adjacent and can_target:
            result = monster_attacks_player(self, player, dungeon)
            self.last_attack = result.hit   # 3D 版の演出用（game.py が読む）
            msgs.extend(result.messages)
            # テレポート（Leprechaun / Nymph）
            if result.monster_teleports:
                self._teleport(dungeon, monsters, player)
        elif not adjacent:
            # 移動
            self._move(dungeon, player, monsters, floor_items)

        return msgs

    def _can_breathe(
        self,
        dungeon:  "Dungeon",
        player:   "Player",
        monsters: list["Monster"],
    ) -> bool:
        """
        ドラゴンが炎を吐ける位置か。
        5.4: キャンセルされていない・同じ部屋・縦横斜めの一直線上・距離² <= BOLT_LENGTH²。
        炎の通り道に壁や他のモンスターがあれば吐かない（跳ね返りは再現しない）。
        """
        if self.flags & ISCANC:
            return False
        dy, dx = player.y - self.y, player.x - self.x
        if not (dy == 0 or dx == 0 or abs(dy) == abs(dx)):
            return False
        if dy * dy + dx * dx > BOLT_LENGTH * BOLT_LENGTH:
            return False
        room = dungeon.find_room_at(self.y, self.x)
        if room is None or room is not dungeon.find_room_at(player.y, player.x):
            return False
        sy = (dy > 0) - (dy < 0)
        sx = (dx > 0) - (dx < 0)
        y, x = self.y + sy, self.x + sx
        while (y, x) != (player.y, player.x):
            if not dungeon.is_walkable(y, x) or any(
                    m.is_alive and m.y == y and m.x == x for m in monsters):
                return False
            y, x = y + sy, x + sx
        return True

    # =========================================================================
    # 移動 AI
    # =========================================================================

    def _move(
        self,
        dungeon:     "Dungeon",
        player:      "Player",
        monsters:    list["Monster"],
        floor_items: list = [],
    ) -> None:
        """
        1 マス移動する。
        混乱中: ランダム方向。
        通常: Chebyshev 距離を最小化する方向へ移動（欲張り法）。
        """
        if self.flags & ISHUH:
            self._move_random(dungeon, monsters, floor_items)
            return

        best = self._best_step(dungeon, player, monsters, floor_items)
        if best:
            # S_SCARE スクロールが着地点にあれば怯えて引き返す
            from constants import S_SCARE, CH_SCROLL
            for fi in floor_items:
                if (fi.y == best[0] and fi.x == best[1]
                        and getattr(fi.item, 'o_type', '') == CH_SCROLL
                        and getattr(fi.item, 'o_which', -1) == S_SCARE):
                    self.flags &= ~ISRUN  # 逃走（追跡停止）
                    return
            self.y, self.x = best

    def _move_random(
        self,
        dungeon:  "Dungeon",
        monsters: list["Monster"],
        floor_items: list = [],
    ) -> None:
        dirs = [(dy, dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                if not (dy == 0 and dx == 0)]
        random.shuffle(dirs)
        for dy, dx in dirs:
            ny, nx = self.y + dy, self.x + dx
            if self._can_enter(dungeon, ny, nx, monsters):
                self.y, self.x = ny, nx
                from constants import S_SCARE, CH_SCROLL, OBJ_ISFOUND
                for fi in floor_items:
                    if (fi.y == ny and fi.x == nx
                            and getattr(fi.item, 'o_type', '') == CH_SCROLL
                            and getattr(fi.item, 'o_which', -1) == S_SCARE
                            and fi.item.o_flags & OBJ_ISFOUND):
                        floor_items.remove(fi)
                        break
                return

    def _best_step(
        self,
        dungeon:     "Dungeon",
        player:      "Player",
        monsters:    list["Monster"],
        floor_items: list = [],
    ) -> Optional[tuple[int, int]]:
        """
        プレイヤーに最も近づく移動先を返す（Chebyshev 距離最小化）。
        ISGREED モンスターは同室の金を優先目標にする。
        """
        # ISGREED: 同室の金を優先目標とする
        if self.flags & ISGREED and floor_items:
            from constants import CH_GOLD
            my_room = dungeon.find_room_at(self.y, self.x)
            gold_targets = [
                fi for fi in floor_items
                if fi.item.o_type == CH_GOLD
                and my_room is not None
                and dungeon.find_room_at(fi.y, fi.x) is my_room
            ]
            if gold_targets:
                nearest = min(gold_targets, key=lambda fi: _cheby(self.y, self.x, fi.y, fi.x))
                ty, tx = nearest.y, nearest.x
                cur_dist = _cheby(self.y, self.x, ty, tx)
                best_pos:  Optional[tuple[int, int]] = None
                best_dist: int = cur_dist
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dy == 0 and dx == 0:
                            continue
                        ny, nx = self.y + dy, self.x + dx
                        if not self._can_enter(dungeon, ny, nx, monsters):
                            continue
                        d = _cheby(ny, nx, ty, tx)
                        if d < best_dist:
                            best_dist = d
                            best_pos  = (ny, nx)
                if best_pos:
                    return best_pos

        # 不可視プレイヤーは CANSEE なしでは追跡不可
        if player.status.invisible and not (self.flags & CANSEE):
            return None

        py, px = player.y, player.x
        # 近さは Chebyshev 距離、同じなら直線距離の 2 乗（5.4 の chase と同じ）で比べる。
        # 斜めに隣り合っていて角の壁で殴れないとき、縦横に隣り合う所へ回り込めるように
        dist = lambda y, x: (_cheby(y, x, py, px), (y - py) ** 2 + (x - px) ** 2)
        cur_dist = dist(self.y, self.x)

        best_pos  = None
        best_dist = cur_dist

        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                ny, nx = self.y + dy, self.x + dx
                if not self._can_enter(dungeon, ny, nx, monsters):
                    continue
                d = dist(ny, nx)
                if d < best_dist:
                    best_dist = d
                    best_pos  = (ny, nx)

        return best_pos

    def _can_enter(
        self,
        dungeon:  "Dungeon",
        y:        int,
        x:        int,
        monsters: list["Monster"],
    ) -> bool:
        """指定マスに移動可能か判定する。"""
        if not dungeon.is_walkable(y, x):
            return False
        if not dungeon.diag_ok(self.y, self.x, y, x):   # 5.4 diag_ok: 角が壁・岩なら斜めに進めない
            return False
        # 他のモンスターが占有していないか
        if any(m.y == y and m.x == x and m.is_alive and m is not self
               for m in monsters):
            return False
        return True

    def _teleport(
        self,
        dungeon:  "Dungeon",
        monsters: list["Monster"],
        player:   object = None,
    ) -> None:
        """モンスターをランダムな床位置にテレポートさせる。"""
        pos = dungeon.teleport_monster(self.y, self.x, monsters)
        if pos is None:
            return
        if player is not None and pos.y == player.y and pos.x == player.x:
            return
        self.y, self.x = pos.y, pos.x
        self.flags &= ~ISRUN   # 起床フラグをリセット（逃げた）

    # =========================================================================
    # Repr
    # =========================================================================

    def __repr__(self) -> str:
        state = "awake" if self.is_awake else "asleep"
        return (
            f"<Monster {self.letter}({self.name}) HP:{self.hp}/{self.max_hp} L{self.level} "
            f"at({self.y},{self.x}) {state}>"
        )


# ===========================================================================
# ファクトリ関数
# ===========================================================================

def spawn_monster(
    letter:      str,
    floor_level: int,
    y:           int,
    x:           int,
) -> Monster:
    """
    指定文字・フロアレベルに対応したモンスターを生成する。

    data/monsters.json の new_monster 公式準拠:
      lev_add        = max(0, floor_level - AMULETLEVEL)
      actual_level   = base.level + lev_add
      actual_ac      = base.ac    - lev_add
      max_hp         = roll(actual_level, 8)
      actual_exp     = base.exp   + lev_add * 10  (+ exp_add は calc_exp 時に加算)
      haste_threshold = 29 → actual_level > 29 で ISHASTE 付与
    """
    if letter not in MONSTER_DB:
        letter = 'K'   # フォールバック

    stats   = MONSTER_DB[letter]
    lev_add = max(0, floor_level - AMULETLEVEL)

    actual_level = stats.level + lev_add
    actual_ac    = stats.ac    - lev_add
    actual_exp   = stats.exp   + lev_add * 10

    max_hp = max(1, roll(actual_level, 8))

    flags = stats.flags
    if actual_level > 29:               # haste_threshold
        flags |= ISHASTE

    # Xeroc: ランダムなアイテム文字に変装
    disguise = ''
    if letter == 'X':
        disguise = random.choice(_XEROC_CHARS)

    has_item = random.randint(0, 99) < stats.carry

    return Monster(
        letter=letter, y=y, x=x,
        hp=max_hp, max_hp=max_hp,
        level=actual_level, ac=actual_ac, exp=actual_exp,
        flags=flags,
        has_item=has_item,
        disguise_ch=disguise,
        wander_timer=_get_spread('WANDERTIME'),
    )


def spawn_from_placed(placed, floor_level: int) -> Monster:
    """
    dungeon.PlacedMonster から Monster を生成するヘルパー。
    placed は .ch / .y / .x を持つオブジェクト。
    """
    return spawn_monster(placed.ch, floor_level, placed.y, placed.x)


def rand_monster_letter(floor_level: int, wander: bool = False) -> str:
    """
    data/monsters.json の randmonster 公式準拠:
      d = floor_level + rnd(10) - 6
      d < 0  → rnd(5)
      d > 25 → rnd(5) + 21
    wander=True のとき WAND_MONS テーブルを使い、null エントリをスキップする。
    """
    table = WAND_MONS if wander else LVL_MONS
    for _ in range(100):   # 無限ループ防止
        d = floor_level + random.randint(0, 9) - 6
        if d < 0:
            d = random.randint(0, 4)
        elif d > 25:
            d = random.randint(0, 4) + 21
        d = max(0, min(25, d))
        ch = table[d]
        if ch is not None:
            return ch
    return LVL_MONS[0]   # フォールバック: Kobold
