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

LANGS = ('en', 'ja', 'enja')   # enja: 英語で遊び、メッセージの下に日本語訳を併記する（ブラウザ版だけ。英語の勉強用）

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


# 英語＋日本語（enja）のとき: 作った英語の文 → その日本語訳。メッセージを出すときに ja_of() で引いて併記する。
# 差し込む名前（{name} など）も、先に作った英語の名前から日本語の名前を引いて埋める
_pairs: dict[str, str] = {}


def _remember(en: str, ja: str) -> None:
    if len(_pairs) > 20000:
        _pairs.clear()
    _pairs[en] = ja


def remember(en: str, ja: str) -> None:
    """英語＋日本語のとき、英語の語句とその日本語を覚える（tr・name を通らない語句。巻物の名前のカタカナなど）"""
    if _lang == 'enja':
        _remember(en, ja)


def ja_name(kind: str, en: str) -> str:
    """いまの言語に関係なく、固有名の日本語"""
    from i18n_ja import NAMES
    return NAMES.get(kind, {}).get(en, en)


def _ja_part(v: str) -> str:
    """差し込む語句の日本語（文頭で頭を大文字にした名前 'A scroll ...' も、小文字に戻して引く）"""
    if v in _pairs:
        return _pairs[v]
    low = v[:1].lower() + v[1:]
    return _pairs.get(low, v)


def ja_of(text: str) -> str | None:
    """英語＋日本語のとき、英語の文の日本語訳（分からなければ None）"""
    return _pairs.get(text) if _lang == 'enja' else None


def tr(template: str, **kw) -> str:
    """文面を現在の言語に訳し、{name} などを埋める。"""
    if _lang == 'ja':
        from i18n_ja import JA
        template = JA.get(template, template)
    elif _lang == 'enja':
        from i18n_ja import JA
        en = template.format(**kw) if kw else template
        ja_t = JA.get(template, template)
        kj = {k: (_ja_part(v) if isinstance(v, str) else v) for k, v in kw.items()}
        try:
            _remember(en, ja_t.format(**kj) if kj else ja_t)
        except (KeyError, IndexError, ValueError):
            pass
        return en
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
    if _lang == 'enja':
        from i18n_ja import NAMES
        _remember(en, NAMES.get(kind, {}).get(en, en))
    return en
