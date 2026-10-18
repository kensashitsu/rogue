# プロジェクトルール

## 環境
- Python 3.12 / Windows / windows-curses
- cursesバグが3回以上→blessed切り替え可（承認不要）
- ターミナル：80×24固定

## ファイル構成
main.py / game.py / dungeon.py / player.py / monsters.py / items.py / combat.py / ui.py / constants.py / data/items.json / data/monsters.json

## 絶対ルール
- print文禁止
- data/items.json・monsters.jsonの数値変更禁止
- NetHack・Angbandの仕様混入禁止
- テストコード不要
- 質問不要・自己判断で実装
- エラーは自動修正、解決不能な場合のみ報告
- ファイルの削除・リネーム禁止

## 仕様準拠
Rogue 5.4完全準拠
