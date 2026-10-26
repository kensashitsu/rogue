# ゲームループ管理
"""
Rogue 5.4 準拠のメインゲームループ。

セーブ/ロード:
  - pickle で rogue.sav（プロジェクト直下）に全状態を保存する。
  - Q 押下・S 押下・ウィンドウ閉じ（KeyboardInterrupt/SystemExit）で自動セーブ。
  - 起動時にセーブファイルが存在すれば自動ロードし、タイトル画面をスキップ。
  - 死亡時はセーブファイルを削除する（Rogue 原作準拠）。

ハイスコア:
  - rogue.scr（JSON）に上位10件を記録する。
  - スコア = gold + exp。
  - 死亡時に自動記録し、一覧を表示してから終了する。
"""

from __future__ import annotations

import datetime
import json
import os
import pickle
import random
import sys
from dataclasses import dataclass, asdict, replace as dc_replace
from typing import Optional

from ui import UI, run_with_curses, MOVE_DELTAS
from dungeon import new_level, Dungeon
from player import Player
from monsters import spawn_from_placed, spawn_monster, rand_monster_letter, Monster, _get_spread, MONSTER_DB
from items import (
    init_knowledge, set_knowledge, GameKnowledge, Item,
    make_potion, make_scroll, make_weapon, make_armor,
    make_ring, make_stick, make_food, make_gold, make_amulet,
    use_potion, use_scroll, use_stick,
    put_on_ring as _items_put_on_ring,
    remove_ring as _items_remove_ring,
)
from combat import player_attacks_monster, calc_exp, roll_damage
from i18n import tr, load_lang
from constants import (
    CH_FLOOR, CH_TRAP, F_SECRETDOOR, CH_PASSAGE, CH_DOOR,
    CH_POTION, CH_SCROLL, CH_WEAPON, CH_ARMOR,
    CH_RING, CH_STICK, CH_FOOD, CH_GOLD, CH_AMULET,
    CH_STAIRS,
    LEFT, RIGHT,
    ISMANY, ISCURSED, ISKNOW, ISMISL, ISRUN, ISFOUND, ISINVIS,
    STOMACHSIZE,
    R_AGGR, R_TELEPORT,
    MACE, BOW, ARROW, RING_MAIL,
    S_ID_POTION, S_ID_SCROLL, S_ID_WEAPON, S_ID_ARMOR, S_ID_R_OR_S, S_FDET, S_SCARE, S_TELEP, P_MFIND, P_TFIND,
    P_CONFUSE, P_LSD, P_POISON, P_BLIND, P_HEALING, P_XHEAL, P_HASTE, P_RAISE,
    ISHUH, ISSLOW, ISHASTE, HUHDURATION,
    OBJ_ISFOUND,
    T_DOOR, T_ARROW, T_SLEEP, T_BEAR, T_TELEP, T_DART, T_RUST, T_MYST, NTRAPS,
)

# ---------------------------------------------------------------------------
# ファイルパス
# ---------------------------------------------------------------------------
_HERE = (os.path.dirname(sys.executable) if getattr(sys, 'frozen', False)
         else os.path.dirname(os.path.abspath(__file__)))
_SAVE_FILE     = os.path.join(_HERE, 'rogue.sav')
_SCORE_FILE    = os.path.join(_HERE, 'rogue.scr')
_GAMEOVER_LOG  = os.path.join(_HERE, 'gameover.log')

_SAVE_VERSION = 1
_MAX_SCORES   = 10


# ===========================================================================
# セーブ用ユーティリティ
# ===========================================================================

def _save_exists() -> bool:
    return os.path.isfile(_SAVE_FILE)


def _delete_save() -> None:
    try:
        os.remove(_SAVE_FILE)
    except OSError:
        pass


def _write_gameover_log(player: "Player", name: str, cause: str, events: list[str]) -> None:
    """死亡時の状況を gameover.log に書き出す。"""
    try:
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        lines: list[str] = [
            "=== GAME OVER ===",
            f"Date:   {now}",
            f"Player: {name}",
            f"Cause:  {cause}",
            "",
            f"Floor:      {player.floor}",
            f"Level:      {player.level}",
            f"HP:         {player.hp}/{player.max_hp}",
            f"Strength:   {player.str_cur}/{player.str_max}",
            f"Gold:       {player.gold}",
            f"Experience: {player.exp}",
            f"Score:      {player.gold + player.exp}",
            "",
            "--- Last Events ---",
        ]
        lines.extend(events if events else ["(no events recorded)"])
        lines.append("")
        with open(_GAMEOVER_LOG, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
    except OSError:
        pass


# ===========================================================================
# ハイスコア
# ===========================================================================

@dataclass
class ScoreEntry:
    """ハイスコア 1 件分のデータ。"""
    score: int
    name:  str
    cause: str   # 死因テキスト
    floor: int
    gold:  int


def _load_scores() -> list[ScoreEntry]:
    """rogue.scr を読み込んで ScoreEntry リストを返す。失敗時は空リスト。"""
    if not os.path.isfile(_SCORE_FILE):
        return []
    try:
        with open(_SCORE_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return [ScoreEntry(**d) for d in data]
    except Exception:
        return []


def _save_scores(entries: list[ScoreEntry]) -> None:
    """ScoreEntry リストを rogue.scr に書き込む。"""
    with open(_SCORE_FILE, 'w', encoding='utf-8') as f:
        json.dump([asdict(e) for e in entries], f,
                  ensure_ascii=False, indent=2)


def _add_score(entry: ScoreEntry) -> tuple[list[ScoreEntry], int]:
    """
    スコアを追加してソート済みリストとそのランクを返す。
    上位 _MAX_SCORES 件に入らなかった場合はランク 0 を返す。
    """
    entries = _load_scores()
    entries.append(entry)
    # スコア降順・同スコアは到達階降順
    entries.sort(key=lambda e: (e.score, e.floor), reverse=True)
    # entry が何位か（ソート前に追加した実体で判定）
    rank = next((i + 1 for i, e in enumerate(entries) if e is entry), 0)
    entries = entries[:_MAX_SCORES]
    _save_scores(entries)
    return entries, (rank if rank <= _MAX_SCORES else 0)


def _wandertime() -> int:
    """次に徘徊モンスターの判定を始めるまでのターン数（WANDERTIME = spread(70)）。"""
    return _get_spread('WANDERTIME')


def _get_player_name() -> str:
    """システムのログイン名を取得する。取得できない場合は 'Rogue'。"""
    try:
        import getpass
        return getpass.getuser()[:16]
    except Exception:
        return (os.getenv('USERNAME') or os.getenv('USER') or 'Rogue')[:16]


# ===========================================================================
# 床上アイテム（位置付きラッパー）
# ===========================================================================

@dataclass
class FloorItem:
    """床上に配置されたアイテム。ui.draw_all が要求する y / x / ch を持つ。"""
    item: Item
    y:    int
    x:    int

    @property
    def ch(self) -> str:
        return self.item.o_type


# ===========================================================================
# Game クラス
# ===========================================================================

class Game:
    """Rogue 5.4 ゲームループ管理クラス。"""

    def __init__(self) -> None:
        self.knowledge:    GameKnowledge     = init_knowledge()
        self.player:       Player            = Player()
        self.floor:        int               = 1
        self.dungeon:      Optional[Dungeon] = None
        self.monsters:     list[Monster]     = []
        self.floor_items:  list[FloorItem]   = []
        self._running:        bool              = False
        self._is_loaded:      bool              = False
        self._quit:           bool              = False
        self._death_cause:    str               = "unknown cause"
        self._player_name:    str               = _get_player_name()
        self._in_extra_turn:   bool              = False   # 加速中の追加行動中フラグ
        self._turn_count:      int               = 0
        self._next_wander_turn: int              = _wandertime()
        self._wander_between:  int               = 0

    # -------------------------------------------------------------------------
    # フロア生成
    # -------------------------------------------------------------------------

    def _load_floor(self) -> None:
        self.dungeon = new_level(self.floor)
        self.player.y     = self.dungeon.player_start.y
        self.player.x     = self.dungeon.player_start.x
        self.player.floor = self.floor

        self.monsters = [
            spawn_from_placed(p, self.floor)
            for p in self.dungeon.monsters
        ]

        self.floor_items = []
        for obj in self.dungeon.objects:
            item = self._make_item(obj.ch, obj.which)
            if item is not None:
                self.floor_items.append(FloorItem(item=item, y=obj.y, x=obj.x))

    def _setup_starting_inventory(self) -> None:
        """Rogue 5.4 準拠の初期所持アイテムを設定する。"""
        from items import WEAPON_INFO, ARMOR_INFO
        mace = Item(
            o_type=CH_WEAPON, o_which=MACE,
            o_damage=WEAPON_INFO[MACE].damage,
            o_hurldmg=WEAPON_INFO[MACE].hurldmg,
            o_hplus=1, o_dplus=1,
            o_flags=ISKNOW,
            o_launch=WEAPON_INFO[MACE].launch,
        )
        self.player.equip_weapon(mace)

        bow = Item(
            o_type=CH_WEAPON, o_which=BOW,
            o_damage=WEAPON_INFO[BOW].damage,
            o_hurldmg=WEAPON_INFO[BOW].hurldmg,
            o_hplus=1, o_dplus=0,
            o_flags=ISKNOW,
            o_launch=WEAPON_INFO[BOW].launch,
        )
        self.player.add_to_pack(bow)

        arrow_count = random.randint(0, 14) + 25   # rnd(15)+25
        arrows = Item(
            o_type=CH_WEAPON, o_which=ARROW,
            o_damage=WEAPON_INFO[ARROW].damage,
            o_hurldmg=WEAPON_INFO[ARROW].hurldmg,
            o_flags=ISMANY | ISMISL | ISKNOW,
            o_launch=WEAPON_INFO[ARROW].launch,
            o_count=arrow_count,
        )
        self.player.add_to_pack(arrows)

        ring_mail = Item(
            o_type=CH_ARMOR, o_which=RING_MAIL,
            o_arm=ARMOR_INFO[RING_MAIL].ac - 1,   # +1 のリングメイル
            o_flags=ISKNOW,
        )
        self.player.equip_armor(ring_mail)

        food = make_food(0)
        self.player.add_to_pack(food)

    def _make_item(self, ch: str, which: int) -> Optional[Item]:
        if ch == CH_GOLD:
            item = make_gold(self.floor)
            item.o_arm = which
            return item
        if ch == CH_POTION:  return make_potion(which)
        if ch == CH_SCROLL:  return make_scroll(which)
        if ch == CH_WEAPON:  return make_weapon(which)
        if ch == CH_ARMOR:   return make_armor(which)
        if ch == CH_RING:    return make_ring(which)
        if ch == CH_STICK:   return make_stick(which)
        if ch == CH_FOOD:    return make_food(which)
        if ch == CH_AMULET:  return make_amulet()
        return None

    # -------------------------------------------------------------------------
    # セーブ / ロード
    # -------------------------------------------------------------------------

    def save_game(self) -> None:
        """ゲーム全状態を rogue.sav に pickle でシリアライズする。"""
        data = {
            'version':      _SAVE_VERSION,
            'floor':        self.floor,
            'player':       self.player,
            'dungeon':      self.dungeon,
            'monsters':     self.monsters,
            'floor_items':  self.floor_items,
            'knowledge':    self.knowledge,
            'death_cause':  self._death_cause,
            'player_name':  self._player_name,
            'turn_count':        self._turn_count,
            'next_wander_turn':  self._next_wander_turn,
            'wander_between':    self._wander_between,
        }
        with open(_SAVE_FILE, 'wb') as f:
            pickle.dump(data, f, protocol=pickle.HIGHEST_PROTOCOL)

    @classmethod
    def _from_save(cls) -> 'Game':
        """rogue.sav からゲーム状態を復元する。失敗時は例外を送出する。"""
        with open(_SAVE_FILE, 'rb') as f:
            data = pickle.load(f)
        if data.get('version') != _SAVE_VERSION:
            raise ValueError(f"save version mismatch: {data.get('version')}")
        g = object.__new__(cls)
        g.floor        = data['floor']
        g.player       = data['player']
        g.dungeon      = data['dungeon']
        g.monsters     = data['monsters']
        g.floor_items  = data['floor_items']
        g.knowledge    = data['knowledge']
        set_knowledge(g.knowledge)
        g._death_cause = data.get('death_cause', 'unknown cause')
        g._player_name = data.get('player_name', _get_player_name())
        g._running       = False
        g._is_loaded     = True
        g._quit          = False
        g._in_extra_turn = False
        g._turn_count        = data.get('turn_count', 0)
        g._next_wander_turn  = data.get('next_wander_turn', g._turn_count + 70)
        g._wander_between    = data.get('wander_between', 0)
        return g

    # -------------------------------------------------------------------------
    # メインループ
    # -------------------------------------------------------------------------

    def run(self, ui: UI) -> None:
        """curses 初期化後に呼ばれるゲームエントリポイント。"""
        self._running = True

        if not self._is_loaded:
            name = ui.name_entry_screen()
            if name:
                self._player_name = name
            self._load_floor()
            self._setup_starting_inventory()

        try:
            while self._running and self.player.is_alive:
                ui.draw_all(
                    self.dungeon, self.player,
                    self.monsters, self.floor_items,
                )
                if self._is_loaded:
                    ui.add_message(tr('Welcome back!  (Floor {floor})', floor=self.floor))
                    self._is_loaded = False
                # 3D 版へ、この階の隠し扉の場所を知らせる（近くで見ると壁が少し違って見える。意図的な改変）
                if getattr(self, '_secrets_sent', None) is not self.dungeon:
                    self._secrets_sent = self.dungeon
                    # 3D 版: 階を作るコードが端末に流れる演出（出来た階の部屋・モンスター・物・罠の数を添える）
                    ui.effect_wait('newlevel', 1300, dur=1300, depth=self.floor,
                                   rooms=sum(1 for r in self.dungeon.rooms if not r.is_gone),
                                   mons=len(self.monsters), items=len(self.floor_items), traps=len(self.dungeon.traps))
                    ui.effect('secrets', cells=[[y, x] for y, row in enumerate(self.dungeon.map)
                                                for x, t in enumerate(row) if t.flags & F_SECRETDOOR])
                    # 部屋の壁の位置と、明るい部屋か暗い部屋か（3D 版は明るい部屋の壁に燭台を灯す）
                    ui.effect('rooms', rooms=[[r.top, r.left, r.bottom, r.right, 1 if r.is_dark else 0]
                                              for r in self.dungeon.rooms if not r.is_gone and not r.is_maze])
                # 3D 版へ、まだ見つけていない罠の場所と、モンスターの様子（眠っているか・体力の残り）を知らせる。
                # 3D の画面では、近くで床を見ると罠の気配があり、モンスターは寝顔や傷で描き分ける（意図的な改変）
                traps3d = [[t.y, t.x] for t in self.dungeon.traps if not t.known]
                mons3d = [[m.y, m.x, 0 if m.is_awake else 1, round(m.hp / max(1, m.max_hp), 2)]
                          for m in self.monsters if m.is_alive]
                if traps3d != getattr(self, '_traps_sent', None):
                    self._traps_sent = traps3d
                    ui.effect('traps', cells=traps3d)
                if mons3d != getattr(self, '_mons_sent', None):
                    self._mons_sent = mons3d
                    ui.effect('mons', mons=mons3d)
                if self.player.has_amulet != getattr(self, '_amulet_sent', False):   # 3D 版: アミュレットを持つと階段が上り階段に見える
                    self._amulet_sent = self.player.has_amulet
                    ui.effect('amulet', has=self.player.has_amulet)
                import items as _items
                if _items.map_reveals != getattr(self, '_maps_sent', 0):   # 魔法の地図: 3D 版の地図にも階全体を載せる
                    self._maps_sent = _items.map_reveals
                    ui.effect('mapped')

                # 行動不能チェック
                if not self.player.status.is_mobile:
                    if self.player.status.held and self.player.status.paralyzed == 0:
                        # Flytrap 拘束中: 移動不可だが攻撃は可（Rogue 5.4 ISHELD 仕様）
                        action, key = ui.get_command()
                        self._handle_action(action, key, ui)
                    else:
                        # 麻痺中: キー入力を捨ててターンだけ消費
                        ui.get_command()
                        self._end_turn(ui)
                    continue

                action, key = ui.get_command()
                self._handle_action(action, key, ui)

        except (KeyboardInterrupt, SystemExit):
            self.save_game()
            raise

        if not self.player.is_alive or self._quit:
            self._handle_death(ui)

    # -------------------------------------------------------------------------
    # 死亡処理
    # -------------------------------------------------------------------------

    def _handle_death(self, ui: UI) -> None:
        """死亡時: スコア記録 → セーブ削除 → ゲームオーバー画面。"""
        score   = self.player.gold + self.player.exp
        entry   = ScoreEntry(
            score = score,
            name  = self._player_name,
            cause = self._death_cause,
            floor = self.floor,
            gold  = self.player.gold,
        )
        entries, rank = _add_score(entry)
        _delete_save()
        _write_gameover_log(self.player, self._player_name, self._death_cause, ui.get_event_log())
        ui.effect_wait('died', 3000, dur=3000, cause=self._death_cause, floor=self.floor)   # 3D 版: Python のエラー表示のように死因を出す
        ui.game_over(self.player, self._death_cause, rank, entries)

    # -------------------------------------------------------------------------
    # アクション処理ディスパッチ
    # -------------------------------------------------------------------------

    def _handle_action(self, action: str, key: str, ui: UI) -> None:
        if action != 'rest':
            self._rest_streak = 0
        if action in MOVE_DELTAS:
            dy, dx = MOVE_DELTAS[action]
            self._do_move(dy, dx, ui)
        elif action == 'quit':
            if ui.confirm_quit():
                self._death_cause = "quit"
                self._quit        = True
                self._running     = False
        elif action == 'save':
            if ui.confirm_save():
                self.save_game()
                ui.add_message(tr('Game saved.'))
                self._running = False
        elif action == 'help':
            ui.show_help()
        elif action == 'language':
            if ui.choose_language():
                ui.add_message(tr("Language set to English."))
        elif action == 'show_status':
            ui.show_status(self.player)
        elif action == 'inventory':
            self._do_inventory_use(ui)
        elif action == 'drop':
            self._do_drop(ui)
        elif action == 'eat':
            self._do_eat(ui)
        elif action == 'read':
            self._do_read(ui)
        elif action == 'quaff':
            self._do_quaff(ui)
        elif action == 'wield':
            self._do_wield(ui)
        elif action == 'wear':
            self._do_wear(ui)
        elif action == 'takeoff':
            self._do_takeoff(ui)
        elif action == 'put_on_ring':
            self._do_put_on_ring(ui)
        elif action == 'remove_ring':
            self._do_remove_ring(ui)
        elif action == 'throw':
            self._do_throw(ui)
        elif action == 'zap':
            self._do_zap(ui)
        elif action == 'fight':
            self._do_fight(ui)
        elif action == 'search':
            self._do_search(ui)
        elif action == 'identify':
            ui.identify_symbol()
        elif action == 'check_trap':
            ui.check_trap(self.dungeon, self.player)
        elif action == 'redraw':
            ui.redraw(
                self.dungeon, self.player,
                self.monsters, self.floor_items,
            )
        elif action == 'descend':
            if self._descend(ui):
                self._end_turn(ui)
        elif action == 'ascend':
            if self._ascend(ui):
                self._end_turn(ui)
        elif action == 'rest':
            self._end_turn(ui)
            # 休んだことが分かるように出す（続けて休むと回数も）。ほかのメッセージが出るターンは出さない（「次へ」が増えないように）
            self._rest_streak = getattr(self, '_rest_streak', 0) + 1
            if not ui._msgs:
                n = self._rest_streak
                ui.add_message(tr('You rest.') if n == 1 else tr('You rest. ({n} turns)', n=n))
        elif action == 'rest_well':
            self._rest_until_well(ui)
        elif action == 'godmode':
            self.player.godmode = not self.player.godmode
            state = "ON" if self.player.godmode else "OFF"
            ui.add_message(tr('[DEBUG] God mode {state}.', state=state))
            if self.player.godmode:   # 無敵モードは能力も最大に（深い階の確認用）
                ui.add_messages(self.player.debug_max_stats())

    def _rest_until_well(self, ui: UI) -> None:
        """Z: 状態異常が治って HP が満タンになるまで休み続ける。
        メッセージが出た・HP が減った・見えるモンスターが現れたか動いたら止める。"""
        st = self.player.status

        def unwell() -> bool:
            return bool(st.blind or st.hallucinating or st.confused or st.slowed
                        or st.poisoned or self.player.hp < self.player.max_hp)

        def seen_monsters() -> dict:
            return {id(m): (m.y, m.x) for m in self.monsters
                    if m.is_alive and ui._is_visible(self.dungeon, self.player, m.y, m.x)
                    and not ((m.flags & ISINVIS) and not st.can_see_invisible)}

        if not unwell():
            ui.add_message(tr("You don't need to rest."))
            return
        n = 0
        self._resting = True
        try:
            while n < 1000 and unwell():   # 念のための上限
                hp, before = self.player.hp, seen_monsters()
                self._end_turn(ui)
                n += 1
                if not self._running or not self.player.is_alive or ui._msgs:
                    break
                after = seen_monsters()
                if self.player.hp < hp or any(before.get(k) != v for k, v in after.items()):
                    break
        finally:
            self._resting = False
        if not ui._msgs and self.player.is_alive:
            ui.add_message(tr('You rest. ({n} turns)', n=n))

    # -------------------------------------------------------------------------
    # 移動・攻撃
    # -------------------------------------------------------------------------

    def _do_move(self, dy: int, dx: int, ui: UI) -> None:
        if self.player.status.is_confused:
            dy, dx = random.choice([
                (-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)
            ])
            ui.add_message(tr('You stumble in confusion.'))
        ny = self.player.y + dy
        nx = self.player.x + dx

        # 5.4 diag_ok: 角が壁・岩なら斜めには動けず、殴れもしない（扉の口で壁の向こうの斜めの相手）
        if not self.dungeon.diag_ok(self.player.y, self.player.x, ny, nx):
            ui.add_message(tr("You can't go that way."))
            return

        target = next(
            (m for m in self.monsters if m.is_alive and m.y == ny and m.x == nx),
            None,
        )
        if target:
            # 通路・扉の口・迷路の中は狭い（長い刃が壁につかえる）
            here = self.dungeon.get_tile(self.player.y, self.player.x)
            room = self.dungeon.find_room_at(self.player.y, self.player.x)
            narrow = here.ch in (CH_PASSAGE, CH_DOOR) or room is None or room.is_maze
            result = player_attacks_monster(self.player, target, narrow=narrow)
            ui.add_messages(result.messages)
            weapon = self.player.weapon
            ui.effect('swing', w=weapon.o_which if weapon is not None and weapon.o_type == CH_WEAPON else -1, hit=result.hit)
            if result.hit:
                ui.effect('hit', y=target.y, x=target.x, dmg=result.damage, killed=result.monster_killed)
            if result.monster_killed:
                msgs = self.player.gain_exp(calc_exp(target))
                ui.add_messages(msgs)
                if target.stolen_gold > 0:
                    from items import make_gold
                    gold_item = make_gold(self.floor)
                    gold_item.o_arm = target.stolen_gold
                    self.floor_items.append(FloorItem(item=gold_item, y=target.y, x=target.x))
                    self.dungeon.map[target.y][target.x].ch = CH_GOLD
                    ui.add_message(tr('The Leprechaun drops {stolen_gold} gold pieces!', stolen_gold=target.stolen_gold))
                if target.stolen_item is not None:
                    dropped = target.stolen_item
                    self.floor_items.append(FloorItem(item=dropped, y=target.y, x=target.x))
                    self.dungeon.map[target.y][target.x].ch = dropped.o_type
                    name = dropped.display_name(self.knowledge)
                    ui.add_message(tr('The Nymph drops {name}!', name=name))
                if target.has_item:
                    from items import make_random_item
                    dropped = make_random_item(self.floor)
                    self.floor_items.append(FloorItem(item=dropped, y=target.y, x=target.x))
                    self.dungeon.map[target.y][target.x].ch = dropped.o_type
            self._end_turn(ui)
            return

        # Flytrap 拘束中は移動不可（攻撃は上の target ブロックで処理済み）
        if self.player.status.held:
            ui.add_message(tr("The Flytrap's vines hold you fast!"))
            self._end_turn(ui)
            return

        if self.dungeon.is_walkable(ny, nx):
            self.player.y = ny
            self.player.x = nx
            self._pickup_items(ui)
            self._trigger_trap_at(ui)
            self._end_turn(ui)
        else:
            ui.add_message(tr("You can't go that way."))

    def _pickup_items(self, ui: UI) -> None:
        picked = [
            fi for fi in self.floor_items
            if fi.y == self.player.y and fi.x == self.player.x
        ]
        # ISMANY マージ集計: slot → (pack_item, 追加合計数)
        _merged_counts: dict[str, tuple] = {}

        for fi in picked:
            if (getattr(fi.item, 'o_type', '') == CH_SCROLL
                    and getattr(fi.item, 'o_which', -1) == S_SCARE
                    and fi.item.o_flags & OBJ_ISFOUND):
                ui.add_message(tr('The scroll turns to dust as you pick it up.'))
                self.floor_items.remove(fi)
                self.dungeon.map[fi.y][fi.x].ch = CH_FLOOR
                continue
            if fi.item.o_type == CH_GOLD:
                amount = fi.item.o_arm
                self.player.gain_gold(amount)
                ui.add_message(tr('You pick up {amount} gold pieces.', amount=amount))
                self.floor_items.remove(fi)
                self.dungeon.map[fi.y][fi.x].ch = CH_FLOOR
            else:
                # ISMANY アイテムは既存スタックに加算（新スロット不要）
                if fi.item.o_flags & ISMANY:
                    merged = False
                    for slot, pack_item in self.player.pack.items():
                        if (getattr(pack_item, 'o_which', -1) == getattr(fi.item, 'o_which', -2)
                                and getattr(pack_item, 'o_flags', 0) & ISMANY):
                            pack_item.o_count += fi.item.o_count
                            if slot in _merged_counts:
                                _merged_counts[slot] = (pack_item, _merged_counts[slot][1] + fi.item.o_count)
                            else:
                                _merged_counts[slot] = (pack_item, fi.item.o_count)
                            self.floor_items.remove(fi)
                            self.dungeon.map[fi.y][fi.x].ch = CH_FLOOR
                            merged = True
                            break
                    if merged:
                        continue
                if self.player.pack_full:
                    ui.add_message(tr('Your pack is full.'))
                    break
                slot = self.player.add_to_pack(fi.item)
                if slot is not None:
                    if fi.item.o_type == CH_AMULET:
                        self.player.has_amulet = True
                    name = fi.item.display_name(self.knowledge)
                    ui.add_message(tr('You pick up {name} ({slot}).', name=name, slot=slot))
                    self.floor_items.remove(fi)
                    self.dungeon.map[fi.y][fi.x].ch = CH_FLOOR

        # ISMANY マージ分をまとめて1件メッセージ
        for slot, (pack_item, added) in _merged_counts.items():
            name = pack_item.display_name(self.knowledge)
            ui.add_message(tr('You pick up {added} {name} ({slot}).', added=added, name=name, slot=slot))

    # -------------------------------------------------------------------------
    # 階段
    # -------------------------------------------------------------------------

    def _descend(self, ui: UI) -> bool:
        if self.player.status.is_levitating:
            ui.add_message(tr("You float over the stairs and can't descend!"))
            return False
        tile = self.dungeon.get_tile(self.player.y, self.player.x)
        if tile.ch == CH_STAIRS or self.player.godmode:   # デバッグ（Ctrl-G）中はどこからでも降りられる（深い階の確認用）
            ui.effect_wait('descend', 900, how='stairs')   # 3D 版: 視点が段を下りていく
            self.floor += 1
            self._load_floor()
            ui.add_message(tr('You descend to floor {floor}.', floor=self.floor))
            return True
        ui.add_message(tr('You see no stairs here.'))
        return False

    # -------------------------------------------------------------------------
    # アイテム操作コマンド
    # -------------------------------------------------------------------------

    def _do_drop(self, ui: UI) -> None:
        occupied = any(
            fi.y == self.player.y and fi.x == self.player.x
            for fi in self.floor_items
        )
        if occupied:
            ui.add_message(tr('There is already something there.'))
            return
        slot = ui.show_inventory(self.player, title=tr('Drop which item?'))
        if slot is None:
            return
        item = self.player.remove_from_pack(slot)
        if item is None:
            return
        if getattr(item, 'o_type', '') == CH_SCROLL and getattr(item, 'o_which', -1) == S_SCARE:
            item.o_flags |= OBJ_ISFOUND
        name = item.display_name(self.knowledge)
        self.floor_items.append(
            FloorItem(item=item, y=self.player.y, x=self.player.x)
        )
        ui.add_message(tr('You drop {name}.', name=name))
        self._end_turn(ui)

    def _do_inventory_use(self, ui: UI) -> None:
        slot = ui.show_inventory(self.player, title=tr('Use which item?'))
        if slot is None:
            return
        item = self.player.pack.get(slot)
        if item is None:
            return
        o_type = item.o_type
        if o_type == CH_FOOD:
            self._do_eat(ui, slot=slot)
        elif o_type == CH_POTION:
            self._do_quaff(ui, slot=slot)
        elif o_type == CH_SCROLL:
            self._do_read(ui, slot=slot)
        elif o_type == CH_WEAPON:
            self._do_wield(ui, slot=slot)
        elif o_type == CH_ARMOR:
            self._do_wear(ui, slot=slot)
        elif o_type == CH_RING:
            self._do_put_on_ring(ui, slot=slot)
        elif o_type == CH_STICK:
            self._do_zap(ui, slot=slot)
        else:
            ui.add_message(tr("You can't use that."))

    def _do_eat(self, ui: UI, slot: Optional[str] = None) -> None:
        if slot is None:
            slot = ui.show_inventory(
                self.player, title=tr('Eat which food?'), type_filter=CH_FOOD
            )
        if slot is None:
            return
        # 満腹チェック：食料を消費する前に確認（Rogue 5.4仕様）
        if self.player.food >= STOMACHSIZE:
            ui.add_messages([tr("You're too full to eat more.")])
            return
        item = self.player.remove_from_pack(slot)
        if item is None:
            return
        food_amount = random.randint(1100, 1500)
        msgs = self.player.eat(food_amount)
        # 味メッセージと経験値（Rogue 5.4仕様）
        if item.o_which == 1:  # スライムモールド（粘菌）: 常においしい、経験値+1
            msgs.append(tr('Yum, that tasted good.'))
            msgs.extend(self.player.gain_exp(1))
        elif random.randint(0, 9) < 7:  # 70%の確率でまずい、経験値+1
            msgs.append(tr('Yuk, this food tastes awful.'))
            msgs.extend(self.player.gain_exp(1))
        else:  # 30%の確率でおいしい
            msgs.append(tr('Yum, that tasted good.'))
        ui.add_messages(msgs)
        self._end_turn(ui)

    def _do_quaff(self, ui: UI, slot: Optional[str] = None) -> None:
        if slot is None:
            slot = ui.show_inventory(
                self.player, title=tr('Quaff which potion?'), type_filter=CH_POTION
            )
        slot = self._confused_slot(slot, ui)
        if slot is None:
            return
        item = self.player.remove_from_pack(slot)
        if item is None:
            return
        fi_items = [fi.item for fi in self.floor_items]
        msgs = use_potion(
            item, self.player, self.dungeon, self.knowledge, self.monsters,
            floor_items=fi_items,
        )
        ui.add_messages(msgs)
        if item.o_which == P_MFIND and any(m.is_alive for m in self.monsters):
            ui.show_all_monsters(self.dungeon, self.player, self.monsters)
        elif item.o_which == P_TFIND:
            ui.show_all_objects(self.dungeon, self.player, self.monsters, self.floor_items)
        self._end_turn(ui)

    def _do_read(self, ui: UI, slot: Optional[str] = None) -> None:
        if slot is None:
            slot = ui.show_inventory(
                self.player, title=tr('Read which scroll?'), type_filter=CH_SCROLL
            )
        slot = self._confused_slot(slot, ui)
        if slot is None:
            return
        item = self.player.pack.get(slot)
        if item is None:
            return
        target_item: Optional[Item] = None
        if item.o_which in (S_ID_POTION, S_ID_SCROLL, S_ID_WEAPON, S_ID_ARMOR, S_ID_R_OR_S):
            tslot = ui.show_inventory(
                self.player, title=tr('Identify which item?'),
            )
            if tslot is None:
                return
            target_item = self.player.pack.get(tslot)
        self.player.remove_from_pack(slot)
        fi_items = [fi.item for fi in self.floor_items]
        msgs = use_scroll(
            item, self.player, self.dungeon, self.knowledge,
            self.monsters, fi_items, target_item=target_item,
        )
        if item.o_which == S_TELEP:
            ui.effect('teleport')   # 3D 版: 同じ階で遠くへ飛んだ演出（位置の飛び方からは推し量らない）
        ui.add_messages(msgs)
        if item.o_which == S_FDET:
            food = [fi for fi in self.floor_items if fi.item.o_type == CH_FOOD]
            if food:
                ui.show_all_objects(self.dungeon, self.player, self.monsters, food,
                                    title_msg=tr('Your nose tingles and you smell food.'))
            else:
                ui.add_message(tr('Your nose tingles.'))
        self._end_turn(ui)

    def _do_wield(self, ui: UI, slot: Optional[str] = None) -> None:
        if slot is None:
            slot = ui.show_inventory(
                self.player, title=tr('Wield which weapon?'), type_filter=CH_WEAPON
            )
        slot = self._confused_slot(slot, ui)
        if slot is None:
            return
        if self.player.weapon is not None and self.player.weapon.is_cursed:
            self.player.weapon.o_flags |= ISKNOW
            name = self.player.weapon.display_name(self.knowledge)
            ui.add_message(tr("You can't put away the {name}!", name=name))
            return
        item = self.player.remove_from_pack(slot)
        if item is None:
            return
        item.o_flags |= ISKNOW
        old = self.player.equip_weapon(item)
        if old is not None:
            returned = self.player.add_to_pack(old)
            if returned is None:
                self.floor_items.append(
                    FloorItem(item=old, y=self.player.y, x=self.player.x)
                )
                ui.add_message(
                    tr('No room in pack; {item} dropped.', item=old.display_name(self.knowledge))
                )
        name = item.display_name(self.knowledge)
        ui.add_message(tr('You are now wielding {name}.', name=name))
        self._end_turn(ui)

    def _do_wear(self, ui: UI, slot: Optional[str] = None) -> None:
        if slot is None:
            slot = ui.show_inventory(
                self.player, title=tr('Wear which armor?'), type_filter=CH_ARMOR
            )
        slot = self._confused_slot(slot, ui)
        if slot is None:
            return
        if self.player.armor is not None and self.player.armor.is_cursed:
            self.player.armor.o_flags |= ISKNOW
            ui.add_message(tr("You can't remove the cursed armor!"))
            return
        item = self.player.remove_from_pack(slot)
        if item is None:
            return
        item.o_flags |= ISKNOW
        old = self.player.equip_armor(item)
        if old is not None:
            s = self.player.add_to_pack(old)
            if s is None:
                self.floor_items.append(
                    FloorItem(item=old, y=self.player.y, x=self.player.x)
                )
                ui.add_message(
                    tr('No room in pack; {item} dropped.', item=old.display_name(self.knowledge))
                )
        name = item.display_name(self.knowledge)
        ui.add_message(tr('You are now wearing {name}.', name=name))
        self._end_turn(ui)

    def _do_takeoff(self, ui: UI) -> None:
        if self.player.armor is not None:
            if self.player.armor.is_cursed:
                self.player.armor.o_flags |= ISKNOW
                ui.add_message(tr("You can't remove the cursed armor!"))
                return
            old = self.player.unequip_armor()
            if old is not None:
                s = self.player.add_to_pack(old)
                if s is None:
                    self.floor_items.append(
                        FloorItem(item=old, y=self.player.y, x=self.player.x)
                    )
                    ui.add_message(tr('No room in pack; armor dropped.'))
                else:
                    ui.add_message(
                        tr('You take off {item}.', item=old.display_name(self.knowledge))
                    )
            self._end_turn(ui)
        elif self.player.weapon is not None:
            if self.player.weapon.is_cursed:
                self.player.weapon.o_flags |= ISKNOW
                ui.add_message(tr("You can't put away the cursed weapon!"))
                return
            old = self.player.unequip_weapon()
            if old is not None:
                s = self.player.add_to_pack(old)
                if s is None:
                    self.floor_items.append(
                        FloorItem(item=old, y=self.player.y, x=self.player.x)
                    )
                    ui.add_message(tr('No room in pack; weapon dropped.'))
                else:
                    ui.add_message(
                        tr('You put away {item}.', item=old.display_name(self.knowledge))
                    )
            self._end_turn(ui)
        else:
            ui.add_message(tr('You are not wearing or wielding anything.'))

    def _do_put_on_ring(self, ui: UI, slot: Optional[str] = None) -> None:
        if slot is None:
            slot = ui.show_inventory(
                self.player, title=tr('Put on which ring?'), type_filter=CH_RING
            )
        if slot is None:
            return
        item = self.player.remove_from_pack(slot)
        if item is None:
            return
        l_empty = self.player.rings[LEFT] is None
        r_empty = self.player.rings[RIGHT] is None
        if l_empty and r_empty:
            c = ui.prompt_char(tr('Which hand? (l)eft or (r)ight '), "lr")
            if not c:
                self.player.add_to_pack(item)
                return
            ring_slot = LEFT if c == 'l' else RIGHT
        elif l_empty:
            ring_slot = LEFT
        elif r_empty:
            ring_slot = RIGHT
        else:
            c = ui.prompt_char(tr('Replace which ring? (l)eft or (r)ight '), "lr")
            if not c:
                self.player.add_to_pack(item)
                return
            ring_slot = LEFT if c == 'l' else RIGHT
            old_ring = self.player.rings[ring_slot]
            if old_ring is not None and old_ring.is_cursed:
                old_ring.o_flags |= ISKNOW
                ui.add_message(tr("You can't remove the cursed ring!"))
                self.player.add_to_pack(item)
                return
            self.player.remove_ring(ring_slot)
            s = self.player.add_to_pack(old_ring)
            if s is None:
                self.floor_items.append(
                    FloorItem(item=old_ring, y=self.player.y, x=self.player.x)
                )
                ui.add_message(
                    tr('No room in pack; {item} dropped.', item=old_ring.display_name(self.knowledge))
                )
        msgs = _items_put_on_ring(item, self.player, ring_slot, self.knowledge)
        ui.add_messages(msgs)
        if getattr(item, 'o_which', -1) == R_AGGR:
            for m in self.monsters:
                if m.is_alive:
                    m.flags |= ISRUN | ISFOUND
            ui.add_message(tr('You feel the monsters are angry!'))
        self._end_turn(ui)

    def _do_remove_ring(self, ui: UI) -> None:
        l_ring = self.player.rings[LEFT]
        r_ring = self.player.rings[RIGHT]
        if l_ring is None and r_ring is None:
            ui.add_message(tr('You are not wearing any rings.'))
            return
        if l_ring is not None and r_ring is not None:
            c = ui.prompt_char(
                tr('Remove which ring? (l)eft or (r)ight '), "lr"
            )
            if not c:
                return
            ring_slot = LEFT if c == 'l' else RIGHT
        else:
            ring_slot = LEFT if l_ring is not None else RIGHT
        ring = self.player.rings[ring_slot]
        if ring is None:
            return
        if ring.is_cursed:
            ring.o_flags |= ISKNOW
            ui.add_message(tr("You can't remove the cursed ring!"))
            return
        self.player.remove_ring(ring_slot)
        name = ring.display_name(self.knowledge)
        s = self.player.add_to_pack(ring)
        if s is None:
            self.floor_items.append(
                FloorItem(item=ring, y=self.player.y, x=self.player.x)
            )
            ui.add_message(tr('You remove {name}, but your pack is full — dropped.', name=name))
        else:
            ui.add_message(tr('You remove {name} ({s}).', name=name, s=s))
        self._end_turn(ui)

    def _do_throw(self, ui: UI) -> None:
        slot = ui.show_inventory(self.player, title=tr('Throw what?'))
        if slot is None:
            return
        direction = ui.prompt_direction(tr('Throw in which direction? '))
        if direction == (0, 0):
            # Return item if direction cancelled
            return
        item = self.player.remove_from_pack(slot)
        if item is None:
            return
        self._throw_item(item, direction, ui)
        self._end_turn(ui)

    def _find_drop_pos(self, y: int, x: int) -> tuple[int, int]:
        """着地点にアイテムがあれば隣接する空きマスを返す。"""
        occupied = {(fi.y, fi.x) for fi in self.floor_items}
        if (y, x) not in occupied:
            return y, x
        for dy in range(-1, 2):
            for dx in range(-1, 2):
                if dy == 0 and dx == 0:
                    continue
                ny, nx = y + dy, x + dx
                if self.dungeon.is_walkable(ny, nx) and (ny, nx) not in occupied:
                    return ny, nx
        return y, x

    def _throw_item(
        self, item: Item, direction: tuple[int, int], ui: UI
    ) -> None:
        dy, dx = direction
        y, x = self.player.y + dy, self.player.x + dx
        land_y, land_x = self.player.y, self.player.x
        hit_monster = None
        for _ in range(10):
            if not self.dungeon.is_walkable(y, x):
                break
            land_y, land_x = y, x
            for m in self.monsters:
                if m.is_alive and m.y == y and m.x == x:
                    hit_monster = m
                    break
            if hit_monster:
                break
            y += dy
            x += dx
        # 飛んでいく様子（落ちる所・当たった所まで）
        path, cy, cx = [], self.player.y, self.player.x
        while (cy, cx) != (land_y, land_x):
            cy += dy; cx += dx
            path.append((cy, cx))
        # 手元の動き（弓で射る・手で投げる）を知らせ、3D 版では放すまで待ってから飛ばす
        wielded = self.player.weapon
        fired = getattr(item, 'o_launch', -1) >= 0 and wielded is not None and getattr(wielded, 'o_which', -1) == item.o_launch
        if not self.player.status.blind:
            ui.effect_wait('throw', 280 if fired else 230, w=item.o_which if item.o_type == CH_WEAPON else -1, ch=item.o_type, fired=fired)
        ui.animate_missile(path, item.o_type, self.dungeon, self.player, self.monsters, self.floor_items)

        # ランチャー確認: item.o_launch が装備武器の o_which と一致すれば弓ボーナス適用
        launcher = None
        item_launch = getattr(item, 'o_launch', -1)
        if item_launch >= 0:
            w = self.player.weapon
            if w is not None and getattr(w, 'o_which', -1) == item_launch:
                launcher = w

        name = dc_replace(item, o_count=1).display_name(self.knowledge)   # 束から投げても 1 つ分の名前
        if hit_monster:
            # 命中判定: d20 + level + item.o_hplus [+ launcher.o_hplus] >= 21 - monster.ac
            hplus = getattr(item, 'o_hplus', 0)
            if launcher is not None:
                hplus += getattr(launcher, 'o_hplus', 0)
            need = max(2, 21 - hit_monster.ac - self.player.level - hplus)
            hit = random.randint(1, 20) >= need
            if hit and item.o_type == CH_POTION:
                self._splash_potion(item, hit_monster, ui)
            elif hit:
                item.o_flags |= ISKNOW
                name = dc_replace(item, o_count=1).display_name(self.knowledge)
                hurldmg = getattr(item, 'o_hurldmg', '1x1')
                dplus = getattr(item, 'o_dplus', 0)
                if launcher is not None:
                    dplus += getattr(launcher, 'o_dplus', 0)
                str_bonus = max(0, (self.player.str_cur - 10) // 2)
                dmg = max(1, roll_damage(hurldmg, dplus + str_bonus))
                hit_monster.hp -= dmg
                ui.effect('hit', y=hit_monster.y, x=hit_monster.x, dmg=dmg, killed=not hit_monster.is_alive)
                hit_monster.flags |= ISRUN | ISFOUND
                vname = hit_monster.display_name(self.player.status.can_see_invisible)
                ui.add_message(
                    tr('You hit the {vname} with {name} for {dmg} damage.', vname=vname, name=name, dmg=dmg)
                )
                if not hit_monster.is_alive:
                    msgs = self.player.gain_exp(calc_exp(hit_monster))
                    ui.add_messages(msgs)
            else:
                hit_monster.flags |= ISRUN | ISFOUND
                vname = hit_monster.display_name(self.player.status.can_see_invisible)
                ui.add_message(tr('{name} misses the {vname}.', name=name[:1].upper() + name[1:], vname=vname))
        else:
            ui.add_message(tr('{name} misses.', name=name[:1].upper() + name[1:]))

        # 命中した矢は消滅、外れた矢のみ着地点に落ちて回収可能
        drop_on_floor = not bool(hit_monster)

        if item.o_flags & ISMANY and item.o_count > 1:
            item.o_count -= 1
            s = self.player.add_to_pack(item)
            if s is None:
                self.floor_items.append(
                    FloorItem(item=item, y=self.player.y, x=self.player.x)
                )
            if drop_on_floor and (land_y != self.player.y or land_x != self.player.x):
                thrown = dc_replace(item, o_count=1, o_packch='')
                dy2, dx2 = self._find_drop_pos(land_y, land_x)
                self.floor_items.append(
                    FloorItem(item=thrown, y=dy2, x=dx2)
                )
        else:
            if drop_on_floor and (land_y != self.player.y or land_x != self.player.x):
                fy, fx = self._find_drop_pos(land_y, land_x)
                self.floor_items.append(
                    FloorItem(item=item, y=fy, x=fx)
                )

    def _splash_potion(self, item: Item, m, ui: UI) -> None:
        """薬が敵に当たると瓶が割れ、敵に効く（トルネコの大冒険に合わせた。5.4 は 1 ダメージで消えるだけ）。
        何の薬だったか分かるのは、敵が見えていて、その様子から 1 種類に決まるときだけ（毒・盲目・加速・レベルアップ）。
        混乱と幻覚、回復と特製回復は様子が同じなので見分けられず、効かない薬は何も起きないので分からない。
        混乱・幻覚 → 混乱してでたらめに歩く。盲目 → こちらが見えず、でたらめに歩いて殴ってこない。毒 → 動きが鈍る（減速の杖と同じ）。
        続くターンは、5.4 で敵が混乱する長さ（HUHDURATION）に揃える。
        回復・特製回復 → 敵の傷が治る（飲んだときと同じ量。敵のレベルで振る）。加速 → 敵が速くなる。レベルアップ → 敵が強くなる。
        ほかの薬は敵には効かない"""
        m.flags |= ISRUN | ISFOUND
        vname = m.display_name(self.player.status.can_see_invisible)
        w = item.o_which
        if w == P_POISON:
            m.flags |= ISSLOW
            m.flags &= ~ISHASTE
            ui.add_message(tr('The flask shatters and the {vname} slows down from the poison!', vname=vname))
        elif w == P_BLIND:
            m._blind_turns = HUHDURATION
            ui.add_message(tr('The flask shatters and the {vname} is blinded!', vname=vname))
        elif w in (P_CONFUSE, P_LSD):
            m.flags |= ISHUH
            m._huh_turns = HUHDURATION
            ui.add_message(tr('The flask shatters and the {vname} looks confused!', vname=vname))
        elif w in (P_HEALING, P_XHEAL):
            sides = 8 if w == P_XHEAL else 4
            m.hp = min(m.max_hp, m.hp + sum(random.randint(1, sides) for _ in range(max(1, m.level))))
            m._blind_turns = 0
            ui.add_message(tr('The flask shatters and the {vname} looks healthier!', vname=vname))
        elif w == P_HASTE:
            if m.flags & ISSLOW:
                m.flags &= ~ISSLOW
            else:
                m.flags |= ISHASTE
            ui.add_message(tr('The flask shatters and the {vname} starts moving faster!', vname=vname))
        elif w == P_RAISE:
            gain = random.randint(1, 8)   # 5.4 でレベルが 1 上がった敵と同じく 1d8
            m.level += 1
            m.max_hp += gain
            m.hp += gain
            ui.add_message(tr('The flask shatters and the {vname} looks stronger!', vname=vname))
        else:
            ui.add_message(tr('The flask shatters over the {vname}. Nothing seems to happen.', vname=vname))
        seen = not self.player.status.blind and (not (m.flags & ISINVIS) or self.player.status.can_see_invisible)
        if self.knowledge.is_known(CH_POTION, w):
            return
        if seen and w in (P_POISON, P_BLIND, P_HASTE, P_RAISE):
            self.knowledge.know(CH_POTION, w)
            from items import POTION_INFO, tr_name
            ui.add_message(tr('That was a potion of {name}.', name=tr_name('potion', POTION_INFO[w].name)))
        else:
            ui.add_message(tr("You can't tell what kind of potion it was."))

    def _do_zap(self, ui: UI, slot: Optional[str] = None) -> None:
        if slot is None:
            slot = ui.show_inventory(
                self.player, title=tr('Zap which wand/staff?'), type_filter=CH_STICK
            )
        slot = self._confused_slot(slot, ui)
        if slot is None:
            return
        item = self.player.pack.get(slot)
        if item is None:
            return
        direction = ui.prompt_direction(tr('Zap in which direction? '))
        import items as _items
        _items.last_bolt = None
        msgs = use_stick(
            item, self.player, self.dungeon,
            self.knowledge, self.monsters, direction,
        )
        if _items.last_bolt and _items.last_bolt['path']:   # 光線を放つ杖なら、飛ぶ様子を見せてから知らせる
            ui.animate_bolt(_items.last_bolt, direction, self.dungeon, self.player, self.monsters, self.floor_items)
        ui.add_messages(msgs)
        self._end_turn(ui)

    def _do_fight(self, ui: UI) -> None:
        direction = ui.prompt_direction(tr('Fight in which direction? '))
        if direction == (0, 0):
            return
        dy, dx = direction
        self._do_move(dy, dx, ui)

    def _trigger_trap_at(self, ui: UI) -> None:
        """現在位置のトラップを発動する。浮遊中は回避。"""
        if self.player.status.is_levitating:
            return
        trap = self.dungeon.get_trap_at(self.player.y, self.player.x)
        if trap is None:
            return
        if not trap.known:
            trap.known = True
        self.dungeon.map[trap.y][trap.x].ch = CH_TRAP
        if trap.which == T_DOOR:   # 3D 版: 罠の上に立ったところを見せてから、床を抜けて落ちる
            ui.draw_all(self.dungeon, self.player, self.monsters, self.floor_items)
            ui.effect_wait('descend', 650, how='fall')
        if trap.which == T_TELEP:
            ui.effect('teleport')
        ui.add_messages(self._apply_trap(trap))

    def _apply_trap(self, trap) -> list[str]:
        """トラップ効果を適用してメッセージリストを返す。"""
        from constants import ISPROT, R_SUSTSTR, R_SUSTARM, VS_POISON, LEATHER
        from combat import save_throw
        which = trap.which
        if which == T_MYST:
            which = random.randint(0, NTRAPS - 2)  # T_MYST 以外をランダム選択

        if which == T_DOOR:
            self.floor += 1
            self._load_floor()
            return [tr('You fall through a trap door!'), tr('You are now on floor {floor}.', floor=self.floor)]

        if which == T_ARROW:
            dmg = random.randint(1, 6)
            msgs = [tr('An arrow shoots out at you!')]
            if random.randint(1, 20) >= 21 - self.player.effective_ac:
                self.player.take_damage(dmg)
                msgs.append(tr('The arrow hits you for {dmg} damage.', dmg=dmg))
            else:
                msgs.append(tr('The arrow misses.'))
                arrow = make_weapon(ARROW)
                self.floor_items.append(FloorItem(item=arrow, y=trap.y, x=trap.x))
            return msgs

        if which == T_SLEEP:
            duration = 5 + random.randint(0, 4)
            self.player.status.paralyzed = max(self.player.status.paralyzed, duration)
            return [tr('A strange gas puts you to sleep!')]

        if which == T_BEAR:
            duration = 3 + random.randint(0, 2)
            self.player.status.paralyzed = max(self.player.status.paralyzed, duration)
            return [tr('You are caught in a bear trap!')]

        if which == T_TELEP:
            pos = self.dungeon.teleport_player(self.player.y, self.player.x)
            self.player.y = pos.y
            self.player.x = pos.x
            return [tr('You hit a teleport trap!')]

        if which == T_DART:
            dmg = random.randint(1, 4)
            msgs = [tr('A dart hits you!')]
            self.player.take_damage(dmg)
            if not save_throw(self.player.level, VS_POISON):
                if self.player._has_ring(R_SUSTSTR):
                    msgs.append(tr('The dart was poisoned, but your ring protects you!'))
                elif self.player.str_cur > 3:
                    self.player.str_cur -= 1
                    msgs.append(tr('The dart was poisoned!'))
            return msgs

        if which == T_RUST:
            if self.player.armor is not None:
                if self.player.armor.o_which == LEATHER:
                    return [tr("A rust trap sprays at your leather armor but it doesn't rust!")]
                if self.player.armor.o_flags & ISPROT:
                    return [tr('A rust trap hits your armor but it is protected!')]
                if self.player._has_ring(R_SUSTARM):
                    return [tr('A rust trap sprays rust, but your ring repels it!')]
                self.player.armor.o_arm += 1
                return [tr('A rust trap corrodes your armor!')]
            return [tr('A rust trap sprays at you, but you have no armor.')]

        return [tr('You stumble over something.')]

    def _do_search(self, ui: UI) -> None:
        found_doors = self.dungeon.search(self.player.y, self.player.x)
        found_traps = self.dungeon.search_traps(self.player.y, self.player.x)
        if found_doors:
            ui.add_message(tr('You found a secret door!'))
        if found_traps:
            ui.add_message(tr('You found a trap!'))
        self._end_turn(ui)

    # -------------------------------------------------------------------------
    # 上り階段 / 勝利
    # -------------------------------------------------------------------------

    def _ascend(self, ui: UI) -> bool:
        tile = self.dungeon.get_tile(self.player.y, self.player.x)
        if tile.ch != CH_STAIRS and not self.player.godmode:   # デバッグ（Ctrl-G）中はどこからでも上れる（勝利までの確認用）
            ui.add_message(tr('You see no stairs here.'))
            return False
        if self.floor <= 1:
            if self.player.has_amulet:
                ui.effect_wait('descend', 1300, how='win')   # 3D 版: 段を上って地上の光の中へ
                self._handle_win(ui)
                return True
            ui.add_message(
                tr("There is no way out — you haven't found the Amulet of Yendor!")
            )
            return False
        if not self.player.has_amulet:
            ui.add_message(tr("You can't go up — you haven't found the Amulet of Yendor!"))
            return False
        ui.effect_wait('descend', 900, how='up')   # 3D 版: 視点が段を上っていく
        self.floor -= 1
        self._load_floor()
        ui.add_message(tr('You ascend to floor {floor}.', floor=self.floor))
        return True

    def _handle_win(self, ui: UI) -> None:
        """アミュレット持ち帰りで勝利: スコア記録 → セーブ削除 → 勝利画面。"""
        score = self.player.gold + self.player.exp + self.player.level * 100
        entry = ScoreEntry(
            score = score,
            name  = self._player_name,
            cause = 'escaped with the Amulet!',
            floor = self.floor,
            gold  = self.player.gold,
        )
        entries, rank = _add_score(entry)
        _delete_save()
        ui.win_screen(self.player)
        ui.show_high_scores(entries, highlight_rank=rank)
        self._running = False

    # -------------------------------------------------------------------------
    # 混乱中アイテム誤作動ヘルパー
    # -------------------------------------------------------------------------

    def _confused_slot(self, slot: Optional[str], ui: UI) -> Optional[str]:
        """
        混乱中: 1/2 の確率でパック内のランダムなスロットにすり替える。
        Rogue 5.4 準拠。slot が None の場合はそのまま返す。
        """
        if slot is None or not self.player.status.is_confused:
            return slot
        if random.randint(0, 1) == 0:
            return slot
        slots = list(self.player.pack.keys())
        if not slots:
            return slot
        wrong = random.choice(slots)
        if wrong != slot:
            ui.add_message(tr('You are confused and use the wrong item!'))
        return wrong

    # -------------------------------------------------------------------------
    # ターン終了処理
    # -------------------------------------------------------------------------

    def _update_held(self) -> None:
        """隣接する生存 Flytrap がいなければ拘束を解除する（撃破・テレポート後の解放）。"""
        if not self.player.status.held:
            return
        if not any(
            m.is_alive and m.letter == 'F'
            and abs(m.y - self.player.y) <= 1
            and abs(m.x - self.player.x) <= 1
            for m in self.monsters
        ):
            self.player.status.held = False

    def _roll_wanderer(self) -> None:
        """
        徘徊モンスターの出現判定（5.4 daemons.c swander / rollwand）。
        spread(WANDERTIME) ターン待ってから、4 ターンごとに 1d6 を振り、4 が出たら 1 体出す。
        出たらまた spread(WANDERTIME) ターン待つ。階を移動してもタイマーは引き継ぐ。
        """
        if self._turn_count < self._next_wander_turn:
            return
        self._wander_between += 1
        if self._wander_between < 4:
            return
        self._wander_between = 0
        if random.randint(1, 6) == 4:
            self._try_periodic_spawn()
            self._next_wander_turn = self._turn_count + _wandertime()

    def _try_periodic_spawn(self) -> None:
        """wanderer を 1 体出す。プレイヤーのいる部屋には出さない（5.4 monsters.c wanderer）。"""
        letter = rand_monster_letter(self.floor, wander=True)
        occupied = {(self.player.y, self.player.x)} | {
            (m.y, m.x) for m in self.monsters if m.is_alive
        }
        proom = self.dungeon.find_room_at(self.player.y, self.player.x)
        for _ in range(100):
            pos = self.dungeon.find_empty_floor(occupied)
            if pos is None:
                return
            if proom is None or self.dungeon.find_room_at(pos.y, pos.x) is not proom:
                break
        else:
            return
        m = spawn_monster(letter, self.floor, pos.y, pos.x)
        if any(getattr(r, 'o_which', -1) == R_AGGR
               for r in self.player.rings if r is not None):
            from constants import ISFOUND
            m.flags |= ISRUN | ISFOUND
        self.monsters.append(m)

    PEEK_RANGE = 16   # 明るい所が、暗い通路の先から見える遠さ（マス）
    PEEK_DOOR = 3     # 明るい部屋の扉の口から漏れる光が照らす通路の広さ（マス）

    def _send_peek(self, ui: UI) -> None:
        """3D 版: 明るい所（明るい部屋の中と、その扉の口のまわりの通路）のうち、自分から一直線に見通せるマスを知らせる。
        知らない通路の奥でも明るい部屋が見え、扉の一歩手前から部屋の中がのぞける（現実の見え方に寄せた。ユーザー指定）。
        3D の画面に映すだけで、ゲームの地図の記憶（5.4 は部屋に入るまで分からない）は変えない"""
        d, p = self.dungeon, self.player
        cells = []
        if not p.status.blind:
            want = {}
            for room in d.rooms:
                if room.is_gone or room.is_dark or room.is_maze:
                    continue
                if room.top <= p.y <= room.bottom and room.left <= p.x <= room.right:
                    continue   # 自分がいる部屋（もう見えている）
                if room.bottom < p.y - self.PEEK_RANGE or room.top > p.y + self.PEEK_RANGE \
                        or room.right < p.x - self.PEEK_RANGE or room.left > p.x + self.PEEK_RANGE:
                    continue
                for y in range(room.top, room.bottom + 1):
                    for x in range(room.left, room.right + 1):
                        want[(y, x)] = True
                        t = d.get_tile(y, x)
                        if t.ch == CH_DOOR and not t.flags & F_SECRETDOOR:   # 扉の口から漏れる光が照らす通路
                            for yy in range(y - self.PEEK_DOOR, y + self.PEEK_DOOR + 1):
                                for xx in range(x - self.PEEK_DOOR, x + self.PEEK_DOOR + 1):
                                    if 0 <= yy < 24 and 0 <= xx < 80 and d.get_tile(yy, xx).ch == CH_PASSAGE:
                                        want[(yy, xx)] = True
            mons = {(m.y, m.x): m for m in self.monsters if m.is_alive}
            items = {(fi.y, fi.x): fi.item.o_type for fi in self.floor_items}
            for (y, x) in want:
                if max(abs(y - p.y), abs(x - p.x)) > self.PEEK_RANGE or (y, x) == (p.y, p.x):
                    continue
                if not self._see_through(p.y, p.x, y, x):
                    continue
                ch = d.get_tile(y, x).ch or ' '
                if ch == ' ':
                    continue
                m = mons.get((y, x))
                if m is not None and not (m.flags & ISINVIS and not p.status.can_see_invisible):
                    ch = m.disguise_ch or m.letter
                elif (y, x) in items:
                    ch = items[(y, x)]
                cells.append([y, x, ch])
        if cells != getattr(self, '_last_peek', None):
            self._last_peek = cells
            ui.effect('peek', cells=cells)

    def _see_through(self, y0: int, x0: int, y1: int, x1: int) -> bool:
        """(y0,x0) から (y1,x1) まで、間のマスに壁・岩が無ければ True（一直線に見通せる）"""
        n = max(abs(y1 - y0), abs(x1 - x0))
        for i in range(1, n):
            t = self.dungeon.get_tile(y0 + round((y1 - y0) * i / n), x0 + round((x1 - x0) * i / n))
            if t.ch in ('-', '|', ' ', '') or t.flags & F_SECRETDOOR:
                return False
        return True

    def _tell_treasure_room(self, ui: UI) -> None:
        """宝物部屋に初めて入ったら一度だけ知らせる（トルネコのモンスターハウスに合わせた。5.4 は何も出ない）。
        暗い部屋や目が見えないときは、中の様子が分からないので知らせない。"""
        d, p = self.dungeon, self.player
        room = getattr(d, 'treasure_room', None)
        if room is None or d.treasure_told or room.is_dark or p.status.blind:
            return
        if room.top < p.y < room.bottom and room.left < p.x < room.right:
            d.treasure_told = True
            ui.add_message(tr('This room is full of treasure and monsters!'))

    def _end_turn(self, ui: UI) -> None:
        """プレイヤーターン終了: 食料消費・状態異常 → モンスター AI。死因を記録する。"""
        self._tell_treasure_room(ui)
        self._send_peek(ui)
        # 加速中の2回目の行動は同じターン内なので、時間経過の処理もモンスターAIも行わない
        if self._in_extra_turn:
            return
        self._turn_count += 1
        self._roll_wanderer()
        msgs = self.player.tick()
        ui.add_messages(msgs)

        # 飢餓死
        if not self.player.is_alive:
            self._death_cause = "starved to death"
            self._running = False
            return

        # R_SEARCH 指輪による自動探索
        for _ in range(self.player.search_bonus):
            found = self.dungeon.search(self.player.y, self.player.x)
            if found:
                ui.add_message(tr('You found a secret door!'))

        # R_TELEPORT 指輪: 1/33 の確率でランダムテレポート
        if any(getattr(r, 'o_which', -1) == R_TELEPORT
               for r in self.player.rings if r is not None):
            if random.randint(0, 32) == 0:
                pos = self.dungeon.teleport_player(self.player.y, self.player.x)
                self.player.y, self.player.x = pos.y, pos.x
                ui.effect('teleport')
                ui.add_message(tr('The ring teleports you!'))

        # 加速中: モンスターAI前に追加行動を1回与える（再帰は1段まで）
        if (self.player.status.is_hasted and not self._in_extra_turn and self.player.status.is_mobile
                and not getattr(self, '_resting', False)):
            self._in_extra_turn = True
            ui.draw_all(self.dungeon, self.player, self.monsters, self.floor_items)
            action, key = ui.get_command()
            self._handle_action(action, key, ui)
            self._in_extra_turn = False
            if not self.player.is_alive or not self._running:
                return

        # モンスター AI（各モンスターの行動後に死亡チェック）
        def _run_monsters() -> bool:
            """モンスターを1サイクル行動させる。プレイヤー死亡時 True を返す。"""
            for m in self.monsters:
                if m.is_alive:
                    hp = self.player.hp
                    m.last_attack = None
                    m.last_breath = None
                    m.last_gaze = False
                    msgs = m.do_turn(self.dungeon, self.player, self.monsters, self.floor_items)
                    if m.last_gaze:
                        ui.queue_effect('gaze', y=m.y, x=m.x)   # 3D 版: メデューサににらまれた
                    if getattr(self.player, 'just_frozen', False):
                        self.player.just_frozen = False
                        ui.queue_effect('freeze')   # 3D 版: 画面のふちから凍りつく（動けるようになると割れて落ちる）
                    attacked = getattr(m, 'last_attack', None)
                    if m.last_breath and not self.player.status.blind:
                        # 3D 版: ドラゴンの炎がこちらへ伸びてくる（当たれば炎に包まれる）
                        ui.queue_effect('breath', y=m.y, x=m.x, path=m.last_breath, hit=self.player.hp < hp)
                    if self.player.hp < hp or attacked is not None:
                        # 殴りかかってくる・くらった演出。どこから殴られたかは、そのモンスターが見えているときだけ知らせる
                        st = self.player.status
                        seen = (ui._is_visible(self.dungeon, self.player, m.y, m.x)
                                and not ((m.flags & ISINVIS) and not st.can_see_invisible))
                        # 演出はメッセージの列に挟み、こちらの攻撃のメッセージを読み進めてから出す
                        if attacked is not None and seen:
                            ui.queue_effect('mattack', y=m.y, x=m.x, hit=attacked, ch=m.letter)
                    if self.player.hp < hp:
                        ui.effect('hurtsoon')   # 3D 版: 状態行の HP が先に減っても、ここでは揺らさない
                        ui.queue_effect('hurt', dmg=hp - self.player.hp, **({'y': m.y, 'x': m.x} if seen else {}))
                    ui.add_messages(msgs)
                    if not self.player.is_alive:
                        self._death_cause = f"killed by a {MONSTER_DB[m.letter].name}"
                        self._running = False
                        return True
            return False

        if _run_monsters():
            return

        # 減速中: モンスターをもう1サイクル行動させる
        if self.player.status.is_slowed:
            _run_monsters()

        # Flytrap が死亡 or 離れた場合は拘束を解除する
        self._update_held()


# ===========================================================================
# パブリック API
# ===========================================================================

def run_game() -> None:
    """
    ゲームエントリポイント。
    rogue.sav が存在すれば自動ロード、なければ新規ゲームを開始する。
    """
    if _save_exists():
        try:
            game = Game._from_save()
        except Exception:
            _delete_save()
            game = Game()
    else:
        game = Game()
    load_lang()
    run_with_curses(game.run)
