# 隔離の確認の手順と記録

作り手（画面では「ライター」）からチェック項目が読めないことを、実機で 1 回流して残す（[実装設計書](../implementation.md) 8.9 (9)・8.10 (7)）。
macOS も Linux と同じ強さで隠せるという判断（P4）の確認はここに残す。結果は流した人が残したものだけを載せ、推測では書かない。

## 流し方（1 本）

前提: Node 22.12 以上、`claude` にログイン済み（`claude --version` が 2.1.309 以上）、リポジトリで `npm ci` 済み。
Linux / WSL2 は `bubblewrap`・`socat`・`ripgrep` が入っていて、unprivileged user namespace が使えること。macOS は追加で入れるものは無い（Seatbelt は OS に入っている）。

```bash
npm run verify:isolation
```

中身は `host/scripts/sandbox-live.ts --model --probe --record`。一時フォルダに案件のフォルダを作って乱数の語を置き、次を表で出す。

1. 自己点検（claude の版・隔離の水準）
2. 作り手と同じ起こし方で、作業場は読めて書け、作業場の外（版の正本・チェック項目・判定・ほかの案件・データベース・API キー）は読めない。外へ書いたものは手元に残らない。ホームの一覧は許した名前だけ（シェルで。費用 0）
3. 本物の claude（haiku）に Read 道具で読ませて、作業場の語だけが返る。拒否規則だけで起こしても外の語は読めず、規則を外すと読める（対照）
4. ホストを強制終了しても、作り手と孫のプロセスが残らない
5. 隔離の点検（画面の「今すぐ確認」と同じ中身）: 作業場に届き、チェック項目の語が見えず、ホームが許した名前だけで、対照（チェック項目を開け直した起こし方）では語が見える

費用は 3 と 5 で claude（haiku）を 5 回呼ぶ分（数円）。終わると `docs/verification/isolation-<OS>-<日付>.md`（`<OS>` は `macos` / `linux`）に表を書き、下の記録の表のその OS の行も差し替える（手元の絶対パスは `~` と `<LIBRETTO_HOME>` に伏せる）。この 2 つのファイルを commit して残す。

## macOS で流す（オーナー向け）

Mac のターミナル（「アプリケーション」→「ユーティリティ」→「ターミナル」）に、下の枠を上から 1 つずつ貼って Enter を押す。全部で 10〜20 分ほど。

**1. 前提を確かめる**

```bash
node --version
claude --version
```

- `node` は `v22.12.0` 以上。`command not found` か古いときは https://nodejs.org/ から LTS を入れ、ターミナルを開き直す
- `claude` は `2.1.309` 以上。古いときは `claude update`。一度も使っていなければ `claude` と打ってログインし、`/exit` で抜ける（ログイン情報は Mac のキーチェーンに入る。それでよい）
- `git` が無いと言われたら、出てきた画面で「インストール」を押す（Xcode のコマンドラインツール）

**2. リポジトリを用意する**（初めてのとき）

```bash
cd ~ && git clone https://github.com/suisya-systems/libretto.git && cd libretto && npm ci --ignore-scripts
```

すでにあるときは:

```bash
cd ~/libretto && git checkout main && git pull && npm ci --ignore-scripts
```

**3. 流す**

```bash
npm run verify:isolation
```

- 行ごとに `PASS` か `FAIL` が出る。最後に `30/30 passed.`（数は版で変わる）・`recorded: …/isolation-macos-<日付>.md`・`updated: …/isolation.md` が出たら終わり
- 途中で「キーチェーンへのアクセスを許可しますか」のような画面が出たら、押す前にその文面を写真かメモで残し、「許可」を押す（どの段で出たかが切り分けの手がかりになる）
- `FAIL` が出ても最後まで流す。記録はそのまま残す（直さない）

**4. 記録を渡す**

どちらか 1 つ。

- git が使えるなら: 枝を切って `docs/verification` の 2 つのファイルを commit し、GitHub に上げて PR を作る（本文に `Closes #23`）

  ```bash
  git checkout -b verify/isolation-macos && git add docs/verification && git commit -m "docs(libretto): macOS で隔離の確認を流した記録"
  git push -u origin verify/isolation-macos
  ```

- git を使わないなら: 次の 1 行で中身を画面に出し、全部コピーして Issue #23 にコメントで貼る

  ```bash
  cat docs/verification/isolation-macos-*.md
  ```

記録に入るのは OS・Node・claude の版と、表（行の名前・PASS / FAIL・短い補足）だけ。ユーザー名を含む絶対パスは `~` に置き換わっている。貼る前に `/Users/` が残っていないか目で見る。

## 記録の取り込み（受け取った側）

1. PR で受け取ったら、`isolation-macos-<日付>.md` と記録の表の macOS の行が変わっていることを見る。Issue のコメントで受け取ったら、貼られた中身を `docs/verification/isolation-macos-<日付>.md` に置き、表の macOS の行を同じ形（Linux の行にならう）で埋める
2. `grep -n '/Users/' docs/verification/isolation-macos-*.md` が何も出さないことを確かめる
3. 全部 PASS なら #23 を閉じる。FAIL があれば、下の表で切り分けて Issue を分ける

### FAIL の切り分け

| FAIL の行（名前の頭） | どこの問題か |
|---|---|
| `isolation strong` | Seatbelt での起動（`srt` の自己点検。補足に理由が出る） |
| `claude version >= minimum` | claude の版（`claude update`） |
| `shell: … not readable`・`shell: write …`・`shell: versions unchanged …` | Seatbelt での起動（拒否の規則が効いていない） |
| `shell: home shows only allowed entries`・`shell: ~/.claude …`・`probe: home shows only allowed entries` | ホームの扱い（補足に見えた名前が出る） |
| `model+srt: work readable`・`probe: session ended normally`・`probe: reached the work folder` | ログイン情報（キーチェーン）。隔離の中の claude がログインできていない |
| `model+srt: checks/…`・`model+rules: …`・`probe: checks token not visible` | Seatbelt での起動（モデルが外を読めた。いちばん重い） |
| `model control: …`・`probe: control sees the token …` | 点検の対照（検出の経路。隔離の問題ではない） |
| `crash: …` | 見張りの効き方（ホストを強制終了したあと子が残る） |

## 記録

| OS | 日付 | 結果 | ファイル |
|---|---|---|---|
| macOS | まだ流していない（実機が手元に無い。オーナーに依頼） | — | — |
| Linux / WSL2（WSL2・Node 22.17・claude 2.1.310） | 2026-10-24 | 30/30 PASS（隔離の水準 strong、点検 hidden・対照で語が見える） | [isolation-linux-2026-10-24.md](./isolation-linux-2026-10-24.md) |
