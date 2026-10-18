# 表示言語の切り替え（英語 / 日本語）
"""
画面に出す文字列はすべて tr() を通す。

    tr("You hit the {name}.", name=vname)

英語の文面そのものをキーにし、日本語訳は i18n_ja.py の JA 辞書で引く。
訳が見つからなければ英語のまま表示する（訳し漏れでも壊れない）。
固有名（モンスター名・アイテム名・外観など）は name() で引く。

選んだ言語は rogue.cfg（セーブファイルと同じ場所）に保存し、次回も使う。
"""

from __future__ import annotations

import json
import os
import sys

LANGS = ('en', 'ja')

_HERE = (os.path.dirname(sys.executable) if getattr(sys, 'frozen', False)
         else os.path.dirname(os.path.abspath(__file__)))
_CFG_FILE = os.path.join(_HERE, 'rogue.cfg')

_lang = 'en'


def _load_cfg() -> dict:
    try:
        with open(_CFG_FILE, encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def load_lang() -> str:
    """設定ファイルから言語を読み込んで適用する。"""
    global _lang
    lang = _load_cfg().get('lang')
    if lang in LANGS:
        _lang = lang
    return _lang


def get_lang() -> str:
    return _lang


def set_lang(lang: str) -> None:
    """言語を切り替えて設定ファイルに保存する。"""
    global _lang
    if lang not in LANGS:
        return
    _lang = lang
    cfg = _load_cfg()
    cfg['lang'] = lang
    try:
        with open(_CFG_FILE, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False)
    except OSError:
        pass


def is_ja() -> bool:
    return _lang == 'ja'


def tr(template: str, **kw) -> str:
    """文面を現在の言語に訳し、{name} などを埋める。"""
    if _lang == 'ja':
        from i18n_ja import JA
        template = JA.get(template, template)
    return template.format(**kw) if kw else template


def cause(text: str) -> str:
    """
    死因を訳す。死因はスコアファイルに英語のまま保存し、表示するときに訳す
    （"killed by a Hobgoblin" / "starved to death" / "quit" など）。
    """
    if _lang != 'ja':
        return text
    prefix = "killed by a "
    if text.startswith(prefix):
        return tr("killed by a {name}", name=name('monster', text[len(prefix):]))
    return tr(text)


def name(kind: str, en: str) -> str:
    """固有名を訳す。kind は i18n_ja.NAMES の分類（'monster', 'potion' など）。"""
    if _lang == 'ja':
        from i18n_ja import NAMES
        return NAMES.get(kind, {}).get(en, en)
    return en
