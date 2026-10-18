# 戦闘計算
"""
Rogue 5.4 準拠の戦闘計算モジュール。

命中判定式（Rogue 5.4 combat.c 準拠）:
  プレイヤー → モンスター : d20 + player.level + player.attack_bonus >= 21 - monster.ac
  モンスター → プレイヤー : d20 + monster.level                     >= 21 - player.effective_ac
セービングスロー式（data/monsters.json save_throw 準拠）:
  need = 14 + which - (level // 2)  ;  save if d20 >= need
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

from i18n import tr
from constants import (
    VS_POISON, VS_PARALYZATION, VS_DEATH, VS_BREATH, VS_MAGIC,
    HUHDURATION, ISHELD, ISRUN, BOLT_LENGTH, ISCANC, BORE_LEVEL,
    R_SUSTSTR, R_SUSTARM, ISPROT, CH_AMULET, LEATHER,
)

if TYPE_CHECKING:
    from monsters import Monster
    from player  import Player

# ===========================================================================
# 結果コンテナ
# ===========================================================================

@dataclass
class CombatResult:
    hit:               bool
    damage:            int
    messages:          list[str] = field(default_factory=list)
    monster_killed:    bool = False
    player_killed:     bool = False
    monster_teleports: bool = False   # Leprechaun / Nymph が逃げる


# ===========================================================================
# ダイスと損傷文字列
# ===========================================================================

def roll(n: int, sides: int) -> int:
    """n 個の sides 面ダイスを振った合計を返す（Rogue の roll(n, sides)）。"""
    if n <= 0 or sides <= 0:
        return 0
    return sum(random.randint(1, sides) for _ in range(n))


def parse_damage(dmg_str: str) -> list[tuple[int, int]]:
    """
    "NxS/NxS/..." または "NdS/NdS/..." を [(n, sides), ...] に変換する。
    "0x0" / "0d0" はダメージなし → [(0, 0)] を返す。
    """
    attacks: list[tuple[int, int]] = []
    for part in dmg_str.split('/'):
        part = part.strip()
        sep = 'x' if 'x' in part else 'd' if 'd' in part else ''
        if sep:
            ns, ss = part.split(sep, 1)
            try:
                attacks.append((int(ns), int(ss)))
            except ValueError:
                attacks.append((0, 0))
        else:
            attacks.append((0, 0))
    return attacks


def roll_damage(dmg_str: str, bonus: int = 0) -> int:
    """損傷文字列のダイスを振り、bonus を加えた値を返す（最低 0）。"""
    total = sum(
        roll(n, sides)
        for n, sides in parse_damage(dmg_str)
        if sides > 0
    )
    return max(0, total + bonus)


# ===========================================================================
# セービングスロー（data/monsters.json "save_throw" 準拠）
# ===========================================================================

def save_throw(level: int, which: int, protect_bonus: int = 0) -> bool:
    """
    セービングスロー。
      need = 14 + which - (level // 2) - protect_bonus  →  d20 >= need で成功。
    返り値: True = セーブ成功（効果を受けない）。
    """
    need = 14 + which - (level // 2) - protect_bonus
    need = max(2, min(20, need))
    return random.randint(1, 20) >= need


# ===========================================================================
# 経験値計算（data/monsters.json "exp_add" 準拠）
# ===========================================================================

def exp_add(level: int, maxhp: int) -> int:
    """
    モンスター撃破時の追加経験値（Rogue 5.4 exp_add 関数）。
      level==1:  mod = maxhp / 8
      level >1:  mod = maxhp / 6
      level >9:  mod *= 20
      level >6:  mod *= 4
    """
    mod = maxhp // 8 if level == 1 else maxhp // 6
    if level > 9:
        mod *= 20
    elif level > 6:
        mod *= 4
    return mod


def calc_exp(monster: "Monster") -> int:
    """モンスター撃破で得る経験値の合計。"""
    return monster.exp + exp_add(monster.level, monster.max_hp)


# ===========================================================================
# 命中判定
# ===========================================================================

def _player_hits(player: "Player", monster: "Monster") -> bool:
    """
    プレイヤーの命中判定。
    hit if d20 + player.level + attack_bonus >= 21 - monster.ac
    """
    need = 21 - monster.ac - player.level - player.attack_bonus
    need = max(2, need)
    return random.randint(1, 20) >= need


def _monster_hits(monster: "Monster", player: "Player") -> bool:
    """
    モンスターの命中判定。
    hit if d20 + monster.level >= 21 - player.effective_ac
    """
    need = 21 - player.effective_ac - monster.level
    need = max(2, need)
    return random.randint(1, 20) >= need


# ===========================================================================
# プレイヤー → モンスター 攻撃
# ===========================================================================

def player_attacks_monster(
    player:  "Player",
    monster: "Monster",
) -> CombatResult:
    """
    プレイヤーのモンスター攻撃を解決する。
    monster.hp を直接変更する。
    """
    result = CombatResult(hit=False, damage=0)
    vname = monster.display_name(player.status.can_see_invisible)

    # 攻撃された相手は起きて追ってくる（5.4 fight.c → runto: ISHELD 解除）
    monster.flags &= ~ISHELD
    monster.flags |= ISRUN
    player._heal_timer = 0   # 戦闘中は自然回復しない（5.4 quiet = 0）

    if not _player_hits(player, monster):
        result.messages.append(tr('You miss the {vname}.', vname=vname))
        return result

    result.hit = True

    # Xeroc: 命中で正体を現す
    if monster.letter == 'X' and getattr(monster, 'disguise_ch', ''):
        monster.disguise_ch = ''
        result.messages.append(tr('The Xeroc is revealed!'))

    # S_CONFUSE: 次攻撃でモンスターを混乱させる
    if player.status.confuse_next_attack:
        player.status.confuse_next_attack = False
        from constants import ISHUH
        monster.flags |= ISHUH
        monster._huh_turns = HUHDURATION
        result.messages.append(tr('Your hands stop glowing; the {vname} is confused!', vname=vname))

    # 武器ダメージ（素手: 1x4）
    dmg_str = "1x4"
    if player.weapon is not None:
        dmg_str = getattr(player.weapon, 'o_damage', '1x4')

    damage = max(1, roll_damage(dmg_str, player.damage_bonus))
    monster.hp -= damage
    result.damage = damage
    result.messages.append(tr('You hit the {vname} for {damage} damage.', vname=vname, damage=damage))

    if not monster.is_alive:
        result.monster_killed = True
        result.messages.append(tr('You killed the {name}!', name=monster.name))

    return result


# ===========================================================================
# モンスター → プレイヤー 攻撃
# ===========================================================================

def monster_attacks_player(
    monster: "Monster",
    player:  "Player",
    dungeon: object = None,
) -> CombatResult:
    """
    モンスターのプレイヤー攻撃を解決する。
    特殊攻撃の効果を player に直接適用する。
    """
    result = CombatResult(hit=False, damage=0)
    vname = monster.display_name(player.status.can_see_invisible)

    cancelled = bool(monster.flags & ISCANC)
    player._heal_timer = 0   # 戦闘中は自然回復しない（5.4 quiet = 0）

    # Venus Flytrap: キャンセル済みでなければ拘束攻撃
    if monster.letter == 'F' and not cancelled:
        return _flytrap_attack(monster, player, result)

    # "/" ごとに独立した命中判定（Rogue 5.4 準拠）
    attacks = parse_damage(monster.damage)
    total_damage = 0
    any_hit = False
    for n, sides in attacks:
        if _monster_hits(monster, player):
            any_hit = True
            if sides > 0:
                total_damage += roll(n, sides)

    if not any_hit:
        result.messages.append(tr('The {vname} misses.', vname=vname))
        return result

    result.hit = True
    damage = total_damage

    if not cancelled:
        # 特殊攻撃（hp ダメージなし or 別効果）
        _NODMG = {'A', 'I', 'L', 'N', 'F'}
        sp_msgs, teleport = _apply_special(
            monster.letter, player, damage, dungeon, player.protect_bonus, monster
        )
        result.messages.extend(sp_msgs)
        result.monster_teleports = teleport

        if monster.letter not in _NODMG:
            damage = max(1, damage)
            player.take_damage(damage)
            result.damage = damage
            result.messages.append(
                tr('The {vname} hits you for {damage} damage.', vname=vname, damage=damage)
            )
    else:
        # キャンセル済み: 特殊能力なし、物理ダメージのみ
        damage = max(1, damage)
        player.take_damage(damage)
        result.damage = damage
        result.messages.append(
            tr('The {vname} hits you for {damage} damage.', vname=vname, damage=damage)
        )

    if not player.is_alive:
        result.player_killed = True

    return result


# ===========================================================================
# 特殊攻撃ディスパッチ
# ===========================================================================

def _apply_special(
    letter:  str,
    player:  "Player",
    damage:  int,
    dungeon: object,
    protect: int = 0,
    monster: object = None,
) -> tuple[list[str], bool]:
    """
    モンスター種別ごとの特殊効果を player に適用する。
    返り値: (メッセージリスト, モンスターがテレポートすべきか)
    """
    msgs:     list[str] = []
    teleport: bool      = False

    # ── I Ice Monster: 凍結 rnd(2)+2 ターンを加算（5.4 fight.c）────────
    if letter == 'I':
        if player.status.paralyzed == 0:
            msgs.append(tr('You are frozen by the Ice Monster!'))
        player.status.paralyzed += random.randint(0, 1) + 2
        if player.status.paralyzed > BORE_LEVEL and not player.godmode:
            player.hp = 0

    # ── R Rattlesnake: 毒（現在 STR 減少、restore strength で回復可）────
    elif letter == 'R':
        if not save_throw(player.level, VS_POISON, protect):
            if player.godmode or player._has_ring(R_SUSTSTR):
                msgs.append(tr("The Rattlesnake's bite is deflected!"))
            else:
                player.str_cur = max(3, player.str_cur - 1)
                msgs.append(
                    tr("The Rattlesnake's bite poisons you! (STR → {str_cur})", str_cur=player.str_cur)
                )

    # ── L Leprechaun: ゴールド全額盗取、テレポート離脱 ─────────────
    elif letter == 'L':
        if player.gold > 0:
            stolen = player.gold
            player.gold = 0
            monster.stolen_gold += stolen
            msgs.append(tr('The Leprechaun steals all your gold ({stolen} gp)!', stolen=stolen))
        else:
            msgs.append(tr('The Leprechaun finds no gold and flees!'))
        teleport = True

    # ── A Aquator: 防具を錆び付かせる（AC 悪化） ─────────────────────
    elif letter == 'A':
        if player.armor is not None:
            o_flags = getattr(player.armor, 'o_flags', 0)
            if getattr(player.armor, 'o_which', -1) == LEATHER:
                msgs.append(tr("The Aquator hits your leather armor but it doesn't rust!"))
            elif o_flags & ISPROT:
                msgs.append(tr('The Aquator hits your armor but it is protected!'))
            elif player._has_ring(R_SUSTARM):
                msgs.append(tr("The Aquator's rust is repelled by your ring!"))
            else:
                old_arm = getattr(player.armor, 'o_arm', 10)
                setattr(player.armor, 'o_arm', old_arm + 1)
                msgs.append(tr('The Aquator corrodes your armor!'))

    # ── N Nymph: パック内アイテムを1個盗取、テレポート離脱 ───────────
    elif letter == 'N':
        if player.pack:
            ch    = random.choice(list(player.pack.keys()))
            item  = player.remove_from_pack(ch)
            name  = getattr(item, 'name', 'an item')
            if getattr(item, 'o_type', '') == CH_AMULET:
                player.has_amulet = False
            monster.stolen_item = item
            msgs.append(tr('The Nymph steals {name}!', name=name))
        else:
            msgs.append(tr('The Nymph grabs for you but finds nothing!'))
        teleport = True

    # ── W Wraith 15%: レベルドレイン / V Vampire 30%: 最大HP吸収（5.4 fight.c）──
    elif letter in ('W', 'V') and random.randint(0, 99) < (15 if letter == 'W' else 30):
        if player.godmode:
            return msgs, teleport
        if letter == 'W':
            if player.exp == 0:
                player.hp = 0          # 吸い取るレベルが残っていない
                return msgs, teleport
            if player.level > 1:
                player.level -= 1
                player.exp = player.exp_start_of_level(player.level)
                msgs.append(tr('You are now level {level}.', level=player.level))
            else:
                player.exp = 0
            fewer = roll(1, 10)
        else:
            fewer = roll(1, 3)
        player.hp     -= fewer
        player.max_hp -= fewer
        if player.hp <= 0:
            player.hp = 1
        if player.max_hp <= 0:
            player.hp = 0
        msgs.insert(0, tr('You suddenly feel weaker. (Max HP -{fewer})', fewer=fewer))

    return msgs, teleport


# ── 内部: Venus Flytrap 継続攻撃 ─────────────────────────────────────

def _flytrap_attack(
    monster: "Monster",
    player:  "Player",
    result:  CombatResult,
) -> CombatResult:
    result.hit = True
    already_held = player.status.held
    player.status.held = True
    if already_held:
        # 拘束中は毎ターン圧迫ダメージ rnd(6)+1
        dmg = random.randint(1, 6)
        player.take_damage(dmg)
        result.damage = dmg
        result.messages.append(
            tr('The Venus Flytrap crushes you for {dmg} damage!', dmg=dmg)
        )
    else:
        result.messages.append(
            tr('The Venus Flytrap grabs you with its vines!')
        )
    if not player.is_alive:
        result.player_killed = True
    return result


# ── 内部: Dragon ブレス攻撃 ──────────────────────────────────────────

def dragon_breath(player: "Player") -> list[str]:
    """
    ドラゴンの炎（5.4 sticks.c fire_bolt の対ヒーロー部分）。
    VS_MAGIC セーブ失敗で 6d6、成功なら外れる。
    """
    player._heal_timer = 0
    if save_throw(player.level, VS_MAGIC, player.protect_bonus):
        return [tr('The flame whizzes by you.')]
    damage = roll(6, 6)
    player.take_damage(damage)
    return [tr('You are hit by the flame for {damage} damage.', damage=damage)]
