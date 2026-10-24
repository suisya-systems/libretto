---
name: shoot
description: >
  libretto の画面を状態ごとに撮る開発用の手順とスクリプト。入口・承認・進行などの状態をプレビューで作り、
  WSL から Windows の Chrome（headless）で 1440 と 390、ライトとダークを撮る。「画面を撮る」「スクリーンショット」
  「状態ごとの画面を見せる」「390px で撮る」「撮った PNG が空 / 接続拒否の画面」などで使う。撮らない UI の実装やテストには使わない。
---

# 画面を状態ごとに撮る

```bash
bash .claude/skills/shoot/shoot.sh --check          # sandbox の中で: 状態ごとのプレビューが立つかだけ確かめる
bash .claude/skills/shoot/shoot.sh                  # sandbox の外で: 全部の状態を撮る
bash .claude/skills/shoot/shoot.sh approval-left    # 状態を選んで撮る
```

出力は `.worker-scratch/shots/<状態>-<1440|390|390full>-<light|dark>.png`（`SHOOT_OUT` で変えられる）。
状態ごとに `preview-<状態>.log` も残る。最後に `all shots ok` が出れば全部撮れている。

| 環境変数 | 既定 | |
| --- | --- | --- |
| `SHOOT_OUT` | `<repo>/.worker-scratch/shots` | 出力先 |
| `SHOOT_PORT` | `7930` | 状態ごとに +1 したポートを使う |
| `SHOOT_PREFIX` | なし | ファイル名の頭（Issue 番号など） |
| `CHROME` | `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe` | Windows の Chrome |

## 前提: WSL から Windows の Chrome を使い、sandbox の外で流す

- Linux 側に動く Chrome が無い前提で、Windows の Chrome を headless で使う。保存先は `wslpath -w` で
  `\\wsl.localhost\...` の形にして渡す
- **撮影は sandbox の外で 1 回のコマンドとして流す**。sandbox の中では WSL の interop が塞がれ、Chrome は
  PNG を 1 バイトも書かずに正常終了する。プレビューも Bash の呼び出しが終わると一緒に消えるので、
  起こす・撮る・止めるを shoot.sh の 1 本で行う
- エージェントが sandbox を外せないときは、`--check` が通るところまで確かめてから、sandbox の外で流せる人に
  `bash .claude/skills/shoot/shoot.sh` の 1 行を頼む
- TMPDIR が無くても動く（プレビューの一時フォルダは `os.tmpdir()`。無ければ `/tmp`）。sandbox の中で `--check`
  を流すときは `/tmp` に書けないので TMPDIR を付けたままにする

## しくみ

1. `npm run build` してから、状態ごとに `preview.ts` を別のポートで起こす。プレビューは一時フォルダに台帳を作り、
   Claude の答えだけを台本（fake）にした本物のホストで、会話 → 入口 → その状態まで進める
2. 起こす前に、そのポートが応答したら止める（前の回の残ったプレビューが別の状態を返してしまう）。
   起こしたあと `/state` が状態名を返すことを確かめる。プレビューは状態に着いて `expect` が通ってから
   `/state` を出すので、着かなければここで止まる（`preview-<状態>.log` の末尾に理由が出る）
3. 捨て撮りを 1 枚撮る。WSL2 の localhost の転送は Windows 側からの最初の接続で張られるので、
   起こした直後の 1 枚目は curl が通っていても `ERR_CONNECTION_REFUSED` の画面になる
4. ライト（`preferredColorScheme=1`）とダーク（`0`）で、それぞれ 3 枚撮る
   - `1440`: 幅 1440 の全体
   - `390`: 390×844。スマートフォンの 1 画面目
   - `390full`: 幅 390 の全体。縦に並んだときの順と、横にはみ出していないかを見る

   全体の 2 枚は 2200px（1440）・4100px（390）で撮り、中身がそれより長ければ中身の高さで撮り直す

### `--virtual-time-budget` を使わず `--timeout` で撮る理由

画面は SSE をつなぎっぱなしにする。`--virtual-time-budget` は通信が止むのを待つので戻らず、外側の timeout に
当たって 1 枚も撮れない。`--timeout=20000` は「load を待つ上限」で、load が来たらその時に撮る。

描画の前に撮らないよう、`/frame` は撮る画面を iframe で開き、iframe の中にその状態の `mark`（と `selector`）が
出て、読み込み中（`aria-busy`）と読み込みの失敗の表示が無くなるまで、ページの中の画像（`/hold`）を返さない。
画像が返らないあいだ load は来ないので、Chrome は待つ。15 秒で出なければ画像を返して撮らせ、撮り直しに回す。
アニメーションは止めて撮る（同じ明暗の 2 枚が違って見えないように）。

### 390px は 390px の iframe を広い窓で撮って切り出す

Windows の Chrome は窓を約 500px より狭くできない。`--window-size=390,...` は黙って広い窓で撮る。
520px の窓に 390px の iframe を置いて撮り、`png-crop.mjs` で左上の 390px を切り出す。

### 撮り直しと打ち切り

- 1 枚ごとに id を付け、プレビューはその id で `READY <id> h=<中身の高さ> dark=<0|1>` か `TIMEOUT <id>` をログに出す。
  shoot.sh は自分の id の `READY` だけを見る
- PNG が無い・その 1 枚の `READY` が無い、のどちらかなら撮り直す。`READY` は frame のページが届いて mark が描けたときだけ
  出るので、接続拒否の画面や描画前の 1 枚はこれで弾ける。バイト数のしきい値は使わない（正しく撮れた 390 の 1 画面目でも
  40KB を切ることがある）（中身の高さでの撮り直しと合わせて 1 枚につき 3 回まで。撮れなければ `gave up` で失敗）
- 最初の捨て撮りで PNG が 1 バイトも書かれなければ、何度撮っても同じなので全体を止める（sandbox の中で流した等）
- `dark=` が頼んだ明暗と違えば失敗にする（`preferredColorScheme` は 0=dark / 1=light。`2` などを渡すとエラーに
  ならずライトで撮れる）

### 撮ったあとの検査

- 同じ幅・同じ明暗で、状態の違う PNG の中身（md5）が同じなら失敗（別の状態を撮れていない）
- 同じ状態のライトとダークが同じなら失敗（明暗が効いていない）
- それでも、撮った PNG は必ず 1 回開いて見る

## 状態を足す

`states.ts` の `STATES` に 1 つ足す。preview.ts と shoot.sh は触らない。

```ts
'approval-redo': {
  script: [...entrance(), draft(1), verdicts(1, true)],      // fake の台本。役割ごとに上から 1 回目、2 回目…
  drive: async (ctx) => { await toApproval(ctx); await ctx.act({ type: 'approval.redo', instruction: '…' }) },
  expect: (v) => v.state === '下書き中',                      // 着いた案件がこの状態か（--check もここを見る）
  mark: W['progress.redoLater'],                              // この状態で画面に必ず出る文言。wording.ts から引く
  selector: '.doc-body',                                      // 任意。mark に加えて、あるまで撮らない要素
  path: (caseId) => `/cases/${caseId}`,                       // 任意。開く画面（既定は案件の面）
  openaiKey: true,                                            // 任意。会話の前に偽の OpenAI の API キーを入れる（別系統・設定済み）
  sameFirst390: true,                                         // 任意。違いが下の方にだけあり、390 の 1 画面目が他の状態と同じになる
},
```

- どの状態も「会話で依頼を 1 つ出して入口待ち（本人の番）に着いたところ」から `drive` が始まる
- `ctx.act` は今の revision と新しい eventId を付けて操作を送る。操作の形は `CaseAction` の型で縛られるので、
  API が変わると `npm run verify` で落ちる（`.claude/skills` は typecheck と lint の対象）
- 作り手を返さずに止めておきたいときは台本を `['作り手', { fail: 'hang' }]` にする
- 撮れるのはホストの操作で作れる状態まで。画面の中だけの状態（差分のタブ、直してほしいことの入力欄を開いたところ等）は
  撮れない。要るときは frame の中で押す仕組みを足す
- 足したら `--check` を流してから撮る

## 症状の見分け方

| 見えるもの | 実体 |
| --- | --- |
| `first shot wrote no png` | sandbox の中で流した。sandbox の外で流す |
| `port N is in use` | 前の回のプレビューが残っている。自分で起こしたものなら止め、そうでなければ `SHOOT_PORT` をずらす |
| `preview X not serving` | その状態に着かなかった。`preview-X.log` の末尾（`stuck at` / `not X`）を見る |
| `retry ... TIMEOUT` が続く | 15 秒で mark が出なかった。mark の文言・selector・画面の表示を見直す |
| `grow X to Npx` | 全体の 1 枚の中身が見込みより長かったので、その高さで撮り直した（失敗ではない） |
| `duplicate across states` | 別の状態のはずが同じ画面。`expect` と `mark` が状態を区別できているか見る |
