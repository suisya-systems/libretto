# libretto を動かすのに要るもの

オーナーが用意するものの一覧（設計書 7.2・実装設計書 6.10 (5)）。libretto は起動のたびに道具の有無を確かめ、無いものは設定の画面の「動作環境の確認」に出し、それを使う保存先を選択肢から外す。

## 必ず要るもの

| もの | 何に使うか | 入れ方 | 無いとき |
|---|---|---|---|
| Node.js 22.12 以上 | libretto のホスト | <https://nodejs.org/> | 起動しない |
| Claude Code（`claude`） | ライターと判定役 | 公式の手順でインストールし、ログインまで済ませる | 依頼が進まない |

## チェック項目をライターから隠す道具（Linux / WSL2）

| もの | 入れ方 | 無いとき |
|---|---|---|
| bubblewrap・socat・ripgrep | `sudo apt install bubblewrap socat ripgrep` | 隠す仕組みが「弱い」になる（設定の画面に直し方が出る） |
| 名前空間の許可（Ubuntu 24.04 以降） | `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` | 同上 |

macOS は OS の Seatbelt を使うので足すものは無い。素の Windows では隠す仕組みが弱くなるので、WSL2 で動かす（実装設計書 8 章）。

## ファイルを作る道具（LibreOffice と poppler）

PowerPoint・Excel・Word のファイルと Google スライドに保存するときに使う。できあがりを画像にして見た目と空白のページを確かめ（LibreOffice → PDF → poppler → 画像）、表の式を計算し直してエラーを数える（LibreOffice）。

| OS | 入れ方 |
|---|---|
| Ubuntu / WSL2 | `sudo apt install libreoffice poppler-utils` |
| macOS | `brew install --cask libreoffice` と `brew install poppler` |

- 入れたら libretto を起動し直す（道具の有無は起動のときに 1 回だけ確かめる）。
- 確かめ方: `npm run verify:files` が `soffice` と `pdftoppm` の場所を出し、見本のスライドを 3 ページ（空白 0）、表の式を 2 つ（エラー 1）と数えれば動いている。`soffice` が PATH に無い場所にあるときは、環境変数 `LIBRETTO_SOFFICE` / `LIBRETTO_PDFTOPPM` にその場所を入れる。
- 無いとき: PowerPoint・Excel・Word のファイルと Google スライドは保存先に出ない。Google スプレッドシートは保存できるが、ライターには式を使わず計算した値を書かせる。

## 連携と鍵（設定の画面で入れる）

どれも設定の画面から入れる。ファイルを手で置く必要は無く、再起動も要らない。

| もの | 何に使うか | 用意の手順 | 無いとき |
|---|---|---|---|
| Google の OAuth クライアント（デスクトップ アプリ） | Gmail の合図・Meet の会議メモ・Google ドキュメント / スプレッドシート / スライドへの保存 | 実装設計書 6.4 (9)。Google Cloud で **Gmail API** と **Google Drive API** を有効にする。スプレッドシートとスライドも Drive API の変換で作るので、Sheets API・Slides API は要らない | Gmail・Meet の入口と Google の保存先を選べない |
| Slack アプリのユーザートークン | Slack の合図 | 実装設計書 6.6 (9) | Slack の入口を選べない |
| OpenAI の API キー | チェック項目をライターとは別の種類の AI に作らせる | <https://platform.openai.com/> で作る | ライターと同じ種類の AI が作る（画面に出る） |
| Jev（TypeSafe）の API キー | 文で書ける確認の判定 | オーナーが持っているもの | Claude が判定する（画面に出る） |
