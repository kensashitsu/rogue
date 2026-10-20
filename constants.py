# 全定数・パラメータ定義
"""
すべての定数は data/items.json および data/monsters.json から読み込む。
数値のハードコードは禁止。spread() 形式の文字列値は str 型のまま保持する。
"""

import json
import os

# ---------------------------------------------------------------------------
# JSON 読み込み
# ---------------------------------------------------------------------------
_DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def _load(filename: str) -> dict:
    path = os.path.join(_DATA_DIR, filename)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


_items    = _load("items.json")
_monsters = _load("monsters.json")

# ===========================================================================
# items.json
# ===========================================================================

# ---------------------------------------------------------------------------
# 基本定数
# ---------------------------------------------------------------------------
_c = _items["constants"]
MAXPACK    = _c["MAXPACK"]       # パック最大所持数
MAXOBJ     = _c["MAXOBJ"]        # フロア上の最大アイテム数
NUMTHINGS  = _c["NUMTHINGS"]     # アイテム種別数
MAXPOTIONS = _c["MAXPOTIONS"]    # ポーション種類数
MAXSCROLLS = _c["MAXSCROLLS"]    # スクロール種類数
MAXWEAPONS = _c["MAXWEAPONS"]    # 武器種類数
MAXARMORS  = _c["MAXARMORS"]     # 防具種類数
MAXRINGS   = _c["MAXRINGS"]      # 指輪種類数
MAXSTICKS  = _c["MAXSTICKS"]     # 杖・ワンド種類数
ESCAPE     = _c["ESCAPE"]        # ESC キーコード
LEFT       = _c["LEFT"]          # 左手リングスロット
RIGHT      = _c["RIGHT"]         # 右手リングスロット

# ---------------------------------------------------------------------------
# 画面表示文字
# ---------------------------------------------------------------------------
_sc = _items["screen_chars"]
CH_PASSAGE = _sc["PASSAGE"]   # 通路 '#'
CH_DOOR    = _sc["DOOR"]      # ドア '+'
CH_FLOOR   = _sc["FLOOR"]     # 床 '.'
CH_PLAYER  = _sc["PLAYER"]    # プレイヤー '@'
CH_TRAP    = _sc["TRAP"]      # トラップ '^'
CH_STAIRS  = _sc["STAIRS"]    # 階段 '%'
CH_GOLD    = _sc["GOLD"]      # 金 '*'
CH_POTION  = _sc["POTION"]    # ポーション '!'
CH_SCROLL  = _sc["SCROLL"]    # スクロール '?'
CH_MAGIC   = _sc["MAGIC"]     # 魔法アイテム '$'
CH_FOOD    = _sc["FOOD"]      # 食料 ':'
CH_WEAPON  = _sc["WEAPON"]    # 武器 ')'
CH_ARMOR   = _sc["ARMOR"]     # 防具 ']'
CH_AMULET  = _sc["AMULET"]    # アミュレット ','
CH_RING    = _sc["RING"]      # 指輪 '='
CH_STICK   = _sc["STICK"]     # 杖・ワンド '/'

# ---------------------------------------------------------------------------
# 特殊タイプ値（インベントリフィルタ用）
# ---------------------------------------------------------------------------
_stv = _items["special_type_values"]
CALLABLE = _stv["CALLABLE"]   # 使用可能なアイテムを示す -1
R_OR_S   = _stv["R_OR_S"]    # 指輪または杖を示す -2

# ---------------------------------------------------------------------------
# ポーション種別インデックス
# ---------------------------------------------------------------------------
_p = _items["potions"]
P_CONFUSE  = _p["P_CONFUSE"]
P_LSD      = _p["P_LSD"]
P_POISON   = _p["P_POISON"]
P_STRENGTH = _p["P_STRENGTH"]
P_SEEINVIS = _p["P_SEEINVIS"]
P_HEALING  = _p["P_HEALING"]
P_MFIND    = _p["P_MFIND"]
P_TFIND    = _p["P_TFIND"]
P_RAISE    = _p["P_RAISE"]
P_XHEAL    = _p["P_XHEAL"]
P_HASTE    = _p["P_HASTE"]
P_RESTORE  = _p["P_RESTORE"]
P_BLIND    = _p["P_BLIND"]
P_LEVIT    = _p["P_LEVIT"]

# ---------------------------------------------------------------------------
# スクロール種別インデックス
# ---------------------------------------------------------------------------
_s = _items["scrolls"]
S_CONFUSE   = _s["S_CONFUSE"]
S_MAP       = _s["S_MAP"]
S_HOLD      = _s["S_HOLD"]
S_SLEEP     = _s["S_SLEEP"]
S_ARMOR     = _s["S_ARMOR"]
S_ID_POTION = _s["S_ID_POTION"]
S_ID_SCROLL = _s["S_ID_SCROLL"]
S_ID_WEAPON = _s["S_ID_WEAPON"]
S_ID_ARMOR  = _s["S_ID_ARMOR"]
S_ID_R_OR_S = _s["S_ID_R_OR_S"]
S_SCARE     = _s["S_SCARE"]
S_FDET      = _s["S_FDET"]
S_TELEP     = _s["S_TELEP"]
S_ENCH      = _s["S_ENCH"]
S_CREATE    = _s["S_CREATE"]
S_REMOVE    = _s["S_REMOVE"]
S_AGGR      = _s["S_AGGR"]
S_PROTECT   = _s["S_PROTECT"]

# ---------------------------------------------------------------------------
# 武器種別インデックス
# ---------------------------------------------------------------------------
_w = _items["weapons"]
MACE     = _w["MACE"]
SWORD    = _w["SWORD"]
BOW      = _w["BOW"]
ARROW    = _w["ARROW"]
DAGGER   = _w["DAGGER"]
TWOSWORD = _w["TWOSWORD"]
DART     = _w["DART"]
SHIRAKEN = _w["SHIRAKEN"]
SPEAR    = _w["SPEAR"]
FLAME    = _w["FLAME"]   # ドラゴンのブレス用ダミーエントリ（MAXWEAPONS == FLAME）

# ---------------------------------------------------------------------------
# 防具種別インデックス
# ---------------------------------------------------------------------------
_a = _items["armors"]
LEATHER         = _a["LEATHER"]
RING_MAIL       = _a["RING_MAIL"]
STUDDED_LEATHER = _a["STUDDED_LEATHER"]
SCALE_MAIL      = _a["SCALE_MAIL"]
CHAIN_MAIL      = _a["CHAIN_MAIL"]
SPLINT_MAIL     = _a["SPLINT_MAIL"]
BANDED_MAIL     = _a["BANDED_MAIL"]
PLATE_MAIL      = _a["PLATE_MAIL"]

# ---------------------------------------------------------------------------
# 指輪種別インデックス
# ---------------------------------------------------------------------------
_r = _items["rings"]
R_PROTECT  = _r["R_PROTECT"]
R_ADDSTR   = _r["R_ADDSTR"]
R_SUSTSTR  = _r["R_SUSTSTR"]
R_SEARCH   = _r["R_SEARCH"]
R_SEEINVIS = _r["R_SEEINVIS"]
R_NOP      = _r["R_NOP"]
R_AGGR     = _r["R_AGGR"]
R_ADDHIT   = _r["R_ADDHIT"]
R_ADDDAM   = _r["R_ADDDAM"]
R_REGEN    = _r["R_REGEN"]
R_DIGEST   = _r["R_DIGEST"]
R_TELEPORT = _r["R_TELEPORT"]
R_STEALTH  = _r["R_STEALTH"]
R_SUSTARM  = _r["R_SUSTARM"]

# ---------------------------------------------------------------------------
# 杖・ワンド種別インデックス
# ---------------------------------------------------------------------------
_ws = _items["sticks"]
WS_LIGHT     = _ws["WS_LIGHT"]
WS_INVIS     = _ws["WS_INVIS"]
WS_ELECT     = _ws["WS_ELECT"]
WS_FIRE      = _ws["WS_FIRE"]
WS_COLD      = _ws["WS_COLD"]
WS_POLYMORPH = _ws["WS_POLYMORPH"]
WS_MISSILE   = _ws["WS_MISSILE"]
WS_HASTE_M   = _ws["WS_HASTE_M"]
WS_SLOW_M    = _ws["WS_SLOW_M"]
WS_DRAIN     = _ws["WS_DRAIN"]
WS_NOP       = _ws["WS_NOP"]
WS_TELAWAY   = _ws["WS_TELAWAY"]
WS_TELTO     = _ws["WS_TELTO"]
WS_CANCEL    = _ws["WS_CANCEL"]

# ---------------------------------------------------------------------------
# その他定数
# ---------------------------------------------------------------------------
_misc = _items["misc_constants"]
HUNGERTIME  = _misc["HUNGERTIME"]   # 空腹になるまでのターン数
MORETIME    = _misc["MORETIME"]     # 食料追加時のターン数
STOMACHSIZE = _misc["STOMACHSIZE"]  # 胃の容量上限

# ---------------------------------------------------------------------------
# 部屋フラグ（ビットマスク）
# ---------------------------------------------------------------------------
_rf = _items["room_flags"]
ISDARK = _rf["ISDARK"]["value"]   # 暗い部屋
ISGONE = _rf["ISGONE"]["value"]   # 部屋なし（通路）
ISMAZE = _rf["ISMAZE"]["value"]   # 迷路部屋

# ---------------------------------------------------------------------------
# マップセルフラグ（ビットマスク）
# ---------------------------------------------------------------------------
_mf = _items["map_flags"]
F_PASS    = _mf["F_PASS"]["value"]     # 通路セル
F_SEEN    = _mf["F_SEEN"]["value"]     # 既訪問セル
F_DROPPED = _mf["F_DROPPED"]["value"]  # アイテムドロップ済み
F_LOCKED  = _mf["F_LOCKED"]["value"]   # ロックドア（F_DROPPED と同値、文脈で区別）
F_REAL    = _mf["F_REAL"]["value"]     # 見たまま表示
F_PNUM    = _mf["F_PNUM"]["value"]     # 通路番号マスク
F_TMASK   = _mf["F_TMASK"]["value"]    # トラップ番号マスク
F_SECRETDOOR = 256                     # 隠し扉（JSON 既存ビットと非重複）

# ---------------------------------------------------------------------------
# インベントリ表示モード
# ---------------------------------------------------------------------------
_inv = _items["inventory_types"]
INV_OVER  = _inv["INV_OVER"]    # オーバーレイ表示
INV_SLOW  = _inv["INV_SLOW"]    # スロー表示
INV_CLEAR = _inv["INV_CLEAR"]   # 全消去表示

# ---------------------------------------------------------------------------
# オブジェクトフラグ（ビットマスク）
# ---------------------------------------------------------------------------
_of = _items["object_flags"]
ISCURSED = _of["ISCURSED"]["value"]   # 呪われたアイテム
ISKNOW   = _of["ISKNOW"]["value"]     # 正体判明済み
ISMISL   = _of["ISMISL"]["value"]     # 投擲可能
ISMANY   = _of["ISMANY"]["value"]     # スタック可能
OBJ_ISFOUND = _of["ISFOUND"]["value"] # 発見済み（クリーチャーフラグ ISFOUND と区別）
ISPROT   = _of["ISPROT"]["value"]     # 永久保護済み防具

# ===========================================================================
# monsters.json
# ===========================================================================

# ---------------------------------------------------------------------------
# 基本定数（整数のみ; WANDERTIME は spread() 形式のため timing_constants で管理）
# ---------------------------------------------------------------------------
_mc = _monsters["constants"]
AMULETLEVEL = _mc["AMULETLEVEL"]   # アミュレット出現階層
MAXTHINGS   = _mc["MAXTHINGS"]     # フロア上の最大モンスター数
BORE_LEVEL  = _mc["BORE_LEVEL"]    # モンスター掘削レベル
BOLT_LENGTH = _mc["BOLT_LENGTH"]   # 魔法ボルトの長さ
LAMPDIST    = _mc["LAMPDIST"]      # ランプ照射距離
HUHDURATION = _mc["HUHDURATION"]   # 混乱持続ターン数

# ---------------------------------------------------------------------------
# クリーチャーフラグ（ビットマスク）
# 注: 同値フラグが複数存在する（原作 C ソース由来の文脈別エイリアス）
#   ISCANC == ISLEVIT == 8
#   ISMEAN == ISHALU  == 2048
#   SEEMONST == ISFLY == 16384
# ---------------------------------------------------------------------------
_cf = _monsters["creature_flags"]
CANHUH   = _cf["CANHUH"]["value"]    # 混乱攻撃を持つ
CANSEE   = _cf["CANSEE"]["value"]    # 不可視を看破できる
ISBLIND  = _cf["ISBLIND"]["value"]   # 盲目状態
ISCANC   = _cf["ISCANC"]["value"]    # 特殊能力キャンセル済み
ISLEVIT  = _cf["ISLEVIT"]["value"]   # 浮遊中（ヒーロー用; ISCANC と同値）
ISFOUND  = _cf["ISFOUND"]["value"]   # 発見済み（モンスター用）
ISGREED  = _cf["ISGREED"]["value"]   # 金を守ろうとする
ISHASTE  = _cf["ISHASTE"]["value"]   # 加速中
ISTARGET = _cf["ISTARGET"]["value"]  # 'f' コマンドのターゲット
ISHELD   = _cf["ISHELD"]["value"]    # 拘束中
ISHUH    = _cf["ISHUH"]["value"]     # 混乱中
ISINVIS  = _cf["ISINVIS"]["value"]   # 不可視
ISMEAN   = _cf["ISMEAN"]["value"]    # 近づくと追跡してくる
ISHALU   = _cf["ISHALU"]["value"]    # 幻覚中（ヒーロー用; ISMEAN と同値）
ISREGEN  = _cf["ISREGEN"]["value"]   # 再生能力あり
ISRUN    = _cf["ISRUN"]["value"]     # プレイヤーへ向かって走行中
SEEMONST = _cf["SEEMONST"]["value"]  # 不可視モンスターを検知できる
ISFLY    = _cf["ISFLY"]["value"]     # 飛行できる（SEEMONST と同値）
ISSLOW   = _cf["ISSLOW"]["value"]    # 減速中

# ---------------------------------------------------------------------------
# セーブスロータイプ
# ---------------------------------------------------------------------------
_st = _monsters["save_types"]
VS_POISON       = _st["VS_POISON"]
VS_PARALYZATION = _st["VS_PARALYZATION"]
VS_DEATH        = _st["VS_DEATH"]
VS_BREATH       = _st["VS_BREATH"]
VS_MAGIC        = _st["VS_MAGIC"]

# ---------------------------------------------------------------------------
# トラップ種別インデックス
# ---------------------------------------------------------------------------
_tt = _monsters["trap_types"]
T_DOOR  = _tt["T_DOOR"]
T_ARROW = _tt["T_ARROW"]
T_SLEEP = _tt["T_SLEEP"]
T_BEAR  = _tt["T_BEAR"]
T_TELEP = _tt["T_TELEP"]
T_DART  = _tt["T_DART"]
T_RUST  = _tt["T_RUST"]
T_MYST  = _tt["T_MYST"]
NTRAPS  = _tt["NTRAPS"]

# ---------------------------------------------------------------------------
# タイミング定数
# 整数値のみ定数として公開する。
# spread() 形式（例: "spread(70)"）は文字列のまま _TIMING_RAW に保持し、
# 将来の実装でパースして使用すること。
# ---------------------------------------------------------------------------
_tc = _monsters["timing_constants"]
HEALTIME    = _tc["HEALTIME"]     # HP回復間隔（ターン数）
SEEDURATION = _tc["SEEDURATION"]  # 透視持続ターン数
STARVETIME  = _tc["STARVETIME"]   # 餓死するまでのターン数

# spread() 形式のタイミング値（文字列として保持）
_TIMING_RAW: dict = {
    k: v for k, v in _tc.items() if isinstance(v, str)
}

# ---------------------------------------------------------------------------
# モンスターリスト（出現レベル順 / ワンド召喚用）
# ---------------------------------------------------------------------------
LVL_MONS  = _monsters["lvl_mons"]   # 通常出現テーブル（26エントリ）
WAND_MONS = _monsters["wand_mons"]  # ワンド召喚テーブル（null = 召喚不可）


# ===========================================================================
# 難易度の調整（Rogue 5.4 からの意図的な改変。0 にすると 5.4 と同じ）
# 調整前の状態は git タグ difficulty-original
# ===========================================================================
LEVEL_HP_BONUS = 2   # レベルアップで増える最大HP（5.4 は 1d10）に足す値。深い階で打たれ強くする
SIGHT_POTION_CUT = 800   # 盲目・幻覚の薬の効き目（5.4 は SEEDURATION = 850 ターン）から引くターン数。トルネコの大冒険と同じ約50ターンにする
CONFUSE_CUT = 15   # 混乱の効き目（5.4 は HUHDURATION = 20 ターン）から引くターン数。トルネコの大冒険と同じ5ターンにする
