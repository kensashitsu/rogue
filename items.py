# アイテム定義・効果
"""
Rogue 5.4 準拠のアイテム定義・識別システム・使用効果モジュール。

識別システム:
  ポーション → ランダムな色
  スクロール → ランダムな呪文タイトル（音節結合）
  指輪       → ランダムな宝石
  杖/ワンド  → ランダムな素材

アイテムフラグ（data/items.json object_flags 準拠）:
  ISCURSED=1, ISKNOW=2, ISMISL=4, ISMANY=8, OBJ_ISFOUND=16, ISPROT=32
"""

from __future__ import annotations

import random
import re as _re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional, NamedTuple

from i18n import tr, name as tr_name, is_ja
from constants import (
    # オブジェクトフラグ
    ISCURSED, ISKNOW, ISMISL, ISMANY, OBJ_ISFOUND, ISPROT,
    # アイテム種別文字
    CH_POTION, CH_SCROLL, CH_WEAPON, CH_ARMOR, CH_RING, CH_STICK,
    CH_FOOD, CH_GOLD, CH_AMULET,
    # 個数上限
    MAXPOTIONS, MAXSCROLLS, MAXWEAPONS, MAXARMORS, MAXRINGS, MAXSTICKS,
    # ポーション種別
    P_CONFUSE, P_LSD, P_POISON, P_STRENGTH, P_SEEINVIS, P_HEALING,
    P_MFIND, P_TFIND, P_RAISE, P_XHEAL, P_HASTE, P_RESTORE, P_BLIND, P_LEVIT,
    # スクロール種別
    S_CONFUSE, S_MAP, S_HOLD, S_SLEEP, S_ARMOR, S_ID_POTION, S_ID_SCROLL,
    S_ID_WEAPON, S_ID_ARMOR, S_ID_R_OR_S, S_SCARE, S_FDET, S_TELEP,
    S_ENCH, S_CREATE, S_REMOVE, S_AGGR, S_PROTECT,
    # 武器種別
    MACE, SWORD, BOW, ARROW, DAGGER, TWOSWORD, DART, SHIRAKEN, SPEAR, FLAME,
    # 防具種別
    LEATHER, RING_MAIL, STUDDED_LEATHER, SCALE_MAIL, CHAIN_MAIL,
    SPLINT_MAIL, BANDED_MAIL, PLATE_MAIL,
    # 指輪種別
    R_PROTECT, R_ADDSTR, R_SUSTSTR, R_SEARCH, R_SEEINVIS, R_NOP, R_AGGR,
    R_ADDHIT, R_ADDDAM, R_REGEN, R_DIGEST, R_TELEPORT, R_STEALTH, R_SUSTARM,
    # 杖/ワンド種別
    WS_LIGHT, WS_INVIS, WS_ELECT, WS_FIRE, WS_COLD, WS_POLYMORPH,
    WS_MISSILE, WS_HASTE_M, WS_SLOW_M, WS_DRAIN, WS_NOP, WS_TELAWAY,
    WS_TELTO, WS_CANCEL,
    # ゲームパラメータ
    HUNGERTIME, MORETIME, STOMACHSIZE, HUHDURATION, SEEDURATION, SIGHT_POTION_CUT, CONFUSE_CUT, BOLT_LENGTH,
    ISHASTE, ISSLOW, ISRUN, ISHUH, ISINVIS, ISMEAN, ISCANC, ISHELD,
    VS_MAGIC, VS_POISON,
    LEFT, RIGHT,
    _TIMING_RAW,
    ISDARK, AMULETLEVEL,
    ISFOUND,
)
from combat import roll, roll_damage, save_throw

if TYPE_CHECKING:
    from player  import Player
    from dungeon import Dungeon
    from monsters import Monster


# ===========================================================================
# spread() ヘルパー
# ===========================================================================

def _spread(n: int) -> int:
    """Rogue 5.4 misc.c spread(nm) = nm - nm/20 + rnd(nm/10)（±5% の揺らぎ）。"""
    return n - n // 20 + (random.randint(0, n // 10 - 1) if n >= 10 else 0)


def _get_spread(name: str, default: int) -> int:
    raw = _TIMING_RAW.get(name, f"spread({default})")
    m = _re.match(r'spread\((\d+)\)', raw)
    return _spread(int(m.group(1))) if m else default


# ===========================================================================
# 出現外観プール（Rogue 5.4 準拠）
# ===========================================================================

_POTION_COLORS: list[str] = [
    "amber", "aquamarine", "black", "blue", "brown", "clear", "crimson",
    "cyan", "ecru", "gold", "green", "grey", "magenta", "orange",
    "pink", "plaid", "purple", "red", "silver", "tan", "turquoise",
    "vermilion", "violet", "white", "yellow",
]

_SCROLL_SYLLABLES: list[str] = [
    "a", "ab", "ag", "aks", "ala", "an", "app", "arg", "arze", "ash",
    "bek", "bled", "bot", "bu", "byt", "comp", "con", "cos", "cre",
    "dalf", "dan", "den", "do", "e", "eep", "el", "eng", "er", "ere",
    "erk", "esh", "evs", "fa", "fid", "fore", "fri", "fu", "gan",
    "gar", "glen", "gox", "gunn", "gym", "ge", "hal", "hoy", "hu",
    "hum", "ig", "ist", "jad", "jan", "jar", "jef", "jo", "jum",
    "jun", "ka", "kel", "kra", "ku", "la", "lech", "lon", "mep",
    "mer", "mi", "mog", "mon", "mung", "mur", "nag", "nej",
    "nelg", "nep", "ner", "nes", "nih", "nin", "o", "od", "ood",
    "org", "orn", "ox", "oxy", "pay", "ple", "plu", "po", "pot",
    "prok", "re", "rea", "rhov", "ri", "ro", "rog", "rok", "rol",
    "ron", "rox", "ru", "sed", "ser", "shan", "shar", "sher", "shu",
    "ski", "sna", "sne", "sno", "so", "sol", "sri", "sta", "sun",
    "ta", "tab", "tem", "ther", "ti", "tox", "trol", "tue", "turs",
    "u", "ulk", "um", "un", "uni", "ur", "val", "viv", "vly", "vom",
    "wah", "wed", "werg", "wex", "whon", "wun", "xo", "yot", "yu",
    "zant", "zap", "zeb", "zer", "zy", "zyme", "zon",
]

_RING_GEMS: list[str] = [
    "agate", "alexandrite", "amethyst", "carnelian", "diamond", "emerald",
    "garnet", "jade", "kryptonite", "lapis lazuli", "moonstone", "obsidian",
    "onyx", "opal", "pearl", "peridot", "ruby", "sapphire", "tiger eye",
    "topaz", "turquoise", "zircon",
]

_WAND_MATERIALS: list[str] = [
    "avocado wood", "balsa", "bamboo", "birch", "cedar", "cherry",
    "cinnibar", "curved", "cypress", "dogwood", "driftwood", "ebony",
    "elm", "eucalyptus", "glass", "iron", "knotty", "larch", "leather",
    "maple", "marble", "mithril", "muddy", "oak", "ornate", "pine",
    "poplar", "redwood", "rough", "runed", "rusty", "silver", "slime",
    "spruce", "steel", "strange", "teak", "titanium", "twisted", "willow",
]


def _make_scroll_title() -> str:
    """ランダムな呪文タイトルを 2〜4 音節で生成する。"""
    n = random.randint(2, 4)
    return " ".join(random.choice(_SCROLL_SYLLABLES) for _ in range(n))


# ===========================================================================
# アイテム情報テーブル（NamedTuple）
# ===========================================================================

class PotionInfo(NamedTuple):
    name:  str
    prob:  int   # 出現確率（合計 100）
    worth: int   # 基本金貨価値


class ScrollInfo(NamedTuple):
    name:  str
    prob:  int
    worth: int


class WeaponInfo(NamedTuple):
    name:    str
    prob:    int
    worth:   int
    damage:  str    # 近接ダメージ文字列
    hurldmg: str    # 投擲ダメージ文字列
    flags:   int    # ISMISL / ISMANY
    launch:  int    # 発射に必要な武器インデックス（-1=不要）


class ArmorInfo(NamedTuple):
    name:  str
    prob:  int
    worth: int
    ac:    int   # 基本アーマークラス


class RingInfo(NamedTuple):
    name:  str
    prob:  int
    worth: int


class StickInfo(NamedTuple):
    name:     str
    prob:     int
    worth:    int
    is_staff: bool   # True=スタッフ, False=ワンド
    charges:  int    # デフォルト充填数


# ---------------------------------------------------------------------------
# ポーション情報テーブル（MAXPOTIONS=14）  合計=100
# ---------------------------------------------------------------------------
# assert sum(p.prob for p in POTION_INFO) == 100
POTION_INFO: list[PotionInfo] = [   # Rogue 5.4.4 extern.c pot_info[]
    PotionInfo("confusion",            7,    5),   # 0  P_CONFUSE
    PotionInfo("hallucination",        8,    5),   # 1  P_LSD
    PotionInfo("poison",               8,    5),   # 2  P_POISON
    PotionInfo("gain strength",       13,  150),   # 3  P_STRENGTH
    PotionInfo("see invisible",        3,  100),   # 4  P_SEEINVIS
    PotionInfo("healing",             13,  130),   # 5  P_HEALING
    PotionInfo("monster detection",    6,  130),   # 6  P_MFIND
    PotionInfo("magic detection",      6,  105),   # 7  P_TFIND
    PotionInfo("raise level",          2,  250),   # 8  P_RAISE
    PotionInfo("extra healing",        5,  200),   # 9  P_XHEAL
    PotionInfo("haste self",           5,  190),   # 10 P_HASTE
    PotionInfo("restore strength",    13,  130),   # 11 P_RESTORE
    PotionInfo("blindness",            5,    5),   # 12 P_BLIND
    PotionInfo("levitation",           6,   75),   # 13 P_LEVIT
]
assert sum(p.prob for p in POTION_INFO) == 100, f"POTION_INFO prob sum={sum(p.prob for p in POTION_INFO)}"

# ---------------------------------------------------------------------------
# スクロール情報テーブル（MAXSCROLLS=18）  合計=100  Rogue 5.4.4 extern.c scr_info[]
# 遊びやすさのための改変: 識別の巻物5種（S_ID_*）は1種類 "identify" に統合し、
# 生成時に S_ID_POTION へ正規化する（出現率は5種の合計 43）。
# ---------------------------------------------------------------------------
SCROLL_INFO: list[ScrollInfo] = [
    ScrollInfo("monster confusion",     7,  140),   # 0  S_CONFUSE
    ScrollInfo("magic mapping",         4,  150),   # 1  S_MAP
    ScrollInfo("hold monster",          2,  180),   # 2  S_HOLD
    ScrollInfo("sleep",                 3,    5),   # 3  S_SLEEP
    ScrollInfo("enchant armor",         7,  160),   # 4  S_ARMOR
    ScrollInfo("identify",             10,   80),   # 5  S_ID_POTION (統合識別 先頭)
    ScrollInfo("identify",             10,   80),   # 6  S_ID_SCROLL (→正規化)
    ScrollInfo("identify",              6,   80),   # 7  S_ID_WEAPON (→正規化)
    ScrollInfo("identify",              7,  100),   # 8  S_ID_ARMOR  (→正規化)
    ScrollInfo("identify",             10,  115),   # 9  S_ID_R_OR_S (→正規化)
    ScrollInfo("scare monster",         3,  200),   # 10 S_SCARE
    ScrollInfo("food detection",        2,   60),   # 11 S_FDET
    ScrollInfo("teleportation",         5,  165),   # 12 S_TELEP
    ScrollInfo("enchant weapon",        8,  150),   # 13 S_ENCH
    ScrollInfo("create monster",        4,   75),   # 14 S_CREATE
    ScrollInfo("remove curse",          7,  105),   # 15 S_REMOVE
    ScrollInfo("aggravate monsters",    3,   20),   # 16 S_AGGR
    ScrollInfo("protect armor",         2,  250),   # 17 S_PROTECT
]
assert sum(s.prob for s in SCROLL_INFO) == 100, f"SCROLL_INFO prob sum={sum(s.prob for s in SCROLL_INFO)}"

# ---------------------------------------------------------------------------
# 武器情報テーブル（MAXWEAPONS=9）  合計=100
# Rogue 5.4.4 extern.c weap_info[] / weapons.c init_dam[]。
# MAXWEAPONS=9 は FLAME 番兵（ドラゴンのブレス）に使用するため実武器は 0〜8。
# ---------------------------------------------------------------------------
WEAPON_INFO: list[WeaponInfo] = [
    WeaponInfo("mace",              11,  8,  "2d4", "1d3", 0,                           -1),   # 0 MACE
    WeaponInfo("long sword",        11, 15,  "3d4", "1d2", 0,                           -1),   # 1 SWORD
    WeaponInfo("short bow",         12, 15,  "1d1", "1d1", 0,                           -1),   # 2 BOW
    WeaponInfo("arrow",             12,  1,  "1d1", "2d3", ISMANY|ISMISL,               BOW),  # 3 ARROW
    WeaponInfo("dagger",             8,  3,  "1d6", "1d4", ISMISL,                      -1),   # 4 DAGGER
    WeaponInfo("two handed sword",  10, 75,  "4d4", "1d2", 0,                           -1),   # 5 TWOSWORD
    WeaponInfo("dart",              12,  2,  "1d1", "1d3", ISMANY|ISMISL,               -1),   # 6 DART
    WeaponInfo("shuriken",          12,  5,  "1d2", "2d4", ISMANY|ISMISL,               -1),   # 7 SHIRAKEN
    WeaponInfo("spear",             12,  5,  "2d3", "1d6", ISMISL,                      -1),   # 8 SPEAR
]
assert sum(w.prob for w in WEAPON_INFO) == 100, f"WEAPON_INFO prob sum={sum(w.prob for w in WEAPON_INFO)}"

# ---------------------------------------------------------------------------
# 防具情報テーブル（MAXARMORS=8）  合計=100
# ---------------------------------------------------------------------------
ARMOR_INFO: list[ArmorInfo] = [
    ArmorInfo("leather armor",     20,  20, 8),   # 0 LEATHER
    ArmorInfo("ring mail",         15,  25, 7),   # 1 RING_MAIL
    ArmorInfo("studded leather",   15,  20, 7),   # 2 STUDDED_LEATHER
    ArmorInfo("scale mail",        13,  30, 6),   # 3 SCALE_MAIL
    ArmorInfo("chain mail",        12,  75, 5),   # 4 CHAIN_MAIL
    ArmorInfo("splint mail",       10,  80, 4),   # 5 SPLINT_MAIL
    ArmorInfo("banded mail",       10,  90, 4),   # 6 BANDED_MAIL
    ArmorInfo("plate mail",         5, 150, 3),   # 7 PLATE_MAIL
]
assert sum(a.prob for a in ARMOR_INFO) == 100, f"ARMOR_INFO prob sum={sum(a.prob for a in ARMOR_INFO)}"

# ---------------------------------------------------------------------------
# 指輪情報テーブル（MAXRINGS=14）  有効13種合計=100、R_SUSTARM(13)はprob=0
# ---------------------------------------------------------------------------
RING_INFO: list[RingInfo] = [   # Rogue 5.4.4 extern.c ring_info[]
    RingInfo("protection",          9, 400),   # 0  R_PROTECT
    RingInfo("add strength",        9, 400),   # 1  R_ADDSTR
    RingInfo("sustain strength",    5, 280),   # 2  R_SUSTSTR
    RingInfo("searching",          10, 420),   # 3  R_SEARCH
    RingInfo("see invisible",      10, 310),   # 4  R_SEEINVIS
    RingInfo("adornment",           1,  10),   # 5  R_NOP
    RingInfo("aggravate monster",  10,  10),   # 6  R_AGGR      (必ず呪い)
    RingInfo("dexterity",           8, 440),   # 7  R_ADDHIT
    RingInfo("increase damage",     8, 400),   # 8  R_ADDDAM
    RingInfo("regeneration",        4, 460),   # 9  R_REGEN
    RingInfo("slow digestion",      9, 240),   # 10 R_DIGEST
    RingInfo("teleportation",       5,  30),   # 11 R_TELEPORT  (必ず呪い)
    RingInfo("stealth",             7, 470),   # 12 R_STEALTH
    RingInfo("maintain armor",      5, 380),   # 13 R_SUSTARM
]
assert sum(r.prob for r in RING_INFO) == 100, f"RING_INFO prob sum={sum(r.prob for r in RING_INFO)}"

# ---------------------------------------------------------------------------
# 杖/ワンド情報テーブル（MAXSTICKS=14）  合計=100
# charges フィールドは make_stick() で上書きされる（LIGHT=10-19、他=3-7）
# Rogue 5.4.4 extern.c ws_info[]
# ---------------------------------------------------------------------------
STICK_INFO: list[StickInfo] = [
    StickInfo("light",             12, 250, False, 10),   # 0  WS_LIGHT
    StickInfo("invisibility",       6,   5, False,  5),   # 1  WS_INVIS
    StickInfo("lightning",          3, 330, False,  5),   # 2  WS_ELECT
    StickInfo("fire",               3, 330, False,  5),   # 3  WS_FIRE
    StickInfo("cold",               3, 330, False,  5),   # 4  WS_COLD
    StickInfo("polymorph",         15, 310,  True,  5),   # 5  WS_POLYMORPH
    StickInfo("magic missile",     10, 170, False,  5),   # 6  WS_MISSILE
    StickInfo("haste monster",     10,   5,  True,  5),   # 7  WS_HASTE_M
    StickInfo("slow monster",      11, 350,  True,  5),   # 8  WS_SLOW_M
    StickInfo("drain life",         9, 300, False,  5),   # 9  WS_DRAIN
    StickInfo("nothing",            1,   5, False,  5),   # 10 WS_NOP
    StickInfo("teleport away",      6, 340,  True,  5),   # 11 WS_TELAWAY
    StickInfo("teleport to",        6,  50,  True,  5),   # 12 WS_TELTO
    StickInfo("cancellation",       5, 280, False,  5),   # 13 WS_CANCEL
]
assert sum(s.prob for s in STICK_INFO) == 100, f"STICK_INFO prob sum={sum(s.prob for s in STICK_INFO)}"

# アイテム種別出現確率（合計 100）  Rogue 5.4.4 extern.c things[]
_THING_PROBS: list[tuple[str, int]] = [
    (CH_POTION, 26),
    (CH_SCROLL, 36),
    (CH_FOOD,   16),
    (CH_WEAPON,  7),
    (CH_ARMOR,   7),
    (CH_RING,    4),
    (CH_STICK,   4),
]
assert sum(w for _, w in _THING_PROBS) == 100, f"_THING_PROBS sum={sum(w for _, w in _THING_PROBS)}"


# ===========================================================================
# GameKnowledge: ゲームごとの識別状態管理
# ===========================================================================

class GameKnowledge:
    """1ゲームを通じたアイテム識別状態と外観対応を管理するクラス。"""

    def __init__(self) -> None:
        self._p_known:  list[bool] = [False] * MAXPOTIONS
        self._s_known:  list[bool] = [False] * MAXSCROLLS
        self._r_known:  list[bool] = [False] * MAXRINGS
        self._ws_known: list[bool] = [False] * MAXSTICKS

        self._p_guess:  list[str] = [''] * MAXPOTIONS
        self._s_guess:  list[str] = [''] * MAXSCROLLS
        self._r_guess:  list[str] = [''] * MAXRINGS
        self._ws_guess: list[str] = [''] * MAXSTICKS

        self._p_appear:  list[str] = []
        self._s_appear:  list[str] = []
        self._r_appear:  list[str] = []
        self._ws_appear: list[str] = []

        self._randomize()

    def _randomize(self) -> None:
        self._p_appear  = random.sample(_POTION_COLORS, MAXPOTIONS)
        self._s_appear  = [_make_scroll_title() for _ in range(MAXSCROLLS)]
        self._r_appear  = random.sample(_RING_GEMS, MAXRINGS)
        self._ws_appear = random.sample(_WAND_MATERIALS, MAXSTICKS)

    # ---- 識別 ----

    def is_known(self, o_type: str, o_which: int) -> bool:
        tbl = self._known_table(o_type)
        if tbl is None or not (0 <= o_which < len(tbl)):
            return True
        return tbl[o_which]

    def know(self, o_type: str, o_which: int) -> None:
        tbl = self._known_table(o_type)
        if tbl is not None and 0 <= o_which < len(tbl):
            tbl[o_which] = True

    def _known_table(self, o_type: str) -> Optional[list[bool]]:
        if o_type == CH_POTION: return self._p_known
        if o_type == CH_SCROLL: return self._s_known
        if o_type == CH_RING:   return self._r_known
        if o_type == CH_STICK:  return self._ws_known
        return None

    # ---- 外観 ----

    def get_appearance(self, o_type: str, o_which: int) -> str:
        if o_type == CH_POTION and 0 <= o_which < MAXPOTIONS:
            return self._p_appear[o_which]
        if o_type == CH_SCROLL and 0 <= o_which < MAXSCROLLS:
            return self._s_appear[o_which]
        if o_type == CH_RING   and 0 <= o_which < MAXRINGS:
            return self._r_appear[o_which]
        if o_type == CH_STICK  and 0 <= o_which < MAXSTICKS:
            return self._ws_appear[o_which]
        return tr('unknown')

    # ---- 推測ラベル ----

    def get_guess(self, o_type: str, o_which: int) -> str:
        tbl = self._guess_table(o_type)
        if tbl and 0 <= o_which < len(tbl):
            return tbl[o_which]
        return ''

    def set_guess(self, o_type: str, o_which: int, guess: str) -> None:
        tbl = self._guess_table(o_type)
        if tbl and 0 <= o_which < len(tbl):
            tbl[o_which] = guess

    def _guess_table(self, o_type: str) -> Optional[list[str]]:
        if o_type == CH_POTION: return self._p_guess
        if o_type == CH_SCROLL: return self._s_guess
        if o_type == CH_RING:   return self._r_guess
        if o_type == CH_STICK:  return self._ws_guess
        return None

    # ---- 表示名 ----

    def display_name(self, item: 'Item') -> str:
        ot = item.o_type
        ow = item.o_which

        if ot == CH_POTION:
            if self.is_known(ot, ow):
                return tr('a potion of {name}', name=tr_name('potion', POTION_INFO[ow].name))
            app = tr_name('color', self.get_appearance(ot, ow))
            guess = self.get_guess(ot, ow)
            return (tr('a {app} potion called {guess}', app=app, guess=guess) if guess
                    else tr('a {app} potion', app=app))

        if ot == CH_SCROLL:
            if self.is_known(ot, ow):
                return tr('a scroll of {name}', name=tr_name('scroll', SCROLL_INFO[ow].name))
            title = self.get_appearance(ot, ow)
            if is_ja():   # 音節ごとにカタカナにする（セーブの中身は英字のまま）
                title = '・'.join(tr_name('syllable', s) for s in title.split())
            guess = self.get_guess(ot, ow)
            return (tr("a scroll titled '{title}' called {guess}", title=title, guess=guess) if guess
                    else tr("a scroll titled '{title}'", title=title))

        if ot == CH_RING:
            if self.is_known(ot, ow):
                enc = _enchant_str(item.o_arm, item.o_flags)
                return tr('{enc}a ring of {name}', enc=enc, name=tr_name('ring', RING_INFO[ow].name))
            app = tr_name('gem', self.get_appearance(ot, ow))
            guess = self.get_guess(ot, ow)
            return (tr('a {app} ring called {guess}', app=app, guess=guess) if guess
                    else tr('a {app} ring', app=app))

        if ot == CH_STICK:
            info = STICK_INFO[ow]
            kind = tr_name('stick_kind', "staff" if info.is_staff else "wand")
            if self.is_known(ot, ow):
                return tr('a {kind} of {name} [{o_arm} charges]',
                          kind=kind, name=tr_name('stick', info.name), o_arm=item.o_arm)
            app = tr_name('wood', self.get_appearance(ot, ow))
            guess = self.get_guess(ot, ow)
            return (tr('a {app} {kind} called {guess}', app=app, kind=kind, guess=guess) if guess
                    else tr('a {app} {kind}', app=app, kind=kind))

        if ot == CH_WEAPON:
            return _weapon_display_name(item)

        if ot == CH_ARMOR:
            return _armor_display_name(item)

        if ot == CH_FOOD:
            return tr('a ration of food') if item.o_which == 0 else tr('some slime-mold')

        if ot == CH_GOLD:
            return tr('{o_arm} gold pieces', o_arm=item.o_arm)

        if ot == CH_AMULET:
            return tr('the Amulet of Yendor')

        return tr('unknown item')


def _enchant_str(o_arm: int, o_flags: int) -> str:
    if o_flags & ISCURSED:
        return tr('cursed ')
    return ""


def _a_or_n(name: str) -> str:
    return "n" if name and name[0] in "aeiou" else ""


def _weapon_display_name(item: 'Item') -> str:
    if not (0 <= item.o_which < len(WEAPON_INFO)):
        return tr('unknown weapon')
    info = WEAPON_INFO[item.o_which]
    cnt = item.o_count
    known = bool(item.o_flags & ISKNOW)
    cursed = tr("cursed ") if known and (item.o_flags & ISCURSED) else ""
    bonus = f"{item.o_hplus:+d},{item.o_dplus:+d} " if known else ""
    if is_ja():
        # 例: 「+1,+1のメイス」「25本の+0,+0の矢」「呪われた-1,+0のメイス」
        wname = tr_name('weapon', info.name)
        count = tr_name('counter', info.name).format(n=cnt) if cnt > 1 else ""
        return f"{count}{cursed}{bonus.strip()}{'の' if bonus else ''}{wname}"
    if cnt > 1:
        return f"{cnt} {cursed}{bonus}{info.name}s"
    return f"a {cursed}{bonus}{info.name}"


def _armor_display_name(item: 'Item') -> str:
    if item.o_which >= MAXARMORS:
        return tr('unknown armor')
    info = ARMOR_INFO[item.o_which]
    if not (item.o_flags & ISKNOW):
        return tr_name('armor', info.name)
    cursed = tr("cursed ") if (item.o_flags & ISCURSED) else ""
    prot   = tr("protected ") if (item.o_flags & ISPROT) else ""
    return f"{cursed}{prot}{tr_name('armor', info.name)} [{item.o_arm}]"


# ===========================================================================
# モジュールレベルシングルトン
# ===========================================================================

_knowledge: Optional[GameKnowledge] = None


def get_knowledge() -> GameKnowledge:
    global _knowledge
    if _knowledge is None:
        _knowledge = GameKnowledge()
    return _knowledge


def init_knowledge() -> GameKnowledge:
    global _knowledge
    _knowledge = GameKnowledge()
    return _knowledge


def set_knowledge(k: GameKnowledge) -> None:
    global _knowledge
    _knowledge = k


# ===========================================================================
# Item データクラス
# ===========================================================================

@dataclass
class Item:
    """
    Rogue 5.4 の struct_thing.o_* フィールドに対応するアイテムオブジェクト。
    o_arm は文脈によって防具AC・充填数・金貨価値として使われる（aliases:
    o_charges=o_arm, o_goldval=o_arm）。
    """

    o_type:    str         # アイテム種別文字
    o_which:   int         # 種別内インデックス
    o_packch:  str  = ''   # インベントリスロット文字 (a–z)
    o_damage:  str  = "1x1"
    o_hurldmg: str  = "1x1"
    o_count:   int  = 1
    o_hplus:   int  = 0    # 命中ボーナス
    o_dplus:   int  = 0    # ダメージボーナス
    o_arm:     int  = 0    # AC / 充填数 / 金貨価値
    o_flags:   int  = 0    # ISCURSED / ISKNOW / ISMISL / ISMANY …
    o_group:   int  = 0    # スタックグループ番号
    o_label:   str  = ''   # プレイヤーラベル
    o_launch:  int  = -1   # 発射に必要な武器インデックス（-1=不要）

    # ---- o_arm エイリアス ----

    @property
    def o_charges(self) -> int:
        return self.o_arm

    @o_charges.setter
    def o_charges(self, v: int) -> None:
        self.o_arm = v

    @property
    def o_goldval(self) -> int:
        return self.o_arm

    @o_goldval.setter
    def o_goldval(self, v: int) -> None:
        self.o_arm = v

    # ---- 便宜プロパティ ----

    @property
    def is_cursed(self) -> bool:
        return bool(self.o_flags & ISCURSED)

    @property
    def is_known_flag(self) -> bool:
        return bool(self.o_flags & ISKNOW)

    def display_name(self, knowledge: Optional[GameKnowledge] = None) -> str:
        k = knowledge or get_knowledge()
        return k.display_name(self)

    @property
    def name(self) -> str:
        """ui.py の show_inventory などから参照される表示名。"""
        return self.display_name()

    @property
    def ch(self) -> str:
        """ui.py の draw_all が期待する種別文字。"""
        return self.o_type

    def __repr__(self) -> str:
        return f"<Item {self.o_type!r} which={self.o_which} flags={self.o_flags:#x}>"


# ===========================================================================
# ファクトリ関数
# ===========================================================================

def _weighted_choice(table: list, prob_attr: str = 'prob') -> int:
    total = sum(getattr(t, prob_attr) for t in table)
    r = random.randint(1, total)
    acc = 0
    for i, t in enumerate(table):
        acc += getattr(t, prob_attr)
        if r <= acc:
            return i
    return len(table) - 1


def _weighted_choice_tuples(pairs: list[tuple[str, int]]) -> str:
    total = sum(w for _, w in pairs)
    r = random.randint(1, total)
    acc = 0
    for v, w in pairs:
        acc += w
        if r <= acc:
            return v
    return pairs[-1][0]


def make_potion(which: Optional[int] = None) -> Item:
    if which is None:
        which = _weighted_choice(POTION_INFO)
    return Item(o_type=CH_POTION, o_which=which, o_count=1)


def make_scroll(which: Optional[int] = None) -> Item:
    if which is None:
        which = _weighted_choice(SCROLL_INFO)
    # 識別の巻物5種は1種類に統合（遊びやすさのための改変）
    if which in (S_ID_SCROLL, S_ID_WEAPON, S_ID_ARMOR, S_ID_R_OR_S):
        which = S_ID_POTION
    return Item(o_type=CH_SCROLL, o_which=which, o_count=1)


def make_weapon(which: Optional[int] = None, cursed: bool = False) -> Item:
    if which is None:
        which = _weighted_choice(WEAPON_INFO)
    info = WEAPON_INFO[which]
    hplus = 0
    flags = info.flags
    if cursed:
        hplus = -random.randint(1, 3)
        flags |= ISCURSED
    else:
        # 強化5%・呪い10%・通常85%（Rogue 5.4 準拠）
        r = random.randint(1, 20)
        if r == 1:          # 5% 強化
            hplus = random.randint(1, 3)
        elif r <= 3:        # 10% 呪い
            hplus = -random.randint(1, 3)
            flags |= ISCURSED
    cnt = random.randint(0, 7) + 8 if (info.flags & ISMANY) else 1   # rnd(8)+8
    return Item(
        o_type=CH_WEAPON, o_which=which,
        o_damage=info.damage, o_hurldmg=info.hurldmg,
        o_count=cnt, o_hplus=hplus, o_dplus=0,
        o_flags=flags, o_launch=info.launch,
    )


def make_armor(which: Optional[int] = None, cursed: bool = False) -> Item:
    if which is None:
        which = _weighted_choice(ARMOR_INFO)
    info = ARMOR_INFO[which]
    bonus = 0
    flags = 0
    if cursed:
        bonus = random.randint(1, 3)   # AC 悪化（呪い）
        flags = ISCURSED
    else:
        # 呪い20%・強化8%・通常72%（Rogue 5.4 準拠）
        r = random.randint(1, 25)
        if r <= 5:      # 20% 呪い：AC +1〜+3（数値増加＝悪化）
            bonus = random.randint(1, 3)
            flags = ISCURSED
        elif r <= 7:    # 8% 強化：AC -1〜-3（数値減少＝改善）
            bonus = -random.randint(1, 3)
    actual_ac = info.ac + bonus
    return Item(o_type=CH_ARMOR, o_which=which, o_arm=actual_ac, o_flags=flags)


def make_ring(which: Optional[int] = None, cursed: bool = False) -> Item:
    if which is None:
        which = _weighted_choice(RING_INFO)
    enchant = 0
    needs_enchant = which in (R_PROTECT, R_ADDSTR, R_ADDHIT, R_ADDDAM)
    if needs_enchant:
        if cursed:
            enchant = -1
        else:
            # 1/3: +1、1/3: +2、1/3: -1（呪い）  Rogue 5.4 準拠
            r = random.randint(0, 2)
            enchant = 1 if r == 0 else (2 if r == 1 else -1)
    flags = 0
    if cursed or enchant < 0 or which in (R_AGGR, R_TELEPORT):
        flags |= ISCURSED
    return Item(o_type=CH_RING, o_which=which, o_arm=enchant, o_flags=flags)


def make_stick(which: Optional[int] = None) -> Item:
    if which is None:
        which = _weighted_choice(STICK_INFO)
    # LIGHT のみ 10〜19 チャージ、その他は 3〜7  Rogue 5.4 準拠
    if which == WS_LIGHT:
        charges = random.randint(10, 19)
    else:
        charges = random.randint(3, 7)
    return Item(o_type=CH_STICK, o_which=which, o_arm=charges)


def make_food(which: int = 0) -> Item:
    return Item(o_type=CH_FOOD, o_which=which, o_count=1)


def make_gold(floor_level: int) -> Item:
    amount = random.randint(0, 49 + 10 * floor_level) + 2   # GOLDCALC
    return Item(o_type=CH_GOLD, o_which=0, o_arm=amount)


def make_amulet() -> Item:
    return Item(o_type=CH_AMULET, o_which=0)


def make_random_item(floor_level: int) -> Item:
    """フロアレベルに応じたランダムアイテムを生成する。"""
    o_type = _weighted_choice_tuples(_THING_PROBS)
    if o_type == CH_POTION:
        return make_potion()
    if o_type == CH_SCROLL:
        return make_scroll()
    if o_type == CH_WEAPON:
        return make_weapon()   # 呪い/強化確率は make_weapon() 内で処理
    if o_type == CH_ARMOR:
        return make_armor()    # 呪い/強化確率は make_armor() 内で処理
    if o_type == CH_RING:
        return make_ring()     # 呪い/強化確率は make_ring() 内で処理
    if o_type == CH_STICK:
        return make_stick()
    # CH_FOOD
    return make_food(1 if random.randint(0, 9) == 0 else 0)


# ===========================================================================
# ポーション効果
# ===========================================================================

def use_potion(
    item:        Item,
    player:      'Player',
    dungeon:     'Dungeon',
    knowledge:   GameKnowledge,
    monsters:    list['Monster'],
    floor_items: list[Item] = None,
) -> list[str]:
    """ポーションを使用する。knowledge を更新し、プレイヤーへ効果を適用する。"""
    which = item.o_which
    msgs: list[str] = []
    was_known = knowledge.is_known(CH_POTION, which)
    knowledge.know(CH_POTION, which)
    item.o_flags |= ISKNOW

    if which == P_CONFUSE:
        msgs.append(player.apply_confusion(HUHDURATION - CONFUSE_CUT))   # 5.4: HUHDURATION

    elif which == P_LSD:
        player.apply_hallucination(_spread(SEEDURATION - SIGHT_POTION_CUT))
        msgs.append(tr('Oh, wow!  Everything seems so cosmic!'))

    elif which == P_POISON:
        if player._has_ring(R_SUSTSTR):
            msgs.append(tr('You feel momentarily sick.'))
        else:
            msgs.append(tr('You feel very sick now.'))
            delta = -random.randint(1, 3)
            msg = player.modify_str(delta)
            if msg:
                msgs.append(msg)

    elif which == P_STRENGTH:
        player.increase_max_str(1)
        msgs.append(tr('You feel stronger! (STR {str_max})', str_max=player.str_max))

    elif which == P_SEEINVIS:
        msgs.append(player.apply_see_invisible(SEEDURATION))

    elif which == P_HEALING:
        was_full = player.hp >= player.max_hp
        amount = roll(player.level, 4)
        player.heal(amount)
        if not was_full:
            player.max_hp += 1
        if player.status.blind > 0:
            msgs.append(player.cure_blindness())
        msgs.append(tr('You begin to feel better. (HP {hp}/{max_hp})', hp=player.hp, max_hp=player.max_hp))

    elif which == P_MFIND:
        alive = [m for m in monsters if m.is_alive]
        if alive:
            for m in alive:
                m.flags |= ISFOUND
        else:
            msgs.append(tr('You sense no monsters nearby.'))

    elif which == P_TFIND:
        pass   # game.py で ui.show_all_objects() を呼び出す

    elif which == P_RAISE:
        from player import _MAX_LEVEL
        from constants import LEVEL_HP_BONUS
        if player.level >= _MAX_LEVEL:
            hp_gain = roll(1, 10) + LEVEL_HP_BONUS
            player.max_hp += hp_gain
            player.hp = min(player.max_hp, player.hp + hp_gain)
            msgs.append(tr('You feel a surge of power!'))
        else:
            needed = _next_level_exp(player)
            lvl_msgs = player.gain_exp(max(0, needed - player.exp))
            if lvl_msgs:
                msgs.extend(lvl_msgs)
            else:
                hp_gain = roll(1, 10)
                player.max_hp += hp_gain
                player.hp = min(player.max_hp, player.hp + hp_gain)
                msgs.append(tr('You feel a surge of power!'))

    elif which == P_XHEAL:
        was_full = player.hp >= player.max_hp
        amount = roll(player.level, 8)
        player.heal(amount)
        if not was_full:
            player.max_hp += 2
        if player.status.blind > 0:
            msgs.append(player.cure_blindness())
        if player.status.confused > 0:
            msgs.append(player.cure_confusion())
        msgs.append(tr('You feel much better! (HP {hp}/{max_hp})', hp=player.hp, max_hp=player.max_hp))

    elif which == P_HASTE:
        if player.status.is_slowed:
            player.status.slowed = 0
            msgs.append(tr('You feel yourself speeding up.'))
        else:
            turns = HUHDURATION + random.randint(0, HUHDURATION // 2)
            msgs.append(player.apply_haste(turns))

    elif which == P_RESTORE:
        msg = player.restore_str()
        msgs.append(msg if msg else tr('You feel your strength returning.'))

    elif which == P_BLIND:
        msgs.append(player.apply_blindness(_spread(SEEDURATION - SIGHT_POTION_CUT)))   # 5.4: SEEDURATION

    elif which == P_LEVIT:
        turns = HUHDURATION + random.randint(0, HUHDURATION)
        msgs.append(player.apply_levitation(turns))

    if not was_known:
        msgs.append(tr('That was a potion of {name}.', name=tr_name('potion', POTION_INFO[which].name)))

    return msgs


def _next_level_exp(player: 'Player') -> int:
    """次レベル到達に必要な累積経験値。"""
    from player import _EXP_TABLE, _MAX_LEVEL
    if player.level >= _MAX_LEVEL:
        return player.exp + 1000
    return _EXP_TABLE[player.level - 1]


# ===========================================================================
# スクロール効果
# ===========================================================================

def use_scroll(
    item:        Item,
    player:      'Player',
    dungeon:     'Dungeon',
    knowledge:   GameKnowledge,
    monsters:    list['Monster'],
    floor_items: list[Item],
    target_item: Optional[Item] = None,
) -> list[str]:
    """
    スクロールを読む。
    target_item: 識別系スクロールでゲームループが選んだアイテム。
    """
    which = item.o_which
    msgs: list[str] = []
    was_known = knowledge.is_known(CH_SCROLL, which)
    knowledge.know(CH_SCROLL, which)
    item.o_flags |= ISKNOW

    if which == S_CONFUSE:
        # 次に攻撃したモンスターを混乱させるフラグをプレイヤーに付ける
        player.status.confuse_next_attack = True
        msgs.append(tr('Your hands begin to glow red.'))

    elif which == S_MAP:
        _reveal_map(dungeon)
        msgs.append(tr('You feel a sense of presence.'))

    elif which == S_HOLD:
        # 周囲2マス以内の追跡中モンスターを止める（攻撃されるまで動かない）
        held = 0
        for m in monsters:
            if (m.is_alive and m.flags & ISRUN
                    and abs(m.y - player.y) <= 2 and abs(m.x - player.x) <= 2):
                m.flags &= ~ISRUN
                m.flags |= ISHELD
                held += 1
        if held:
            msgs.append(tr('The monsters around you freeze.') if held > 1
                        else tr('The monster freezes.'))
        else:
            msgs.append(tr('You feel a strange sense of loss.'))

    elif which == S_SLEEP:
        turns = random.randint(0, _get_spread('SLEEPTIME', 5) - 1) + 4   # rnd(SLEEPTIME)+4
        player.status.paralyzed += turns
        msgs.append(tr('You fall asleep.'))

    elif which == S_ARMOR:
        if player.armor is not None:
            if player.armor.is_cursed:
                player.armor.o_flags &= ~ISCURSED
                msgs.append(tr('Your armor glows silver for a moment.'))
            else:
                old_ac = player.armor.o_arm
                player.armor.o_arm -= 1
                msgs.append(
                    tr('Your armor glows faintly for a moment. (AC {old_ac} -> {o_arm})', old_ac=old_ac, o_arm=player.armor.o_arm)
                )
        else:
            msgs.append(tr('You feel a magical aura around you.'))

    elif which in (S_ID_POTION, S_ID_SCROLL, S_ID_WEAPON, S_ID_ARMOR, S_ID_R_OR_S):
        msgs.extend(_do_identify(player, knowledge, target_item))

    elif which == S_SCARE:
        # 読むのは間違い。笑い声が聞こえるだけ（5.4 scrolls.c）
        msgs.append(tr('You hear maniacal laughter in the distance.'))

    elif which == S_FDET:
        pass   # game.py で食料の位置を表示する

    elif which == S_TELEP:
        old_y, old_x = player.y, player.x
        pos = dungeon.teleport_player(player.y, player.x)
        player.y, player.x = pos.y, pos.x
        msgs.append(tr('You feel a wrenching sensation. ({old_y},{old_x}) -> ({y},{x})', old_y=old_y, old_x=old_x, y=player.y, x=player.x))

    elif which == S_ENCH:
        if player.weapon is not None:
            if player.weapon.is_cursed:
                player.weapon.o_flags &= ~ISCURSED
                msgs.append(tr('Your weapon glows silver for a moment.'))
            else:
                if random.randint(0, 1) == 0:
                    old = player.weapon.o_hplus
                    player.weapon.o_hplus += 1
                    msgs.append(
                        tr('Your weapon glows blue for a moment. (hit {old:+d} -> {o_hplus:+d})', old=old, o_hplus=player.weapon.o_hplus)
                    )
                else:
                    old = player.weapon.o_dplus
                    player.weapon.o_dplus += 1
                    msgs.append(
                        tr('Your weapon glows red for a moment. (dmg {old:+d} -> {o_dplus:+d})', old=old, o_dplus=player.weapon.o_dplus)
                    )
        else:
            msgs.append(tr('You feel a momentary surge of power.'))

    elif which == S_CREATE:
        _create_monster_near(dungeon, player, monsters)
        msgs.append(tr('You hear a strange noise.'))

    elif which == S_REMOVE:
        count = 0
        for eq in _all_equipped(player):
            if eq is not None and eq.is_cursed:
                eq.o_flags &= ~ISCURSED
                count += 1
        msgs.append(tr('You feel as if somebody is watching over you.')
                    if count else tr('You feel protected.'))

    elif which == S_AGGR:
        for m in monsters:
            if m.is_alive:
                m.flags |= ISRUN
        msgs.append(tr('You hear a high-pitched humming noise.'))

    elif which == S_PROTECT:  # 装備中の防具に ISPROT を付与
        if player.armor is not None:
            player.armor.o_flags |= ISPROT
            msgs.append(tr('Your armor glows golden for a moment.'))
        else:
            msgs.append(tr('You feel protected.'))

    if not was_known:
        msgs.append(tr('That was a scroll of {name}.', name=tr_name('scroll', SCROLL_INFO[which].name)))

    return msgs


def _try_remove_curse(item: Item) -> bool:
    return False   # 呼び出し側で直接フラグを操作するため常に False


def _reveal_map(dungeon: 'Dungeon') -> None:
    from constants import F_SEEN
    for row in dungeon.map:
        for tile in row:
            if tile.ch not in (' ',):
                tile.flags |= F_SEEN


def _do_identify(
    player:      'Player',
    knowledge:   GameKnowledge,
    target_item: Optional[Item],
) -> list[str]:
    if target_item is None:
        return [tr('You feel an urge to identify something.')]
    target_item.o_flags |= ISKNOW
    knowledge.know(target_item.o_type, target_item.o_which)
    return [tr('You identify it as {item}.', item=knowledge.display_name(target_item))]


def _create_monster_near(
    dungeon:  'Dungeon',
    player:   'Player',
    monsters: list['Monster'],
) -> None:
    from monsters import spawn_monster, rand_monster_letter
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            ny, nx = player.y + dy, player.x + dx
            if dungeon.is_walkable(ny, nx):
                occupied = any(
                    m.y == ny and m.x == nx and m.is_alive
                    for m in monsters
                )
                if not occupied:
                    letter = rand_monster_letter(player.floor)
                    m = spawn_monster(letter, player.floor, ny, nx)
                    m.flags |= ISRUN
                    monsters.append(m)
                    return


def _all_equipped(player: 'Player') -> list:
    items = []
    if player.weapon is not None:
        items.append(player.weapon)
    if player.armor is not None:
        items.append(player.armor)
    items.extend(r for r in player.rings if r is not None)
    return items


# ===========================================================================
# 杖/ワンド効果
# ===========================================================================

def use_stick(
    item:      Item,
    player:    'Player',
    dungeon:   'Dungeon',
    knowledge: GameKnowledge,
    monsters:  list['Monster'],
    direction: tuple[int, int] = (0, 0),
) -> list[str]:
    """杖/ワンドを使用する。充填数 0 の場合は使用不可。"""
    msgs: list[str] = []
    if item.o_arm <= 0:
        msgs.append(tr('The wand is empty.'))
        return msgs

    item.o_arm -= 1
    which = item.o_which
    was_known = knowledge.is_known(CH_STICK, which)

    if which == WS_LIGHT:
        msgs.extend(_ws_light(dungeon, player))
        knowledge.know(CH_STICK, which)

    elif which == WS_INVIS:
        # 当たったモンスターを不可視にする（5.4 sticks.c）。見た目では分からないので識別しない
        target = _find_target(dungeon, monsters, player, direction)
        if target:
            target.flags |= ISINVIS
        else:
            msgs.append(tr('Nothing happens.'))

    elif which == WS_ELECT:
        msgs.extend(_ws_bolt(dungeon, monsters, player, direction,
                              "electric", lambda lv: roll(lv, 6)))
        knowledge.know(CH_STICK, which)

    elif which == WS_FIRE:
        msgs.extend(_ws_bolt(dungeon, monsters, player, direction,
                              "fire", lambda lv: roll(lv, 6)))
        knowledge.know(CH_STICK, which)

    elif which == WS_COLD:
        msgs.extend(_ws_bolt(dungeon, monsters, player, direction,
                              "cold", lambda lv: roll(lv, 6)))
        knowledge.know(CH_STICK, which)

    elif which == WS_POLYMORPH:
        target = _find_target(dungeon, monsters, player, direction)
        if target:
            msgs.extend(_ws_polymorph(target, player))
        else:
            msgs.append(tr('The staff pulses.'))
        knowledge.know(CH_STICK, which)

    elif which == WS_MISSILE:
        msgs.extend(_ws_bolt(dungeon, monsters, player, direction,
                              "magic missile", lambda lv: roll(1, 4) + 1))
        knowledge.know(CH_STICK, which)

    elif which == WS_HASTE_M:
        target = _find_target(dungeon, monsters, player, direction)
        if target:
            target.flags |= ISHASTE
            target.flags &= ~ISSLOW
            msgs.append(tr('The {name} starts moving faster!', name=target.name))
        else:
            msgs.append(tr('The staff pulses.'))
        knowledge.know(CH_STICK, which)

    elif which == WS_SLOW_M:
        target = _find_target(dungeon, monsters, player, direction)
        if target:
            target.flags |= ISSLOW
            target.flags &= ~ISHASTE
            msgs.append(tr('The {name} slows down.', name=target.name))
        else:
            msgs.append(tr('The staff pulses.'))
        knowledge.know(CH_STICK, which)

    elif which == WS_DRAIN:
        if player.hp <= 1:
            msgs.append(tr('You feel too weak to use it.'))
        else:
            alive = [m for m in monsters if m.is_alive]
            if alive:
                drain = player.hp // 2
                player.take_damage(drain)
                for m in alive:
                    m.hp -= drain
                    if not m.is_alive:
                        from combat import calc_exp
                        msgs.extend(player.gain_exp(calc_exp(m)))
                msgs.append(tr('You feel your life force draining away!'))
                knowledge.know(CH_STICK, which)
            else:
                msgs.append(tr('You feel your life force draining away!'))

    elif which == WS_NOP:
        msgs.append(tr('Nothing happens.'))

    elif which == WS_TELAWAY:
        target = _find_target(dungeon, monsters, player, direction)
        if target:
            pos = dungeon.teleport_monster(target.y, target.x, monsters)
            if pos:
                target.y, target.x = pos.y, pos.x
            msgs.append(tr('The {name} disappears!', name=target.name))
        else:
            msgs.append(tr('The staff pulses.'))
        knowledge.know(CH_STICK, which)

    elif which == WS_TELTO:
        target = _find_target(dungeon, monsters, player, direction)
        if target:
            placed = False
            for dy2 in (-1, 0, 1):
                for dx2 in (-1, 0, 1):
                    if dy2 == 0 and dx2 == 0:
                        continue
                    ny, nx = player.y + dy2, player.x + dx2
                    if dungeon.is_walkable(ny, nx) and not any(
                        m.y == ny and m.x == nx and m.is_alive
                        for m in monsters
                    ):
                        target.y, target.x = ny, nx
                        target.flags |= ISRUN
                        msgs.append(tr('The {name} appears before you!', name=target.name))
                        placed = True
                        break
                if placed:
                    break
        else:
            msgs.append(tr('The staff pulses.'))
        knowledge.know(CH_STICK, which)

    elif which == WS_CANCEL:
        target = _find_target(dungeon, monsters, player, direction)
        if target:
            target.flags |= ISCANC
            target.flags &= ~(ISHASTE | ISINVIS)
            msgs.append(tr('The {name} looks cancelled.', name=target.name))
        else:
            msgs.append(tr('The wand flashes.'))
        knowledge.know(CH_STICK, which)

    if not was_known and knowledge.is_known(CH_STICK, which):
        info = STICK_INFO[which]
        kind = "staff" if info.is_staff else "wand"
        msgs.append(tr('That was a {kind} of {name}.', kind=tr_name('stick_kind', kind), name=tr_name('stick', info.name)))

    return msgs


def _ws_light(dungeon: 'Dungeon', player: 'Player') -> list[str]:
    from constants import F_SEEN
    room = dungeon.find_room_at(player.y, player.x)
    if room is not None:
        room.flags &= ~ISDARK
        for r in range(room.top, room.top + room.height):
            for c in range(room.left, room.left + room.width):
                dungeon.map[r][c].flags |= F_SEEN
        return [tr('The room is lit up!')]
    return [tr('Your wand glows brightly for a moment.')]


last_bolt: Optional[dict] = None   # 直前に放った光線の道筋と当たった所（画面の演出用。game が読む）


def _ws_bolt(
    dungeon:   'Dungeon',
    monsters:  list['Monster'],
    player:    'Player',
    direction: tuple[int, int],
    bolt_name: str,
    dmg_func,
) -> list[str]:
    """
    ボルト攻撃。壁で1回反射し逆方向に進む。プレイヤーにも命中する。
    Rogue 5.4 準拠。
    """
    global last_bolt
    msgs: list[str] = []
    dy, dx = direction
    if dy == 0 and dx == 0:
        msgs.append(tr('The {bolt_name} bolt discharges harmlessly.', bolt_name=tr_name('bolt', bolt_name)))
        return msgs
    path: list[tuple[int, int]] = []
    last_bolt = {'name': bolt_name, 'path': path, 'hit': None}

    rows = len(dungeon.map)
    cols = len(dungeon.map[0]) if rows else 0

    dmg = dmg_func(player.level)
    bounced = False
    y, x = player.y + dy, player.x + dx

    for _ in range(BOLT_LENGTH * 2):
        if not (0 <= y < rows and 0 <= x < cols):
            msgs.append(tr('The {bolt_name} bolt vanishes.', bolt_name=tr_name('bolt', bolt_name)))
            return msgs

        if not dungeon.is_walkable(y, x):
            if bounced:
                msgs.append(tr('The {bolt_name} bolt vanishes.', bolt_name=tr_name('bolt', bolt_name)))
                return msgs
            bounced = True
            dy, dx = -dy, -dx
            msgs.append(tr('The {bolt_name} bolt bounces off the wall!', bolt_name=tr_name('bolt', bolt_name)))
            y += dy
            x += dx
            continue

        path.append((y, x))
        # モンスターに命中
        for m in monsters:
            if m.is_alive and m.y == y and m.x == x:
                m.hp -= dmg
                last_bolt['hit'] = (y, x, dmg, not m.is_alive)
                msgs.append(tr('The {bolt_name} bolt hits the {name} for {dmg} damage.', bolt_name=tr_name('bolt', bolt_name), name=m.name, dmg=dmg))
                if not m.is_alive:
                    msgs.append(tr('The {name} is killed!', name=m.name))
                    from combat import calc_exp
                    msgs.extend(player.gain_exp(calc_exp(m)))
                return msgs

        # プレイヤーに命中（反射後）
        if bounced and y == player.y and x == player.x:
            player.take_damage(dmg)
            msgs.append(tr('The {bolt_name} bolt hits you for {dmg} damage!', bolt_name=tr_name('bolt', bolt_name), dmg=dmg))
            return msgs

        y += dy
        x += dx

    msgs.append(tr('The {bolt_name} bolt vanishes.', bolt_name=tr_name('bolt', bolt_name)))
    return msgs


def _find_target(
    dungeon:   'Dungeon',
    monsters:  list['Monster'],
    player:    'Player',
    direction: tuple[int, int],
) -> Optional['Monster']:
    dy, dx = direction
    if dy == 0 and dx == 0:
        return None
    rows = len(dungeon.map)
    cols = len(dungeon.map[0]) if rows else 0
    y, x = player.y + dy, player.x + dx
    for _ in range(BOLT_LENGTH):
        if not (0 <= y < rows and 0 <= x < cols):
            break
        if not dungeon.is_walkable(y, x):
            break
        for m in monsters:
            if m.is_alive and m.y == y and m.x == x:
                return m
        y += dy
        x += dx
    return None


def _ws_polymorph(monster: 'Monster', player: 'Player') -> list[str]:
    from monsters import spawn_monster, rand_monster_letter
    old_name = monster.name
    new_letter = rand_monster_letter(player.floor)
    new_m = spawn_monster(new_letter, player.floor, monster.y, monster.x)
    monster.letter     = new_m.letter
    monster.hp         = new_m.hp
    monster.max_hp     = new_m.max_hp
    monster.level      = new_m.level
    monster.ac         = new_m.ac
    monster.exp        = new_m.exp
    monster.flags      = new_m.flags | ISRUN
    monster.disguise_ch = new_m.disguise_ch
    return [tr('The {old_name} turns into a {name}!', old_name=old_name, name=monster.name)]


# ===========================================================================
# 指輪装備/取り外しヘルパー
# ===========================================================================

def put_on_ring(
    item:      Item,
    player:    'Player',
    slot:      int,
    knowledge: GameKnowledge,
) -> list[str]:
    msgs: list[str] = []
    old = player.put_on_ring(item, slot)
    if old is not None:
        msgs.append(tr('You remove {item}.', item=knowledge.display_name(old)))
    item.o_flags |= ISKNOW
    knowledge.know(item.o_type, item.o_which)
    msgs.append(tr('You put on {item}.', item=knowledge.display_name(item)))
    return msgs


def remove_ring(
    slot:      int,
    player:    'Player',
    knowledge: GameKnowledge,
) -> list[str]:
    ring = player.rings[slot]
    if ring is None:
        return [tr("You aren't wearing a ring there.")]
    if ring.is_cursed:
        return [tr("You can't remove the cursed ring!")]
    player.remove_ring(slot)
    return [tr('You remove {item}.', item=knowledge.display_name(ring))]


# ===========================================================================
# 汎用ディスパッチャ
# ===========================================================================

def use_item(
    item:        Item,
    player:      'Player',
    dungeon:     'Dungeon',
    knowledge:   GameKnowledge,
    monsters:    list['Monster'],
    floor_items: list[Item],
    direction:   tuple[int, int] = (0, 0),
    target_item: Optional[Item] = None,
) -> list[str]:
    """アイテム種別に応じた使用効果を呼び出す汎用ディスパッチャ。"""
    ot = item.o_type
    if ot == CH_POTION:
        return use_potion(item, player, dungeon, knowledge, monsters)
    if ot == CH_SCROLL:
        return use_scroll(item, player, dungeon, knowledge,
                          monsters, floor_items, target_item)
    if ot == CH_STICK:
        return use_stick(item, player, dungeon, knowledge, monsters, direction)
    if ot == CH_FOOD:
        if player.food >= STOMACHSIZE:
            return [tr("You're too full to eat more.")]
        return player.eat(random.randint(1100, 1500))
    return [tr("You can't use that.")]

