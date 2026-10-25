# libretto を動かすのに要るもの

オーナーが用意するものの一覧（設計書 7.2・実装設計書 6.10 (5)・6.13）。libretto は起動のたびに道具の有無を確かめ、無いものは設定の画面の「動作環境の確認」に、何ができなくなるかと直し方（貼り付ける 1 行や、管理画面へのリンク）を出し、それを使う保存先を選択肢から外す。入れた後は、同じ画面の「もう一度確かめる」を押せば起動し直さずに確かめ直す。

## 必ず要るもの

| もの | 何に使うか | 入れ方 | 無いとき |
|---|---|---|---|
| Node.js 22.12 以上 | libretto のホスト | <https://nodejs.org/> | 起動しない |
| Claude Code（`claude`） | ライターと判定役 | `npm install -g @anthropic-ai/claude-code` で入れ、`claude auth login` でログインする（古いときは `claude update`） | 依頼が進まない |

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

- 入れたら、設定の画面の「動作環境の確認」で「もう一度確かめる」を押す（起動し直さなくてよい）。入れたのに「入っていません」のままなら、新しく足された PATH が動いている libretto に届いていないので、起動し直す。
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

## スマホから開く（外出先で承認する）

libretto は PC の中だけで開く（公開の URL は作らない。実装設計書 P1）。スマホから開くときは、PC とスマホを Tailscale（自分の端末だけの網）でつなぎ、Tailscale の HTTPS のアドレスで開く。手順は実装設計書 6.12 (6)。

| 手順 | すること |
|---|---|
| 1. Tailscale を入れる | PC とスマホに Tailscale を入れ（<https://tailscale.com/download>）、同じアカウントでログインする。WSL2 で libretto を動かすときは、Tailscale は Windows 側に入れる |
| 2. HTTPS を有効にする | Tailscale の管理画面（<https://login.tailscale.com/admin/dns>）で **MagicDNS** と **HTTPS Certificates** を有効にする |
| 3. PC で HTTPS の入口を開く | PC で `tailscale serve --bg 7780` を 1 回打つ（WSL2 なら Windows の PowerShell で）。`https://<PC の名前>.<tailnet の名前>.ts.net` で受けて、PC の中の libretto（`127.0.0.1:7780`）へ渡す。出たアドレスを控える。止めるときは `tailscale serve --https=443 off` |
| 4. そのアドレスを libretto に教える | libretto を `LIBRETTO_ORIGIN=http://127.0.0.1:7780,https://<PC の名前>.<tailnet の名前>.ts.net npm start` で起動し直す。`LIBRETTO_BIND` は変えない（`127.0.0.1` のまま） |
| 5. スマホを追加する | PC の libretto の設定の画面の「端末」で「別の端末を追加する」を押し、出たアドレスを 10 分以内にスマホで開く（1 回だけ使える）。以後スマホは 400 日そのまま使える |

- 足りないときの画面: 手順 4 を忘れると、スマホで画面は開けても「このアドレスで開いた画面からは操作できません」の帯が出て、ボタンが効かない。手順 4 のアドレス（`https://` から `.ts.net` まで。末尾の `/` は付けない）を足して起動し直す。追加用のアドレスが `http://127.0.0.1` で始まるときは手順 3・4 がまだで、設定の画面に案内が出る。
- スマホを外すとき: 設定の画面の「端末」で、その端末の「外す」を押す。
