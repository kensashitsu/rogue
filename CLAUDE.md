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
Rogue 5.4 準拠（数値・名前の出典は Rogue 5.4.4 の C ソース。例: https://github.com/Davidslv/rogue の extern.c / fight.c / daemons.c）。
ただし完全クローンではなく、遊びやすくするための意図的な改変がある。以下は「直さない」こと:
- 戦闘・回復メッセージにダメージ数値やHP/STRの数値を出す
- 盗まれた金・アイテムは、盗んだモンスターを倒せば取り返せる（Leprechaun は所持金を全額盗む）
- 識別の巻物5種（S_ID_*）は1種類 "identify" に統合し、好きなアイテムを1つ識別できる
- 進めない方向へ動くと "You can't go that way." と出す
- 徘徊モンスターは寝た状態で出現する
- 見えない敵は "it" ではなく "something" と表示する

上記以外で 5.4 と違う箇所は、間違いとして直してよい。
