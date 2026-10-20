# プレイヤーステータス・操作
"""
Player クラスと StatusEffects クラスを定義する。
数値定数はすべて constants.py（JSON 由来）から取得する。
レベルアップ経験値テーブルは JSON に存在しないため player.py 内で定義する。
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Optional

from i18n import tr
from constants import (
    HUNGERTIME, MORETIME, STOMACHSIZE, STARVETIME, MAXPACK,
    LEFT, RIGHT,
    ISHASTE, ISSLOW, ISBLIND, ISHUH, ISINVIS, ISLEVIT, ISREGEN, ISFOUND,
    R_REGEN, R_SEEINVIS, R_SEARCH, R_STEALTH, R_SUSTSTR,
    R_ADDSTR, R_ADDHIT, R_ADDDAM, R_PROTECT, R_DIGEST, R_TELEPORT,
    R_NOP, R_AGGR, R_SUSTARM,
    LEVEL_HP_BONUS, SEEDURATION, SIGHT_POTION_CUT, HUHDURATION, CONFUSE_CUT,
)

# ---------------------------------------------------------------------------
# プレイヤー開始ステータス（Rogue 5.4 準拠）
# ---------------------------------------------------------------------------
_START_HP   = 12
_START_STR  = 16
_BASE_AC    = 10    # 素手のAC（低いほど強い）
_MAX_LEVEL  = 20    # プレイヤー最大レベル

# ---------------------------------------------------------------------------
# Rogue 5.4 STR ボーナステーブル（str-1 をインデックスとして STR 1〜26 に対応）
# str_plus: 命中ボーナス  add_dam: ダメージボーナス
# ---------------------------------------------------------------------------
_STR_PLUS = [-3,-2,-2,-1,-1,-1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 5, 6, 7, 7, 8, 8, 9,10]
_ADD_DAM  = [-3,-2,-2,-1,-1,-1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 5, 6, 7, 7, 8, 9,10]

# 指輪ごとの食料消費（5.4 rings.c ring_eat の uses[]）。負の値 -n は 1/n の確率で 1
_RING_USES = {
    R_PROTECT: 1, R_ADDSTR: 1, R_SUSTSTR: 1, R_SEARCH: -3, R_SEEINVIS: -5,
    R_NOP: 0, R_AGGR: 0, R_ADDHIT: -3, R_ADDDAM: -3, R_REGEN: 2,
    R_DIGEST: -2, R_TELEPORT: 0, R_STEALTH: 1, R_SUSTARM: 1,
}


def _ring_eat(ring: Any) -> int:
    """指輪 1 個がこのターンに消費する食料。slow digestion は 1/2 の確率で 1 回復する。"""
    if ring is None:
        return 0
    which = getattr(ring, 'o_which', -1)
    eat = _RING_USES.get(which, 0)
    if eat < 0:
        eat = 1 if random.randint(0, -eat - 1) == 0 else 0
    return -eat if which == R_DIGEST else eat


def _str_hit_bonus(s: int) -> int:
    return _STR_PLUS[max(0, min(s - 1, len(_STR_PLUS) - 1))]

def _str_dam_bonus(s: int) -> int:
    return _ADD_DAM[max(0, min(s - 1, len(_ADD_DAM) - 1))]

# 各レベルに到達するために必要な累積経験値（Rogue 5.4.4 extern.c e_levels[]）
# index 0 = Lv2到達に必要、index 18 = Lv20到達に必要
_EXP_TABLE: list[int] = [
    10, 20, 40, 80, 160, 320, 640, 1300,
    2600, 5200, 13000, 26000, 50000, 100000,
    200000, 400000, 800000, 2000000, 4000000,
]

# 空腹閾値（Rogue 5.4 daemons.c stomach: food_left < 2*MORETIME / < MORETIME）
_HUNGRY_THRESHOLD = 2 * MORETIME   # 300 未満で "Hungry"
_WEAK_THRESHOLD   = MORETIME       # 150 未満で "Weak"、0 以下で "Faint"


# ===========================================================================
# StatusEffects
# ===========================================================================

@dataclass
class StatusEffects:
    """
    プレイヤーの状態異常を管理するクラス。
    int フィールド = 残りターン数（0 = 無効）
    bool フィールド = 永続的な効果
    """

    confused:      int  = 0    # 混乱
    blind:         int  = 0    # 盲目
    paralyzed:     int  = 0    # 麻痺（Ice Monster 等）
    hallucinating: int  = 0    # 幻覚
    poisoned:      int  = 0    # 毒（STRが1/ターン減少）
    hasted:        int  = 0    # 加速
    slowed:        int  = 0    # 減速
    levitating:    int  = 0    # 浮遊
    see_invis_turns: int = 0   # 不可視看破ポーション残りターン（0=失効）

    invisible:            bool = False   # 不可視（アイテム効果）
    see_invisible:        bool = False   # 不可視看破（指輪による永続）
    regenerating:         bool = False   # 自動再生（指輪効果）
    slow_digest:          bool = False   # 消化遅延（指輪効果）
    confuse_next_attack:  bool = False   # 次攻撃でモンスターを混乱（S_CONFUSE）
    held:                 bool = False   # Venus Flytrap に拘束中（移動不可・攻撃は可）

    def __setstate__(self, state: dict) -> None:
        """古いセーブファイルに存在しないフィールドをデフォルト値で補完する。"""
        state.setdefault('held', False)
        # 効き目を短くする前のセーブで残っている盲目・幻覚も、今の長さまでに縮める
        cap = SEEDURATION - SIGHT_POTION_CUT
        cap += cap // 10
        for k in ('blind', 'hallucinating'):
            state[k] = min(state.get(k, 0), cap)
        state['confused'] = min(state.get('confused', 0), HUHDURATION - CONFUSE_CUT)
        self.__dict__.update(state)

    # ---- タイマー処理 ----

    def tick(self) -> list[str]:
        """
        全タイマーを 1 減少させる。
        期限切れになった状態異常のメッセージリストを返す。
        """
        msgs: list[str] = []
        _timed = [
            ("confused",        "You feel less confused now."),
            ("blind",           "The veil of darkness lifts."),
            ("paralyzed",       "You can move again."),
            ("hallucinating",   "Everything seems SO boring now."),
            ("poisoned",        "The sickness fades."),
            ("hasted",          "You feel yourself slowing down."),
            ("slowed",          "You feel yourself speeding up."),
            ("levitating",      "You float gently to the ground."),
            ("see_invis_turns", "Your eyes stop tingling."),
        ]
        for attr, msg in _timed:
            v = getattr(self, attr)
            if v > 0:
                v -= 1
                setattr(self, attr, v)
                if v == 0:
                    msgs.append(tr(msg))
        return msgs

    # ---- 判定プロパティ ----

    @property
    def is_mobile(self) -> bool:
        return self.paralyzed == 0 and not self.held

    @property
    def can_see(self) -> bool:
        return self.blind == 0

    @property
    def is_confused(self) -> bool:
        return self.confused > 0

    @property
    def is_hasted(self) -> bool:
        return self.hasted > 0

    @property
    def is_slowed(self) -> bool:
        return self.slowed > 0

    @property
    def is_levitating(self) -> bool:
        return self.levitating > 0

    @property
    def can_see_invisible(self) -> bool:
        """永続（指輪）または時限（ポーション）のいずれかで不可視看破中なら True。"""
        return self.see_invisible or self.see_invis_turns > 0

    # ---- 表示 ----

    def status_str(self) -> str:
        """アクティブな状態異常の略称を空白区切りで返す。"""
        parts: list[str] = []
        if self.held:          parts.append(tr('Held'))
        if self.confused:      parts.append(tr('Conf'))
        if self.blind:         parts.append(tr('Blind'))
        if self.paralyzed:     parts.append(tr('Para'))
        if self.hallucinating: parts.append(tr('Halu'))
        if self.poisoned:      parts.append(tr('Pois'))
        if self.hasted:        parts.append(tr('Haste'))
        if self.slowed:        parts.append(tr('Slow'))
        if self.levitating:    parts.append(tr('Lev'))
        if self.invisible:     parts.append(tr('Inv'))
        return " ".join(parts)


# ===========================================================================
# Player
# ===========================================================================

@dataclass
class Player:
    """
    プレイヤーの全ステータス・インベントリ・装備を管理する。

    座標は dungeon.Coord と互換の (y, x) 形式。
    アイテムオブジェクトは items.py 実装後に型が確定するため Any 型を使用する。
    """

    # ---- 座標 ---------------------------------------------------------------
    y: int = 0
    x: int = 0

    # ---- 基本ステータス -------------------------------------------------------
    hp:      int = _START_HP
    max_hp:  int = _START_HP
    str_cur: int = _START_STR
    str_max: int = _START_STR
    ac:      int = _BASE_AC    # 素のAC（防具・指輪で変動）

    # ---- 経験値・レベル -------------------------------------------------------
    exp:   int = 0
    level: int = 1

    # ---- リソース ------------------------------------------------------------
    gold: int = 0
    food: int = HUNGERTIME    # 食料カウンター（STOMACHSIZE が上限）

    # ---- 状態異常 ------------------------------------------------------------
    status: StatusEffects = field(default_factory=StatusEffects)

    # ---- 装備 ----------------------------------------------------------------
    weapon: Optional[Any] = None
    armor:  Optional[Any] = None
    rings:  list[Optional[Any]] = field(
        default_factory=lambda: [None, None]   # [LEFT, RIGHT]
    )

    # ---- インベントリ a–z（最大 MAXPACK=23 スロット使用可） ------------------
    pack: dict[str, Any] = field(default_factory=dict)
    pack_used: list[bool] = field(
        default_factory=lambda: [False] * 26
    )

    # ---- ゲーム進行 ----------------------------------------------------------
    floor:      int  = 1
    has_amulet: bool = False
    godmode:    bool = False

    # ---- 内部 ----------------------------------------------------------------
    _last_msg:   str = field(default="", repr=False)
    _heal_timer: int = field(default=0,  repr=False)

    # =========================================================================
    # 派生プロパティ
    # =========================================================================

    @property
    def is_alive(self) -> bool:
        return self.hp > 0

    @property
    def hunger_state(self) -> str:
        """現在の空腹状態を文字列で返す。"""
        if self.food <= 0:
            return "Faint"
        if self.food < _WEAK_THRESHOLD:
            return "Weak"
        if self.food < _HUNGRY_THRESHOLD:
            return "Hungry"
        return ""

    @property
    def effective_str(self) -> int:
        """装備込みの実効 STR。"""
        bonus = 0
        for ring in self.rings:
            if ring is not None and getattr(ring, 'o_which', -1) == R_ADDSTR:
                bonus += getattr(ring, 'o_arm', 0)
        return max(3, self.str_cur + bonus)

    @property
    def effective_ac(self) -> int:
        """装備込みの実効 AC（低いほど良い）。"""
        base = _BASE_AC
        if self.armor is not None:
            base = getattr(self.armor, 'o_arm', base)
        for ring in self.rings:
            if ring is not None and getattr(ring, 'o_which', -1) == R_PROTECT:
                base -= getattr(ring, 'o_arm', 0)
        return base

    @property
    def attack_bonus(self) -> int:
        """攻撃ロールへのボーナス（R_ADDSTR 込みの実効 STR・武器・指輪）。"""
        bonus = _str_hit_bonus(self.effective_str)
        if self.weapon is not None:
            bonus += getattr(self.weapon, 'o_hplus', 0)
        for ring in self.rings:
            if ring is not None and getattr(ring, 'o_which', -1) == R_ADDHIT:
                bonus += getattr(ring, 'o_arm', 0)
        return bonus

    @property
    def damage_bonus(self) -> int:
        """ダメージロールへのボーナス（R_ADDSTR 込みの実効 STR・武器・指輪）。"""
        bonus = _str_dam_bonus(self.effective_str)
        if self.weapon is not None:
            bonus += getattr(self.weapon, 'o_dplus', 0)
        for ring in self.rings:
            if ring is not None and getattr(ring, 'o_which', -1) == R_ADDDAM:
                bonus += getattr(ring, 'o_arm', 0)
        return bonus

    @property
    def protect_bonus(self) -> int:
        """セービングスローへのボーナス（R_PROTECT 指輪の o_arm 合計）。"""
        return sum(
            getattr(r, 'o_arm', 0)
            for r in self.rings if r is not None
            and getattr(r, 'o_which', -1) == R_PROTECT
        )

    @property
    def pack_count(self) -> int:
        return sum(self.pack_used)

    @property
    def pack_full(self) -> bool:
        return self.pack_count >= MAXPACK

    # =========================================================================
    # ターン処理
    # =========================================================================

    def tick(self) -> list[str]:
        """
        1ターン経過処理。食料消費・再生・状態異常タイマーを処理し、
        発生したメッセージのリストを返す。
        """
        msgs: list[str] = []

        # 食料消費（5.4 daemons.c stomach）: 1 + 左右の指輪の消費 − アミュレット所持
        rate = 1 + sum(_ring_eat(r) for r in self.rings) - (1 if self.has_amulet else 0)
        msgs.extend(self._tick_hunger(rate))

        # 毒ダメージ: STR を 1 減少（R_SUSTSTR 装備中またはgodmode時は守る）
        if self.status.poisoned > 0 and self.str_cur > 3:
            if not self.godmode and not self._has_ring(R_SUSTSTR):
                self.str_cur -= 1
                msgs.append(tr('The poison saps your strength.'))

        # HP 自然回復（5.4 daemons.c doctor）。_heal_timer は戦っていないターン数（quiet）
        # Lv7 以下: quiet + Lv*2 > 20 で毎ターン +1
        # Lv8 以上: quiet >= 3 で毎ターン +rnd(Lv-7)+1
        # 再生の指輪 1 個につき毎ターン +1。回復したら quiet は 0 に戻る
        old_hp = self.hp
        self._heal_timer += 1
        if self.level < 8:
            if self._heal_timer + self.level * 2 > 20:
                self.hp += 1
        elif self._heal_timer >= 3:
            self.hp += random.randint(0, self.level - 8) + 1
        self.hp += sum(1 for r in self.rings
                       if r is not None and getattr(r, 'o_which', -1) == R_REGEN)
        if self.hp != old_hp:
            self.hp = min(self.hp, self.max_hp)
            self._heal_timer = 0

        # 状態異常タイマー（毒が切れても STR は自動回復しない: Rogue 5.4 準拠）
        msgs.extend(self.status.tick())

        return msgs

    def _tick_hunger(self, rate: int) -> list[str]:
        """
        Rogue 5.4 daemons.c stomach 準拠。
        食料が尽きると時々気絶し、-STARVETIME を下回ると餓死する。
        """
        msgs: list[str] = []
        if self.food <= 0:
            self.food -= 1
            if self.food < -STARVETIME:
                if not self.godmode:
                    self.hp = 0
                return msgs
            if self.status.paralyzed == 0 and random.randint(0, 4) == 0:
                self.status.paralyzed += random.randint(0, 7) + 4
                msgs.append(tr('You feel too weak from lack of food.  You faint.'))
            return msgs

        old = self.food
        self.food -= rate
        if self.food < _WEAK_THRESHOLD <= old:
            msgs.append(tr('You are starting to feel weak.'))
        elif self.food < _HUNGRY_THRESHOLD <= old:
            msgs.append(tr('You are starting to get hungry.'))
        return msgs

    # =========================================================================
    # ダメージ・回復
    # =========================================================================

    def take_damage(self, amount: int) -> bool:
        """ダメージを受ける。返り値: True=生存 / False=死亡。"""
        if self.godmode:
            return True
        self.hp = max(0, self.hp - amount)
        return self.is_alive

    def heal(self, amount: int) -> None:
        """HP を回復する（max_hp を超えない）。"""
        self.hp = min(self.max_hp, self.hp + amount)

    def raise_max_hp(self, amount: int) -> None:
        """最大 HP を恒久的に増加させ、現在 HP も同量増やす。"""
        self.max_hp += amount
        self.hp      = min(self.max_hp, self.hp + amount)

    def modify_str(self, delta: int) -> str:
        """STR を変化させ、説明メッセージを返す。"""
        old = self.str_cur
        self.str_cur = max(3, min(self.str_max, self.str_cur + delta))
        if self.str_cur < old:
            return tr('You feel weaker. (STR {str_cur})', str_cur=self.str_cur)
        if self.str_cur > old:
            return tr('You feel stronger! (STR {str_cur})', str_cur=self.str_cur)
        return ""

    def restore_str(self) -> str:
        """STR を最大値まで回復する。"""
        if self.str_cur < self.str_max:
            self.str_cur = self.str_max
            return tr('You feel your strength returning.')
        return ""

    def increase_max_str(self, amount: int = 1) -> None:
        self.str_max = min(31, self.str_max + amount)
        self.str_cur = min(self.str_max, self.str_cur + amount)

    # =========================================================================
    # 経験値・レベルアップ
    # =========================================================================

    def gain_exp(self, amount: int) -> list[str]:
        """経験値を加算し、レベルアップメッセージを返す。"""
        self.exp += amount
        msgs: list[str] = []
        while self.level < _MAX_LEVEL:
            needed = _EXP_TABLE[self.level - 1]
            if self.exp >= needed:
                self.level += 1
                hp_gain = random.randint(1, 10) + LEVEL_HP_BONUS
                self.max_hp += hp_gain
                self.hp     += hp_gain
                msgs.append(
                    tr('Welcome to level {level}!  (max HP now {max_hp})', level=self.level, max_hp=self.max_hp)
                )
            else:
                break
        return msgs

    def exp_to_next(self) -> Optional[int]:
        """次のレベルに必要な残り経験値。最大レベルの場合 None。"""
        if self.level >= _MAX_LEVEL:
            return None
        return _EXP_TABLE[self.level - 1] - self.exp

    # =========================================================================
    # ゴールド・食料
    # =========================================================================

    def gain_gold(self, amount: int) -> None:
        self.gold += amount

    def eat(self, food_value: int) -> list[str]:
        """食料を食べる（満腹チェックは呼び出し元で行うこと）。"""
        msgs: list[str] = []
        old_state = self.hunger_state
        self.food = min(STOMACHSIZE, max(0, self.food) + food_value)
        new_state = self.hunger_state
        if old_state and not new_state:
            msgs.append(tr('You feel full now.'))
        elif old_state and old_state != new_state:
            msgs.append(tr('You feel a little less {value}.', value=tr(old_state).lower()))
        return msgs

    # =========================================================================
    # インベントリ管理
    # =========================================================================

    def pack_char(self) -> Optional[str]:
        """空き pack スロット文字 (a–z) を返す。空きがなければ None。"""
        for i in range(26):
            if not self.pack_used[i]:
                return chr(ord('a') + i)
        return None

    def add_to_pack(self, item: Any) -> Optional[str]:
        """
        アイテムをパックに追加する。
        成功すればスロット文字、満杯なら None を返す。
        """
        if self.pack_count >= MAXPACK:
            return None
        ch = self.pack_char()
        if ch is None:
            return None
        self.pack[ch] = item
        self.pack_used[ord(ch) - ord('a')] = True
        return ch

    def remove_from_pack(self, ch: str) -> Optional[Any]:
        """指定スロットのアイテムを取り出す。存在しなければ None。"""
        item = self.pack.pop(ch, None)
        if item is not None:
            self.pack_used[ord(ch) - ord('a')] = False
        return item

    def items_of_type(self, type_ch: str) -> list[tuple[str, Any]]:
        """表示文字でフィルタしたパック内アイテム [(slot, item), ...] を返す。"""
        result = []
        for ch, item in sorted(self.pack.items()):
            item_ch = getattr(item, 'ch', None) or getattr(item, 'o_type', None)
            if item_ch == type_ch:
                result.append((ch, item))
        return result

    # =========================================================================
    # 装備管理
    # =========================================================================

    def equip_weapon(self, item: Any) -> Optional[Any]:
        """武器を装備し、外した武器を返す（なければ None）。"""
        old = self.weapon
        self.weapon = item
        return old

    def unequip_weapon(self) -> Optional[Any]:
        old = self.weapon
        self.weapon = None
        return old

    def equip_armor(self, item: Any) -> Optional[Any]:
        """防具を装備し、外した防具を返す。"""
        old = self.armor
        self.armor = item
        return old

    def unequip_armor(self) -> Optional[Any]:
        old = self.armor
        self.armor = None
        return old

    @property
    def search_bonus(self) -> int:
        """R_SEARCH 指輪の合計ボーナス（ターンごとの自動探索回数）。"""
        total = 0
        for ring in self.rings:
            if ring is not None and getattr(ring, 'o_which', -1) == R_SEARCH:
                total += max(1, getattr(ring, 'o_arm', 1))
        return total

    def put_on_ring(self, item: Any, slot: int) -> Optional[Any]:
        """指輪を LEFT / RIGHT に装備し、外した指輪を返す。"""
        old = self.rings[slot]
        if old is not None:
            self._detach_ring_effect(old)
        self.rings[slot] = item
        self._attach_ring_effect(item)
        return old

    def remove_ring(self, slot: int) -> Optional[Any]:
        item = self.rings[slot]
        if item is not None:
            self._detach_ring_effect(item)
        self.rings[slot] = None
        return item

    def _attach_ring_effect(self, ring: Any) -> None:
        """指輪装備時の継続効果を有効化する。"""
        which = getattr(ring, 'o_which', -1)
        if which == R_REGEN:
            self.status.regenerating = True
        elif which == R_SEEINVIS:
            self.status.see_invisible = True
        elif which == R_DIGEST:
            self.status.slow_digest = True

    def _detach_ring_effect(self, ring: Any) -> None:
        """指輪取り外し時の継続効果を無効化する。"""
        which = getattr(ring, 'o_which', -1)
        if which == R_REGEN:
            # もう片方も再生リングなら継続
            other = self.rings[1] if self.rings[0] is ring else self.rings[0]
            if not (other is not None and getattr(other, 'o_which', -1) == R_REGEN):
                self.status.regenerating = False
        elif which == R_SEEINVIS:
            other = self.rings[1] if self.rings[0] is ring else self.rings[0]
            if not (other is not None and getattr(other, 'o_which', -1) == R_SEEINVIS):
                self.status.see_invisible = False
        elif which == R_DIGEST:
            other = self.rings[1] if self.rings[0] is ring else self.rings[0]
            if not (other is not None and getattr(other, 'o_which', -1) == R_DIGEST):
                self.status.slow_digest = False

    def _has_ring(self, which: int) -> bool:
        """指定種別の指輪をいずれかのスロットに装備していれば True。"""
        return any(
            r is not None and getattr(r, 'o_which', -1) == which
            for r in self.rings
        )

    # =========================================================================
    # 状態異常適用
    # =========================================================================

    def exp_start_of_level(self, level: int) -> int:
        """指定レベルの開始経験値を返す（Wraith レベルドレイン用）。"""
        if level <= 1:
            return 0
        return _EXP_TABLE[level - 2]

    def apply_confusion(self, turns: int) -> str:
        self.status.confused = max(self.status.confused, turns)
        return tr('You feel confused.')

    def apply_blindness(self, turns: int) -> str:
        self.status.blind = max(self.status.blind, turns)
        return tr('A wave of darkness washes over you.')

    def apply_paralysis(self, turns: int) -> str:
        self.status.paralyzed = max(self.status.paralyzed, turns)
        return tr("You can't move!")

    def apply_hallucination(self, turns: int) -> str:
        self.status.hallucinating = max(self.status.hallucinating, turns)
        return tr('Oh wow! Everything looks SO different!')

    def apply_poison(self, turns: int) -> str:
        self.status.poisoned = max(self.status.poisoned, turns)
        return tr('You feel very sick now.')

    def apply_haste(self, turns: int) -> str:
        if self.status.is_slowed:
            self.status.slowed = 0
            return tr('You feel yourself speeding up.')
        self.status.hasted = max(self.status.hasted, turns)
        return tr('You feel yourself moving faster.')

    def apply_slow(self, turns: int) -> str:
        if self.status.is_hasted:
            self.status.hasted = 0
            return tr('You feel yourself slowing down.')
        self.status.slowed = max(self.status.slowed, turns)
        return tr('You feel yourself slowing down.')

    def apply_levitation(self, turns: int) -> str:
        self.status.levitating = max(self.status.levitating, turns)
        return tr('You start to float in the air.')

    def apply_see_invisible(self, turns: int) -> str:
        """ポーションによる時限不可視看破（SEEDURATION ターン）。"""
        self.status.see_invis_turns = max(self.status.see_invis_turns, turns)
        return tr('Your eyes begin to tingle.')

    def apply_invisibility(self) -> str:
        self.status.invisible = True
        return tr('You become invisible.')

    def cure_confusion(self) -> str:
        self.status.confused = 0
        return tr('You feel less confused.')

    def cure_blindness(self) -> str:
        self.status.blind = 0
        return tr('The veil of darkness lifts.')

    def cure_poison(self) -> str:
        self.status.poisoned = 0
        return tr('You feel the poison subside.')

    # =========================================================================
    # ステータス表示文字列
    # =========================================================================

    def status_line(self) -> str:
        """
        ステータスバー用の文字列（80文字以内）。
        Level:X  Gold:X  Hp:X(X)  Str:X(X)  Arm:X  Exp:X/X  [空腹] [状態]
        """
        parts = [
            tr("Level:{floor}", floor=self.floor),
            tr("Gold:{gold}", gold=self.gold),
            tr("Hp:{hp}({max_hp})", hp=self.hp, max_hp=self.max_hp),
            tr("Str:{str_cur}({str_max})", str_cur=self.str_cur, str_max=self.str_max),
            tr("Arm:{ac}", ac=self.effective_ac),
            tr("Exp:{level}/{exp}", level=self.level, exp=self.exp),
        ]
        hunger = self.hunger_state
        if hunger:
            parts.append(tr(hunger))
        status = self.status.status_str()
        if status:
            parts.append(status)
        return "  ".join(parts)

    def detail_lines(self) -> list[str]:
        """ステータス詳細画面用の行リストを返す。"""
        nxt = self.exp_to_next()
        nxt_str = str(nxt) if nxt is not None else tr("MAX")
        weapon_name = self.weapon.name if self.weapon else tr("bare hands")
        armor_name  = self.armor.name if self.armor else tr("none")
        left_ring   = self.rings[0].name if self.rings[0] else tr("none")
        right_ring  = self.rings[1].name if self.rings[1] else tr("none")
        return [
            tr('  Floor:      {floor}', floor=self.floor),
            tr('  HP:         {hp} / {max_hp}', hp=self.hp, max_hp=self.max_hp),
            tr('  Strength:   {str_cur} / {str_max}', str_cur=self.str_cur, str_max=self.str_max),
            tr('  Armor:      {effective_ac}', effective_ac=self.effective_ac),
            tr('  Level:      {level}', level=self.level),
            tr('  Experience: {exp}  (next level: {nxt_str})', exp=self.exp, nxt_str=nxt_str),
            tr('  Gold:       {gold}', gold=self.gold),
            tr('  Hunger:     {value}', value=tr(self.hunger_state or 'Normal')),
            tr('  Status:     {value}', value=self.status.status_str() or tr('None')),
            tr('  Weapon:     {weapon_name}', weapon_name=weapon_name),
            tr('  Armor:      {armor_name}', armor_name=armor_name),
            tr('  Left ring:  {left_ring}', left_ring=left_ring),
            tr('  Right ring: {right_ring}', right_ring=right_ring),
            tr('  Amulet:     {value}', value=tr('Yes') if self.has_amulet else tr('No')),
        ]

    def __repr__(self) -> str:
        return (
            f"<Player L{self.level} HP:{self.hp}/{self.max_hp} Str:{self.str_cur} "
            f"AC:{self.effective_ac} Exp:{self.exp} Gold:{self.gold} Flr:{self.floor}>"
        )
