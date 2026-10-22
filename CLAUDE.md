# プロジェクトルール

## 環境
- Python 3.12 / Windows / Windows Terminal
- 描画は term.py（VT シーケンスの curses 互換レイヤー）。windows-curses は全角の幅を扱えず日本語が崩れるため使わない
- ターミナル：80×24固定

## ファイル構成
main.py / game.py / dungeon.py / player.py / monsters.py / items.py / combat.py / ui.py / term.py / i18n.py / i18n_ja.py / constants.py / data/items.json / data/monsters.json
web/（ブラウザ版: index.html / app.js / worker.js / coi-serviceworker.js）

## ブラウザ版（スマホ）
- 公開先は https://kensashitsu.github.io/rogue/web/ 。GitHub Pages（master のルート）なので push すれば約1分で反映される
- ゲーム本体の .py はそのまま Pyodide で動かす（worker.js の SOURCES に並べたファイルを読む。.py を増やしたらここにも足す）
- term.py は sys.platform == 'emscripten' のとき画面を rogue_draw に渡し、キーを rogue_getch で待つ（Atomics.wait。COOP/COEP が要るので coi-serviceworker を使う）
- ui.py の getch は _getch(hint, keys) を通す。hint（command / direction / more / char / text / name / list / any）でスマホのボタンを出し分ける。新しい入力待ちを足すときは hint も付ける
- 説明書は「その他 → 説明書」で manual.txt をそのまま読み込んで組む（app.js の buildManual。===== で挟んだ行が見出し、┌│└ で始まる図は横スクロール）。manual.txt を直せば exe 版と両方に反映される
- web/ を直して公開するときは app.js の VERSION を上げる（画面右上に出る。iPhone に新しい版が届いたかの確認用）。実機の調査は URL 末尾に #debug を付けると操作の出来事が画面に出る
- web3d/ は一人称 3D 表示の試作（https://kensashitsu.github.io/rogue/web3d/）。web/ の写しを元に、地図の画面を r3d.js（Three.js）で立体にしたもの。ゲーム本体は同じ .py を使い、セーブは 2D 版と分けている（rogue3d-files）。web/ を直しても web3d/ には自動では入らない

## 表示言語（英語 / 日本語）
- 画面に出す文字列は必ず tr("英語の文面 {x}", x=...) を通す。英語の文面がそのままキーになる
- 日本語訳は i18n_ja.py の JA に足す（差し込み名 {x} は英語と同じにする）。固有名（モンスター・アイテム・外観）は NAMES と tr_name()
- 行の切り詰め・桁揃えは文字数ではなく見た目の幅（全角 = 2）で行う（ui._fit / term.text_width）
- 死因はスコアに英語のまま保存し、表示時に i18n.cause() で訳す

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
- 難易度の調整は constants.py 末尾の「難易度の調整」にまとめる（0 で 5.4 と同じ。調整前は git タグ difficulty-original）。今はレベルアップの最大HP +2、盲目・幻覚の薬の効き目を約50ターンに（5.4 は 850）、混乱を5ターンに（5.4 は 20）。どちらもトルネコの大冒険に合わせた
- 休む（.）と "You rest." と出す（続けて休むと回数も。ほかのメッセージが出るターンは出さない）
- Z で「回復するまで休む」（盲目・幻覚・混乱・減速・毒が治り HP が満タンになるまで休み続ける。メッセージが出る・HP が減る・見えるモンスターが現れるか動くと止まる。5.4 にはない）

上記以外で 5.4 と違う箇所は、間違いとして直してよい。
