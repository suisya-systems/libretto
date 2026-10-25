# 画面の言葉

libretto の画面に出す言葉の正本。設計書（[`docs/design.md`](./design.md)・[`docs/implementation.md`](./implementation.md)）は内部の言葉で書かれているので、画面に出すときはこの表で置き換える。対応表はオーナーが 2026-10-23 に承認した。

## 決め事

1. **画面には「画面での言葉」の列の語だけを出す。** 理由: 画面を使うのは日本の会社員で、設計の内部用語や英語の直訳を見せると意味を聞き返させることになる。文言の表 `page/src/wording.ts` はこの列に揃える。
2. **設計書は内部の言葉のままでよい。** 理由: 設計書の読者はオーナーと実装者で、役割や段階を区別するために短い内部の言葉が要る。設計書を書き換えると決定の記録と食い違うので、置き換えは画面に出すところだけで行う。
3. **判定の問いは「日本の会社員が実際にそう言うか」で、「和語かどうか」ではない。** 理由: 「チェック」「ステータス」「プレビュー」のように普段の仕事で使うカタカナ語は、無理に和語へ言い換えるとかえって通じない。逆に和語でも「合図」「検品」のように仕事の画面で見かけない語は使わない。
4. **画面に新しい言葉を足すときは、先にこの表へ足す。** 理由: 表を経ずに画面の文言を増やすと、同じものに別の名前が付いたり、内部の言葉がそのまま漏れたりする。表に足してから `wording.ts` に入れる。

## 対応表

| 設計書での言葉 | 画面での言葉 | 理由 |
|---|---|---|
| あなたの番 | 確認待ち（見出しは「確認待ちが 1 件あります」） | 英語の "your turn" の直訳。仕事では「確認待ち」と言う |
| 合図 | ラベル／リアクション（設定画面の見出しは「取り込みの目印」） | 設計書の内部の言葉。実際に付けるのはラベルとリアクションなので、その名前で呼ぶ |
| 合図 — :memo: を付けた投稿 | リアクション :memo: | 同上。Slack で普段使う呼び方 |
| 合図 — ラベル libretto | ラベル libretto | 同上。Gmail で普段使う呼び方 |
| 接続と合図（画面名） | 設定（中の見出しは「連携」「取り込みの目印」「自動検出」） | 設計書の内部の区分。アプリのこの画面は普段「設定」と呼ぶ |
| 接続／接続済み／外す | 連携／連携済み／連携を解除 | 外部サービスとのつなぎは普段「連携」と言う |
| 入口（画面名） | 依頼の確認 | 設計書の内部の言葉。画面でやることの名前にする |
| 入口（取り込む先） | 取り込み元 | 同上。どこから来たかを普段の言い方で示す |
| 入口を見る | 依頼内容を見る | 同上 |
| 入口ごとの進め方 | 取り込み元ごとの進め方 | 同上 |
| 既定 | 初期設定 | 英語の "default" の直訳。設定画面では「初期設定」と言う |
| 届いた候補 | 依頼の候補 | 「届いた」は内部の流れの言い方。何の候補かを言う |
| 依頼かもしれないもの | 依頼かどうかはっきりしないもの | 曖昧さの理由が伝わる言い方にする |
| 内容から拾ったもの | 本文から自動で見つけたもの | 「拾う」は設計書の内部の言葉。誰がどこから見つけたかを言う |
| 推測 | 自動検出 | 英語の "inference" の直訳。機能の名前としては「自動検出」と言う |
| 確信度 高・中・低 | 可能性 高・中・低 | 英語の "confidence" の直訳。普段は「可能性」と言う |
| 拾う・拾い上げ | 取り込む | 設計書の内部の言葉。普段そう言う |
| 拾った理由 | 見つけた理由 | 同上 |
| 拾い漏れ | 見落とし | 同上 |
| 拾わないようにする | 除外する | 同上。設定の操作としては「除外」と言う |
| 材料・材料待ち・材料をそろえる | 資料・資料待ち・資料を集める | 設計書の内部の言葉。仕事で集めるのは「資料」 |
| 検品・検品中・検品の結果 | チェック・チェック中・チェック結果 | 「検品」は物流の言葉で文書には使わない。普段そう言う |
| 別の目で確かめた | ダブルチェック済み（進行中は「ダブルチェックしています」） | 設計書の内部の言い方。普段そう言う |
| 合格の条件 | チェック項目 | 設計書の内部の言葉。普段そう言う |
| 合格 7・残り 1 | OK 7・要確認 1 | 試験の言い方になっている。仕事のチェックでは OK／要確認と言う |
| 合格・不合格 | OK・NG | 同上 |
| 不合格（バージョンに対して） | 差し戻し | 文書が通らなかったときは普段「差し戻し」と言う |
| 支持・一部支持 | 一致・一部一致（出典の内容と一致） | 英語の "supported" の直訳。出典と合っているかは「一致」と言う |
| 声・あなたの声・声の見本・調子 | 文体・あなたの文体・文体の見本・文体 | 英語の "voice" "tone" の直訳。文章の書きぶりは「文体」と言う |
| 送付（段階名） | 保存 | 設計書の内部の言葉。実際の操作は保存なのでそう呼ぶ。「共有」はほかの人に見せる操作の説明にだけ使う |
| 届け先 | 保存先 | 同上 |
| あなただけのページ | Web ページ（自分だけ閲覧・履歴付き） | 英語の直訳調。何の形でだれが見られるかを書く |
| 完成稿 | 最終版 | 出版の言葉。仕事の文書では「最終版」と言う |
| 決まっていないこと | 確認したいこと | 内部の言い方。相手に何をしてほしいかが伝わる言い方にする |
| 完成した依頼 | 完了した依頼 | 依頼は「完了」と言う |
| 全部止める・この依頼を止める | すべて停止・この依頼を中止 | ボタンの言葉として普段そう言う |
| 作れるものの点検・いま点検する・点検し直す | 動作環境の確認・もう一度確かめる | 設計書の内部の言葉。アプリの画面では普段そう言う。直した後に押すボタンなので「もう一度」と言う（GitHub #63。前は「今すぐ確認」） |
| Claude Code・作り手と判定役の CLI | AI（入れ方とログインのコマンドの中だけは `claude` のまま） | 画面には製品の名前を出さない（11.2 の出さない語）。コマンドは貼り付けて動かなければ意味がないので、名前を変えない（GitHub #63） |
| 隔離・作り手から確認項目を隠す仕組み | チェック項目をライターから隠す仕組み | 「隔離」「サンドボックス」は技術の言葉。何を何から隠すかを言う（作り手は画面では「ライター」。オーナー判断 2026-10-24） |
| 隔離が強い・弱い・壊れている（strong / weak / broken） | しっかり隠せています・弱い・動きません | 英語の段階名は出さない。状態をふだんの言い方で言う |
| 隔離の点検の結果（見えない・見えた・確かめられない） | ライターからチェック項目は見えませんでした・見えました・チェックできませんでした | 何を確かめて何が分かったかを 1 文で言う |
| 隔離の失敗（canary を当てた停止） | ライターにチェック項目が見えたおそれ | 語が出たことは「見えた」の強い証拠だが断定はできないので「おそれ」と言う。「見えました」は対照付きで確かめた点検の結果にだけ使う |
| 版・第 2 版・前の版 | バージョン・バージョン 2・前のバージョン | 「版」は出版の言葉。文書の改訂は普段「バージョン」と言う |
| 進み具合 | 進捗 | 普段そう言う |
| 一覧の列名「いま」 | ステータス | 列名として普段そう言う |
| あなたがすること | 次にすること | 英語の "your action" の直訳調。普段そう言う |
| 話して依頼する・依頼を始める | チャットで依頼する・依頼する | 「話して」は内部の言い方。画面での操作は「チャット」 |
| 内容を変える | 内容を修正 | ボタンの言葉として普段そう言う |
| 推奨（選択肢の） | おすすめ | 画面案 2 の言い方。「推奨」は書類の言葉で、選ぶ場面では普段「おすすめ」と言う |
| 自動で始まったもの・自動で入りました | 自動で開始した依頼・自動で開始 | 何が始まったかが伝わる言い方にする |
| 読んで決める・決めてください | 確認する・承認しますか | 設計書の内部の言い方。承認の操作は普段そう言う |
| やり直しを頼む・直しを頼む | 作り直しを依頼・修正を依頼 | 同上。ボタンの言葉として普段そう言う |
| これまでの出来事 | 履歴 | 普段そう言う |
| どこへ・誰に見えるか・貼り付け用の見え方 | 保存先・公開範囲・貼り付け用のプレビュー | 内部の言い方。設定項目の名前として普段そう言う |
| 鍵・キー（別系統・Jev） | API キー（欄の名前は「OpenAI の API キー」「Jev（TypeSafe）の API キー」。保存後は「設定済み（末尾 1a2b）」、操作は「入れ直す」「削除」） | 「鍵」は設計書の内部の言葉。画面で入れるものは普段「API キー」と呼ぶ |
| 共有リンクを作る | （v1 は出さない）HTML をダウンロードして渡せます | v1 は公開 URL を持たず、共有リンクはほかの人に届かない（実装設計書 P1）。ほかの人に見せる方法を、実際にできる操作で書く |
| 本人への知らせ・通知 | 通知（設定の見出しは「お知らせ」。端末の操作は「この端末に通知する」） | ブラウザやスマホが出すものは普段「通知」と呼ぶ。画面の中の一覧はもとの「お知らせ」のまま |
| ペアリング・ペアリングの URL・セッション | 端末の追加・追加用のアドレス・端末 | 「ペアリング」は機器どうしをつなぐ技術の言い方。本人がすることは「この端末で開けるようにする」なので、端末を足す・外すと言う |
| 静かな時間 | 通知を止める時間帯 | 「静かな時間」は内部の言い方。何をする設定かを言う |
| 結果が無く予約（`hold`）の額で確定した（費用の欄の 1 行） | 費用が分からなかったので予約の額で数えました | 文言はオーナーが決めた（2026-10-23。実装設計書 9.4 (7)）。何が起きて、どう数えたかを 1 行で言う |

## そのまま使う語

次の語は設計書と画面で同じ語を使う。普段の仕事でそのまま通じるため。

おまかせ／確認しながら／進める／見送る／下書き／依頼書／承認／出典／要確認／貼り付け用の下書き／控え／ステータス／プレビュー／リンク／ダウンロード

## 画面の文言

画面に出る文は、作るところで 2 つに分かれる。どちらもこの章に全文を載せ、正本と一致することをテストで確かめる（実装設計書 5.8 (4)）。

### ホストが作って返す文

正本は `host/src/case/transition.ts`。画面は応答の値をそのまま出し、`wording.ts` に同じ文を持たない。

**いまの 1 行（`CaseCard.step`。`STEP` の 16 個）**

| キー | 文 |
|---|---|
| `drafting` | 依頼書とチェック項目を書いています |
| `entranceFailed` | 依頼書とチェック項目を整えられませんでした |
| `entrance` | 依頼内容を確認してください |
| `autoEntrance` | 自動で進めています |
| `materials` | 資料を集めています |
| `waitMaterials` | 資料を貼り付けてください |
| `writing` | 下書きを書いています |
| `checking` | チェックしています |
| `outline` | 構成案を確認してください |
| `final` | 最終版を確認してください |
| `tailoring` | 保存先の形に整えています |
| `confirmSave` | 保存先を確認してください |
| `saving` | 保存しています |
| `done` | 完了しました |
| `stopped` | 中止しました |
| `cancelled` | 取り消しました |

**会話欄に足す 1 行（`SAY` の 10 個）**

| キー | 文 |
|---|---|
| `autoStarted` | 自動で開始しました |
| `roundLimit` | 修正の往復が 3 回に達したので中止しました |
| `stuck` | 同じ項目が 2 回続けて直らなかったので中止しました |
| `unjudgeable` | 残った項目を AI では確かめられないので中止しました |
| `saveFailed` | 保存できなかったので中止しました |
| `toolFailed` | 動作環境の不具合で中止しました |
| `costCap` | 費用の上限に達したので中止しました |
| `isolationLeaked` | ライターにチェック項目が見えたおそれがあるので中止しました |
| `heldShared` | ほかの人にも見えるかもしれない保存先なので、保存の前に確認を待っています |
| `heldQuote` | ほかの人の言葉を引用しているので、保存の前に確認を待っています |

**お知らせの 1 行（`NOTICE`。実装設計書 6.8 (3)）**

お知らせ欄・ブラウザの通知・Slack の DM に同じ文を出す。通知の見出しは「libretto」。`{題}` は依頼の題（本文・他人の名前は入れない）、`{n}` は数。

| 出来事 | キー | 文 | 開く面 |
|---|---|---|---|
| 依頼の確認（T6） | `entrance` | 『{題}』の依頼内容がまとまりました。確認して承認してください | `/cases/<id>` |
| 依頼の確認（T6b） | `entranceFailed` | 『{題}』の依頼書とチェック項目を整えられませんでした。直して出し直すか取り消せます | `/cases/<id>` |
| 資料待ち | `materials` | 『{題}』で資料を待っています。貼り付けると続きを進めます | `/cases/<id>` |
| 構成案 | `outline` | 『{題}』の構成案ができました。確認してください | `/cases/<id>` |
| 最終版 | `final` | 『{題}』の最終版ができました。確認して承認してください | `/cases/<id>` |
| 最終版（要確認が残る） | `finalMarks` | 『{題}』の最終版ができました。要確認が {n} 件あります。確認して承認してください | `/cases/<id>` |
| 保存先の確認 | `confirmSave` | 『{題}』を保存する前の確認です。保存先と公開範囲を確かめてください | `/cases/<id>/deliver` |
| 中止 | `stopped` | 『{題}』は、{理由}。新しい依頼として出し直せます | `/cases/<id>` |
| 中止（`SAY` に無い理由） | `stoppedPlain` | 『{題}』を中止しました。新しい依頼として出し直せます | `/cases/<id>` |
| 完了 | `done` | 『{題}』を保存しました。開いて確かめられます | `/cases/<id>` |
| 自動で開始 | `autoStarted` | 『{題}』を自動で開始しました。止めたいときは取り消せます | `/cases/<id>` |
| 候補 | `candidates` | 依頼の候補が {n} 件届きました。進めるか見送るかを選べます | `/` |
| 下書きに取りかかった | `started` | 『{題}』の下書きを書き始めました | `/cases/<id>` |
| 通知を止める時間帯の明け（実装設計書 6.8 (4)(14)） | `quietEnd` | 通知を止めていたあいだに、{内訳}がありました | `/` |

`{理由}` は会話欄の `SAY` の文をそのまま使う（例: 「『週報』は、費用の上限に達したので中止しました。新しい依頼として出し直せます」）。`{内訳}` は「確認待ち {n} 件」「中止 {n} 件」「完了 {n} 件」「自動で開始 {n} 件」「下書きに取りかかった {n} 件」「依頼の候補 {n} 件」をこの順に「・」でつないだもので、0 件の項目は省く（例: 「通知を止めていたあいだに、確認待ち 2 件・依頼の候補 3 件がありました」）。

**Slack の DM に足す文（`host/src/server/slack-dm.ts` の `SLACK_DM`。実装設計書 6.8 (3)(12)）**

Slack の DM は、2 分のあいだに出たお知らせの 1 行を改行で並べた 1 通。`open` は各行の後ろのリンクの文字で、Tailscale の HTTPS のアドレスがあるときだけ付ける。無いときはリンクを付けず、最後に `openApp` を 1 行足す。21 行目からは並べず `more` の 1 行にする（`{n}` は並べなかった数）。

| キー | 文 |
|---|---|
| `open` | 開く |
| `openApp` | libretto の画面を開いてください |
| `more` | ほか {n} 件は libretto のお知らせ欄で見られます |

**話し相手の代わりに会話欄に書く 1 行（`host/src/roles/conversation.ts` の `TALK`。実装設計書 6.2.1 (7)）**

`retry` と `retryWhy` は `failed` の行に付ける選択肢の文と、その 1 行。`moved` は案件の中の会話で直す内容がまとまったが、その間に依頼の状態が変わっていたときの 1 行（実装設計書 6.2.2 (8)）。`candidateMoved` は候補の中の会話（「内容を修正」）で同じことが起きたときの 1 行（実装設計書 6.4 (5)）。

| キー | 文 |
|---|---|
| `failed` | 返事を作れませんでした |
| `costCap` | 費用の上限に達したので返事できません |
| `stopped` | 停止したので返事を止めました |
| `retry` | もう一度送る |
| `retryWhy` | 同じ内容で、もう一度返事を作ります |
| `moved` | 依頼の状態が変わったので、直す内容を受け付けられませんでした |
| `candidateMoved` | 候補の状態が変わったので、直す内容を受け付けられませんでした |

**追加用のアドレスを開いたときの確かめの画面（`host/src/server/app.ts` の `PAIR`。実装設計書 6.12 (7)）**

開いただけでは追加せず、「この端末を追加する」を押したときに追加する。端末の名前は「別の端末を追加する」で入れたもの（無ければ `pairConfirm.unnamed`）、期限は日本時間の時刻。

| キー | 文 |
|---|---|
| `pairConfirm.title` | この端末を追加しますか |
| `pairConfirm.name` | 追加する端末: {label} |
| `pairConfirm.unnamed` | 名前のない端末 |
| `pairConfirm.expires` | {at} まで使えます |
| `pairConfirm.browser` | いつも使うブラウザで開いてから押してください。チャットのアプリの中で開いたときは、アドレスをコピーしてブラウザに貼ってください。 |
| `pairConfirm.add` | この端末を追加する |

### 画面が `wording.ts` で引くラベル

正本は `page/src/wording.ts`。`{n}` などは画面が数や日付を入れるところ。

**ステータス（`CaseState` → 画面での言葉）**

| 設計書での言葉 | 画面での言葉 |
|---|---|
| 候補 | 依頼の候補 |
| 入口待ち | 依頼の確認待ち |
| 材料待ち | 資料待ち |
| 下書き中 | 下書き中 |
| 検品中 | チェック中 |
| 承認待ち | 承認待ち |
| 送付確認待ち | 保存先の確認待ち |
| 送付中 | 保存中 |
| 完了 | 完了 |
| 停止 | 中止 |
| 見送り | 見送り |
| 取り消し | 取り消し |

**ナビと枠**

| キー | 文 |
|---|---|
| `nav.home` | ホーム |
| `nav.done` | 完了した依頼 |
| `nav.settings` | 設定 |
| `nav.label` | メイン |
| `stop.button` | すべて停止 |
| `stop.title` | すべての依頼を停止しますか |
| `stop.body` | 動いている依頼をすべて中止します。中止した依頼は自動では再開しません。 |
| `stop.cancel` | やめる |
| `band.stopped` | すべて停止しています |
| `band.release` | 停止を解除 |
| `band.storage` | 変更を保存できていません。PC の空き容量を確かめてください |
| `band.sendFailed` | 送れませんでした。もう一度押してください |
| `load.offline` | libretto につながりません |
| `load.failed` | 読み込めませんでした |
| `load.retry` | もう一度読み込む |
| `pair.title` | この端末はまだつながっていません |
| `pair.body` | ホストを動かしている PC で表示される URL を開いてください |
| `notFound.title` | ページが見つかりません |
| `notFound.home` | ホームへ |
| `pending.badge` | 準備中 |
| `pending.body` | この画面は準備中です |

**ホーム**

| キー | 文 |
|---|---|
| `home.yourTurn` | 確認待ちが {n} 件あります |
| `home.noTurn` | 確認待ちはありません |
| `home.noTurnLead` | いま、あなたがすることはありません |
| `home.turnHeading` | 確認待ち |
| `home.open` | 確認する |
| `home.askHeading` | チャットで依頼する |
| `home.askLabel` | 作りたいものを、ふだんの言葉で書いてください。足りないことは順に聞きます。 |
| `home.askPlaceholder` | 例: 先週のブレストを note 記事にまとめて。前に書いた記事と同じ文体で。 |
| `home.askButton` | 依頼する |
| `home.askNote` | 記事・メモ・表・スライドが作れます。ほかの人への共有の前には必ず確認します。 |
| `chat.log` | 会話 |
| `chat.who.本人` | あなた |
| `chat.who.libretto` | libretto |
| `chat.send` | 送る |
| `chat.hint` | Ctrl + Enter でも送れます |
| `chat.thinking` | 返事を書いています |
| `chat.noReply` | 返事が届きませんでした |
| `chat.retry` | もう一度送る |
| `chat.recommended` | おすすめ |
| `chat.chosen` | 選びました |
| `chat.openCase` | 依頼内容を見る |
| `chat.stopped` | すべて停止しているあいだは送れません |
| `home.autoHeading` | 自動で開始した依頼 |
| `home.autoEmpty` | 自動で開始した依頼はありません |
| `home.auto.from.gmail` | メールのラベルから |
| `home.auto.from.slack` | Slack のリアクションから |
| `home.auto.from.meet` | 会議メモから |
| `home.auto.at` | {at} に開始 |
| `home.activeHeading` | 進行中の依頼 |
| `home.activeEmpty` | 進行中の依頼はありません |
| `home.colCase` | 依頼 |
| `home.colState` | ステータス |
| `home.colNext` | 次にすること |
| `home.colMode` | 進め方 |
| `home.nextNone` | いまはありません |
| `home.noticeHeading` | お知らせ |
| `home.noticeEmpty` | お知らせはありません |
| `home.defaultsHeading` | 取り込み元ごとの進め方（初期設定） |
| `home.src.会話` | チャットで依頼 |
| `home.src.gmail` | メール |
| `home.src.slack` | Slack |
| `home.src.meet` | 会議メモ |
| `count` | {n} 件 |
| `card.version` | バージョン {n} |
| `card.deadline` | 期限 {d} |
| `card.auto` | 自動で開始 |
| `card.cost` | {yen} 円相当 ／ 上限 {cap} 円 |

**依頼の面（S0 は見出しだけ）**

| キー | 文 |
|---|---|
| `case.back` | ホーム |
| `case.notFound` | この依頼は見つかりません |
| `case.cost` | 費用 |
| `case.pending` | この依頼の詳しい画面は準備中です |

**依頼の確認（入口の面。実装設計書 6.2.2 (10)）**

`dest.*` は保存先の名前、`talk.*` は「話して内容を変える」の会話欄。

| キー | 文 |
|---|---|
| `dest.page` | Web ページ（自分だけ閲覧・履歴付き） |
| `dest.paste` | 貼り付け用の下書き |
| `dest.gdoc` | Google ドキュメント |
| `dest.gsheet` | Google スプレッドシート |
| `dest.gslide` | Google スライド |
| `dest.pptx` | PowerPoint のファイル |
| `dest.xlsx` | Excel のファイル |
| `dest.docx` | Word のファイル |
| `action.moved` | もう進んでいます。読み直します |
| `entrance.waitLead` | できあがるまで数分かかります。このページを閉じても進みます。 |
| `entrance.failedLead` | 直してほしいことを書いて出し直すか、この依頼を取り消してください。 |
| `entrance.briefHeading` | 依頼書 |
| `entrance.brief.docType` | 作るもの |
| `entrance.brief.subject` | 書く内容 |
| `entrance.brief.wanted` | 渡してほしいもの |
| `entrance.brief.gather` | libretto が集めるもの |
| `entrance.brief.audience` | 読む人 |
| `entrance.brief.destinations` | 保存先 |
| `entrance.brief.shape` | 分量・形 |
| `entrance.brief.voice` | 文体 |
| `entrance.brief.sources` | 出典 |
| `entrance.brief.deadline` | 期限 |
| `entrance.brief.mustNot` | してはいけないこと |
| `entrance.none` | なし |
| `entrance.wantedNote` | 進めると、次にこれを貼り付けてもらいます。 |
| `entrance.gatherNote` | 「これで進める」を押すと、libretto がウェブで探して資料に加えます。見つからなかったときは、出典の無いところに【要確認】を付けて書きます。 |
| `entrance.voice.合わせる` | あなたの文体に合わせる |
| `entrance.voice.合わせない` | 合わせない |
| `entrance.sources.出典付き` | 出典を付ける |
| `entrance.sources.出典なし` | 出典は付けない |
| `entrance.assumptionsHeading` | 聞かずに決めたこと |
| `entrance.undecidedHeading` | 確認したいこと |
| `entrance.undecidedLead` | おすすめを選んであります。変えるときは選び直してください。 |
| `entrance.leaveIt` | おまかせする |
| `entrance.leaveItNote` | ライターが決めます |
| `entrance.pickMany` | 当てはまるものを全部選べます |
| `entrance.pickNone` | 1 つ以上選ぶか、おまかせにしてください |
| `entrance.unanswered` | 選んでいない問いがあります |
| `entrance.mismatchHeading` | 依頼書とチェック項目で違うところ |
| `entrance.mismatchLead` | このまま進めるか、直して出し直すかを選べます。 |
| `entrance.mismatch.brief` | 依頼書 |
| `entrance.mismatch.check` | チェック項目 |
| `entrance.checksHeading` | チェック項目 |
| `entrance.sameFamily` | チェック項目は、ライターと同じ種類の AI が作りました。見落としが重なることがあります。 |
| `entrance.otherFamily` | チェック項目は、ライターとは別の種類の AI が作りました（ダブルチェック）。 |
| `entrance.fallback.no_key` | 設定で API キーを入れると、別の種類の AI が作ります。 |
| `entrance.fallback.unavailable` | 別の種類の AI につながりませんでした。設定の API キーを確かめてください。 |
| `entrance.fallback.link` | 設定を開く |
| `entrance.voice.made` | 見本 {n} 件から、あなたの文体を読み取りました。ライターはこの文体で書きます。 |
| `entrance.voice.none` | あなたの文体の見本を読めなかったので、文体は合わせません。 |
| `entrance.voice.link` | 設定で見本を登録する |
| `entrance.own.pass` | あなたの過去の文章は通ります |
| `entrance.own.fail` | あなたの過去の文章も通りません |
| `entrance.checksShow` | すべての項目を見る |
| `entrance.checksHide` | 閉じる |
| `entrance.ifNg` | NG のときライターに返す一言: |
| `entrance.method.機械` | 機械で確認 |
| `entrance.method.読み手` | 読んで確認 |
| `entrance.phase.形式` | 保存先の形 |
| `entrance.hidden.true` | ライターには見せない |
| `entrance.hidden.false` | ライターにも伝わる |
| `entrance.minority` | 別の答えを確かめる |
| `entrance.modeHeading` | 進め方 |
| `entrance.mode.確認しながら` | 下書きができたら確認をお願いします |
| `entrance.mode.おまかせ` | 途中で確認を求めずに進めます。ほかの人に見える保存の前には確認します |
| `entrance.costCap` | 費用の上限 {cap} 円 |
| `entrance.approve` | これで進める |
| `entrance.revise` | 直して出し直す |
| `entrance.reviseLabel` | 直してほしいことを書いてください |
| `entrance.reviseSend` | 出し直す |
| `entrance.reviseCancel` | やめる |
| `entrance.talk` | 話して内容を変える |
| `entrance.cancel` | 取り消す |
| `entrance.cancelTitle` | この依頼を取り消しますか |
| `entrance.cancelBody` | この依頼はここで終わり、再開できません。 |
| `entrance.cancelNo` | やめる |
| `talk.heading` | 話して内容を変える |
| `talk.label` | 依頼書やチェック項目をどう変えたいか、ふだんの言葉で書いてください。 |
| `talk.placeholder` | 例: 読む人を社内の人に変えて。 |
| `talk.note` | まとまったら依頼書とチェック項目を出し直します。 |

**進行の面（画面 3。実装設計書 6.2.3 (8)）と、ログイン切れの帯（6.2.3 (7)）**

`event.*` は「履歴」の 1 行（出来事の名前ごと。表に無い出来事は出さない）。`reason.*` は止まった理由（`stopReason` の値ごと。表に無い値は `reason.other`）。

| キー | 文 |
|---|---|
| `band.signIn` | AI のログインが切れています。PC でログインし直してから「続ける」を押してください |
| `band.signInResume` | 続ける |
| `band.isolationWeak` | この環境では、ライターからチェック項目を隠す仕組みが弱いです（チェック項目のファイルは別の場所にありますが、OS の仕切りはありません） |
| `band.isolationBroken` | ライターからチェック項目を隠す仕組みが動きません。下書きは始まりません。libretto を再起動してください |
| `band.isolationLink` | 設定を開く |
| `band.envMissing` | 動作環境で足りないものが {n} 件あります |
| `band.envLink` | 直し方を見る |
| `progress.now` | いま |
| `progress.round` | {n} 回目のチェック（最大 {max} 回） |
| `progress.lead` | このページを閉じても進みます。 |
| `progress.nextHeading` | 次にすること |
| `progress.nextNone` | いまはありません。進んだらこの画面に出ます。 |
| `progress.redoLater` | チェックが終わったら、直してほしいことを頼めます。 |
| `progress.stop` | この依頼を中止 |
| `progress.stopTitle` | この依頼を中止しますか |
| `progress.stopBody` | 動いている作業を止めます。中止した依頼は、新しい依頼として出し直せます。 |
| `progress.stopNo` | やめる |
| `progress.stoppedHeading` | 中止しました |
| `progress.stoppedLead` | ここまでのバージョンと履歴は残っています。 |
| `progress.restart` | 新しい依頼として出し直す |
| `progress.restartNote` | 依頼内容の確認から始め直します |
| `progress.cancelledHeading` | 取り消しました |
| `progress.cancelledLead` | この依頼はここで終わりです。 |
| `progress.stepsLabel` | 進み具合 |
| `progress.step.entrance` | 依頼の確認 |
| `progress.step.materials` | 資料を集める |
| `progress.step.draft` | 下書き |
| `progress.step.check` | チェック |
| `progress.step.approve` | 承認 |
| `progress.step.save` | 保存 |
| `progress.stepDone` | 済み |
| `progress.stepNow` | いまここ |
| `progress.stepYours` | あなたの番 |
| `progress.stepHalted` | ここで中止 |
| `progress.stepNext` | 次に確認をお願いします |
| `progress.stepAuto` | 確認を求めずに進みます |
| `progress.draftUpTo` | バージョン {n} まで |
| `progress.versionsHeading` | バージョン |
| `progress.versionsNote` | 前のバージョンも残ります |
| `progress.versionsEmpty` | まだバージョンはありません |
| `progress.versionSize` | {chars} 字・見出し {headings} |
| `progress.ver.検品中` | チェック中 |
| `progress.ver.合格` | OK |
| `progress.ver.不合格` | 書き直しへ |
| `progress.ver.承認済み` | 承認済み |
| `progress.materialsHeading` | 資料 |
| `progress.materialGathered` | libretto が集めた |
| `progress.gatherFailed` | ウェブで資料を見つけられませんでした |
| `materials.eyebrow` | あなたの番 |
| `materials.lead` | 下書きに使う資料を、ここに貼り付けてください。 |
| `materials.wantedHeading` | 渡してほしいもの |
| `materials.label` | 貼り付ける文 |
| `materials.count` | {n} 字 |
| `materials.send` | 渡して進める |
| `progress.historyHeading` | 履歴 |
| `event.created` | 依頼を受け付けました |
| `event.entrance.drafted` | 依頼書とチェック項目ができました |
| `event.entrance.failed` | 依頼書とチェック項目を整えられませんでした |
| `event.entrance.revise` | 依頼内容の出し直しを頼みました |
| `event.entrance.approve` | 依頼内容を確認しました |
| `event.materials.provided` | 資料を受け取りました |
| `event.materials.ready` | 資料がそろいました |
| `event.outline.done` | 構成案ができました |
| `event.outline.approve` | 構成案を確認しました |
| `event.draft.done` | 新しいバージョンができ、チェックに入りました |
| `event.review.pass` | チェックが終わりました |
| `event.review.fail` | チェックで直すところが見つかり、書き直しに回しました |
| `event.approval.ok` | 最終版を承認しました |
| `event.approval.redo` | 直してほしいことを頼みました |
| `event.stop.case` | 中止しました |
| `event.stop.all` | すべて停止で中止しました |
| `event.fail.system` | 問題が起きたので中止しました |
| `event.cost.cap` | 費用の上限に達したので中止しました |
| `event.cancel` | 取り消しました |
| `event.restart_as_new` | 新しい依頼として出し直しました |
| `event.format.checked` | 保存先の形をチェックしました |
| `event.format.failed` | 保存先の形で直すところが見つかり、書き直しに回しました |
| `event.review.fail.up` | チェックで直しきれない項目があり、あなたの確認に回しました |
| `event.review.fail.stop` | チェックで直しきれない項目があり、中止しました |
| `event.format.failed.up` | 保存先の形で直しきれない項目があり、あなたの確認に回しました |
| `event.format.failed.stop` | 保存先の形で直しきれない項目があり、中止しました |
| `event.delivery.send` | 保存を頼みました |
| `event.delivery.decline` | 保存しないで戻りました |
| `event.delivery.done` | 保存先に保存しました |
| `event.delivery.done.page` | Web ページに保存しました |
| `event.delivery.done.paste` | 貼り付け用の下書きに保存しました |
| `event.delivery.done.gdoc` | Google ドキュメントに保存しました |
| `event.delivery.failed` | 保存できなかったので中止しました |
| `event.delivery.mismatch` | 保存した文書の中身が本文と違ったので、書き直しに回しました |
| `event.delivery.unknown` | 保存できたか確かめています |
| `event.delivery.change` | 保存先を変えました |
| `event.delivery.add` | 別の保存先への保存を頼みました |
| `reason.本人が止めた` | あなたが中止しました |
| `reason.緊急停止` | すべて停止で中止しました |
| `reason.費用上限` | 費用の上限に達しました |
| `reason.往復上限` | 修正の往復が 3 回に達しました |
| `reason.直らない` | 同じ項目が 2 回続けて直りませんでした |
| `reason.判定できない` | 残った項目は AI では確かめられませんでした |
| `reason.送付失敗` | 保存先に保存できませんでした |
| `reason.時間切れ` | 時間がかかりすぎたので止めました |
| `reason.つながらない` | AI につながりませんでした |
| `reason.書けなかった` | 下書きを書けませんでした |
| `reason.判定できなかった` | チェックを終えられませんでした |
| `reason.隔離の失敗` | ライターにチェック項目が見えたおそれがありました |
| `reason.other` | 中止しました |

**承認の面（画面 4。実装設計書 6.2.5 (8)）**

`approval.diff.*` は前のバージョンとの違いの 1 行の印。`approval.early.*` は 3 回目を待たずに本人に上げたときだけ、「直しきれなかった項目が N 件」の下に出す 1 行（なぜ今あなたの番なのか）。`approval.stuck` は 2 回続けて直らなかった項目に付ける印（実装設計書 6.2.7 (5)）。履歴の `event.review.fail` / `event.format.failed` は、行き先が承認待ちなら `.up`、停止なら `.stop` の文に替える。`approval.sameFamily` と `approval.noJudgeModel` / `approval.judgeModelPartial` は判定の結果の注記（`familyNote` / `jevNote` があるとき）。`approval.judgeModel` / `approval.judgeModelUnsure` は判定専用の AI が確かめた数（`ReviewSummary.jev`。実装設計書 7.6 (6)）。`approval.marks*` / `approval.mark.*` は【要確認】の付いた文ごとの選択で（キーの `印のまま` / `削る` は `approval.ok.marks` の値。画面の文はオーナー判断 2026-10-25 で改めた）、削るが 1 つでもあれば主ボタンが `approval.okCut` に替わる。`approval.sources*` / `approval.source.*` は出典ごとのチェックの結果（`SourceRow.verdict` の値ごと。実装設計書 6.3.1 (8)(11)）。`approval.voice*` は文体カードとの比べの表（実装設計書 6.3.2 (9)）。一人称の行は、あなたかこの版のどちらかが「なし」なら出さない（オーナー判断 2026-10-25。「あなた: 私／この版: なし／合っています」のように、使っていないのに合っていると読めて分かりにくいため。あなたが「なし」のときは判定もしない）。

| キー | 文 |
|---|---|
| `approval.eyebrow` | あなたの番 |
| `approval.allPassed` | チェックはすべて通りました（{n} 項目） |
| `approval.remaining` | チェックで直しきれなかった項目が {n} 件あります |
| `approval.early.直らない` | 同じ項目が 2 回続けて直らなかったので、3 回目に進まずあなたに回しました |
| `approval.early.判定できない` | 残っている項目は AI では確かめられないので、あなたに回しました |
| `approval.remainingLead` | このまま承認するか、直してほしいことを伝えてください。 |
| `approval.ok` | これで承認する |
| `approval.redo` | 直してほしいことを伝える |
| `approval.redoLabel` | どこをどう直してほしいか書いてください |
| `approval.redoSend` | この内容で直してもらう |
| `approval.redoCancel` | やめる |
| `approval.changeDest` | 保存先を変える |
| `approval.changeDestLabel` | 保存先を選んでください（1 つ以上） |
| `approval.changeDestSave` | この保存先にする |
| `approval.changeDestCancel` | やめる |
| `approval.changeDestNote` | 保存先を変えたら、もう一度「これで承認する」を押してください。 |
| `approval.version` | バージョン {n} |
| `approval.draftTab` | 本文 |
| `approval.diffTab` | 前のバージョンとの違い |
| `approval.draftFailed` | 本文を読み込めませんでした |
| `approval.noDiff` | 前のバージョンと同じです |
| `approval.diff.added` | 追加 |
| `approval.diff.removed` | 削除 |
| `approval.diff.changed` | 変更 |
| `approval.resultsHeading` | チェックの結果 |
| `approval.passedCount` | OK {n} |
| `approval.failedCount` | 残り {n} |
| `approval.skipped` | まだ確かめていない {n} |
| `approval.failedHeading` | 直しきれなかった項目 |
| `approval.format` | 保存先の形 |
| `approval.stuck` | 2 回続けて NG |
| `approval.unable` | 判定できませんでした |
| `approval.sameFamily` | チェック項目は、ライターと同じ種類の AI が作りました |
| `approval.noJudgeModel` | 判定は、ライターと同じ種類の AI が読んで行いました |
| `approval.judgeModelPartial` | 一部の判定は、判定専用の AI につながらず、ライターと同じ種類の AI が読んで行いました |
| `approval.judgeModel` | 判定専用の AI が {units} か所をチェックしました |
| `approval.judgeModelUnsure` | {unsure} か所の判定が曖昧だったので、別の AI が再チェックしました |
| `approval.marksHeading` | 出典が見つからなかった文 |
| `approval.marksLead` | ライターが出典を示せなかった文です。【要確認】を付けて残すか、この文を削るかを選んでください。 |
| `approval.mark.印のまま` | 【要確認】を付けて残す |
| `approval.mark.削る` | この文を削る |
| `approval.okCut` | 削って直してもらう |
| `approval.sourcesHeading` | 出典 |
| `approval.sourcesLead` | 本文が示した出典を開いて、主張と照らしてチェックしました。 |
| `approval.source.支持` | 裏付けあり |
| `approval.source.一部支持` | 一部だけ裏付けあり |
| `approval.source.支持しない` | 裏付けなし |
| `approval.source.開けない` | 開けませんでした |
| `approval.source.未判定` | まだチェックしていません |
| `approval.sourceClaims` | 主張 {n} 件 |
| `approval.voiceHeading` | あなたの文体と比べました |
| `approval.voice.item` | 比べたこと |
| `approval.voice.you` | あなた |
| `approval.voice.draft` | この版 |
| `approval.voice.result` | 結果 |
| `approval.voice.endings` | 文末（{main}の割合） |
| `approval.voice.sentenceLength` | 一文の長さ（中ほどの値） |
| `approval.voice.firstPerson` | 一人称 |
| `approval.voice.chars` | {n} 字 |
| `approval.voice.readAlike` | 過去の文章との読み比べ |
| `approval.voice.readAlikeNote` | 並べて読み、同じ人が書いたように読めるか |
| `approval.voice.ok.true` | 合っています |
| `approval.voice.ok.false` | 違います |
| `approval.voice.ok.null` | まだです |
| `approval.sourceOpens` | 別のタブで開く |

**構成案の面（承認待ち kind=構成案。実装設計書 6.12 (3)）**

長い文書を確認しながら進めるとき、最初のバージョンの前に 1 回だけ出す面。見出しは承認の面と同じ（`approval.eyebrow` と、いまの 1 行の `outline`）。`outline.ok` は指示なしで、`outline.changeSend` は書いた指示を添えて、どちらも構成案を承認して下書きに進む（指示はライターに渡す）。中止は進行の面と同じ `progress.stop` の確認を出す。

| キー | 文 |
|---|---|
| `outline.lead` | 長い文書なので、書き始める前に構成案を作りました。見出しの順と、それぞれに書くことを確かめてください。 |
| `outline.heading` | 構成案 |
| `outline.ok` | この構成で書いてもらう |
| `outline.change` | 変えてほしいところを伝える |
| `outline.changeLabel` | どこをどう変えてほしいか書いてください（例: 2 つ目と 3 つ目を入れ替えて） |
| `outline.changeSend` | この内容を伝えて書いてもらう |
| `outline.changeCancel` | やめる |
| `outline.note` | 構成案の確認はこの依頼で 1 回だけです。次は書き上がった下書きを確認します。 |
| `outline.empty` | 構成案を読み込めませんでした。読み直してください |

**送付の面（画面 5。実装設計書 6.2.8 (6)）**

保存先の確認。ゲート③の型「何を・どこへ・誰に見えるか」で並べ、「はい」で答えられる形にする（設計書 6 章）。`deliver.visibility.*` は `DeliveryPlan.visibility` の値ごと。保存先の名前は `dest.*`。

| キー | 文 |
|---|---|
| `deliver.eyebrow` | あなたの番 |
| `deliver.what` | 何を |
| `deliver.where` | どこへ |
| `deliver.who` | 誰に見えるか |
| `deliver.visibility.あなただけ` | あなただけ |
| `deliver.visibility.ほかの人にも見える` | ほかの人にも見える |
| `deliver.checked` | 保存先の形のチェックは通りました |
| `deliver.send` | この内容で保存する |
| `deliver.decline` | 保存しないで戻る |
| `deliver.looksHeading` | 保存先ごとの見え方 |
| `deliver.pageNote` | 保存すると、バージョン付きの Web ページで開けます。ほかの人に見せるときは、HTML をダウンロードして渡せます。 |
| `deliver.pasteNote` | 保存すると、この文をコピーして note などに貼り付けられます。 |
| `deliver.gdocNote` | 保存すると、あなたの Google ドライブの「libretto」フォルダに「{title}（第 {n} 版）」という Google ドキュメントを作ります。フォルダが無ければ作ります。共有はしません。ほかの人に渡すときは、あなたがドライブで共有してください。 |
| `deliver.gsheetNote` | 保存すると、あなたの Google ドライブの「libretto」フォルダに「{title}（第 {n} 版）」という Google スプレッドシートを作ります。フォルダが無ければ作ります。共有はしません。ほかの人に渡すときは、あなたがドライブで共有してください。 |
| `deliver.gslideNote` | 保存すると、あなたの Google ドライブの「libretto」フォルダに「{title}（第 {n} 版）」という Google スライドを作ります。フォルダが無ければ作ります。共有はしません。ほかの人に渡すときは、あなたがドライブで共有してください。 |
| `deliver.fileNote` | 保存すると、このファイルをダウンロードできます。ほかの人に渡すときは、ダウンロードしたファイルを渡してください。 |
| `deliver.pasteFailed` | 貼り付け用の文を読み込めませんでした |
| `deliver.held.見える` | ほかの人にも見えるかもしれない保存先なので、自動では保存しませんでした。確かめてから保存してください |
| `deliver.held.引用` | ほかの人の言葉を引用しているので、自動では保存しませんでした。確かめてから保存してください |
| `deliver.undoHeading` | 取り消したいとき |
| `deliver.undo.page` | このページは libretto の画面の中だけで見られます。消さなくても、ほかの人には見えません |
| `deliver.undo.paste` | 貼り付け用の文は libretto の外には保存していません |
| `deliver.undo.gdoc` | 要らなければ、Google ドライブでこのファイルを削除してください |

**成果の面（完了。実装設計書 6.2.8 (7)）**

保存先ごとの受け取り口。`result.lead` の `{at}` は完了した日時。`result.copyFailed` はクリップボードが使えないときだけ出す。

| キー | 文 |
|---|---|
| `result.eyebrow` | 完了 |
| `result.heading` | 保存しました |
| `result.lead` | バージョン {n}・{at} |
| `result.openPage` | ページを開く |
| `result.receiveHeading` | 受け取る |
| `result.saved` | 保存済み |
| `result.download` | HTML をダウンロード |
| `result.downloadNote` | HTML をダウンロードして渡せます |
| `result.copy` | 本文をコピー |
| `result.copied` | コピーしました |
| `result.copyFailed` | コピーできませんでした。下の欄から選んでコピーしてください |
| `result.pagesHeading` | バージョンごとのページ |
| `result.pageOf` | バージョン {n} のページ |
| `result.openDoc` | Google ドキュメントを開く |
| `result.openSheet` | Google スプレッドシートを開く |
| `result.openSlides` | Google スライドを開く |
| `result.downloadFile` | ファイルをダウンロード |
| `result.leftover` | 中身を確かめられなかったファイルが Google ドライブに残っています。開いて、ごみ箱に移してください。 |
| `result.leftoverOpen` | バージョン {n} のファイルを開く |
| `result.addHeading` | 別の保存先にも保存する |
| `result.add` | {dest}にも保存する |

**完了した依頼（`/done`。実装設計書 6.2.8 (9)）**

| キー | 文 |
|---|---|
| `done.open` | 開く |
| `done.empty` | 完了した依頼はありません |

**設定の面（画面 7 の API キーの節。実装設計書 6.1.3 (6)・7.6 (10)）**

`entrance.fallback.*` は入口の面で、チェック項目を同じ種類の AI が作った理由（API キーが無い / つながらなかった）と次の一手。「OpenAI の API キー」は欄の名前としてオーナーが承認した語（対応表の「鍵・キー」の行）。

| キー | 文 |
|---|---|
| `settings.keysHeading` | API キー |
| `settings.openai.label` | OpenAI の API キー |
| `settings.openai.use` | チェック項目を、ライターとは別の種類の AI に作らせます。 |
| `settings.openai.unsetNote` | 未設定のあいだは、ライターと同じ種類の AI がチェック項目を作ります。 |
| `settings.openai.deleteBody` | 削除すると、チェック項目はライターと同じ種類の AI が作ります。 |
| `settings.jev.label` | Jev（TypeSafe）の API キー |
| `settings.jev.use` | 文章が条件を満たすかを、判定専用の AI にチェックさせます。 |
| `settings.jev.unsetNote` | 未設定のあいだは、ライターと同じ種類の AI が判定します。 |
| `settings.jev.deleteBody` | 削除すると、判定はライターと同じ種類の AI が行います。 |
| `settings.key.unset` | 未設定 |
| `settings.key.set` | 設定済み（末尾 {last4}） |
| `settings.key.savedAt` | {at} に保存 |
| `settings.key.input` | API キーを貼り付け |
| `settings.key.save` | 保存 |
| `settings.key.replace` | 入れ直す |
| `settings.key.cancel` | やめる |
| `settings.key.delete` | 削除 |
| `settings.key.deleteTitle` | API キーを削除しますか |
| `settings.key.saved` | 保存しました。次の依頼から使います。 |
| `settings.key.deleted` | 削除しました。 |
| `settings.key.invalid` | 8 文字以上の半角の英数字と記号で入れてください。空白は入れられません。 |
| `settings.key.failed` | 保存できませんでした。もう一度お試しください。 |
| `settings.voiceHeading` | あなたの文体の見本 |
| `settings.voice.use` | あなたが書いた文章のページを登録すると、依頼で「あなたの文体に合わせる」を選んだときに、ライターがその文体で書きます。 |
| `settings.voice.empty` | まだ登録していません。 |
| `settings.voice.title` | 題 |
| `settings.voice.url` | ページの URL |
| `settings.voice.add` | 登録 |
| `settings.voice.remove` | 外す |
| `settings.voice.removeLabel` | 「{title}」を外す |
| `settings.voice.max` | 登録できるのは 5 件までです。足すときは、どれかを外してください。 |
| `settings.voice.saved` | 保存しました。次の依頼から使います。 |
| `settings.voice.invalid` | 題と、http か https で始まる URL を入れてください。 |
| `settings.voice.failed` | 保存できませんでした。もう一度お試しください。 |
| `settings.envHeading` | 動作環境の確認 |
| `settings.env.missing` | 足りないものが {n} 件あります |
| `settings.env.ok` | 必要なものはそろっています |
| `settings.env.checkedAt` | {at} に確かめました |
| `settings.env.recheck` | もう一度確かめる |
| `settings.env.rechecking` | 確かめています。1〜2 分かかります |
| `settings.env.where` | コマンドは、libretto を動かしている PC のターミナルに貼り付けて Enter で実行します。パスワードを聞かれたら、PC にログインするときのパスワードを入れます。 |
| `settings.env.copy` | コピー |
| `settings.env.copied` | コピーしました |
| `settings.env.restart` | 入れたのに「入っていません」のままなら、libretto を起動し直してください。 |
| `settings.ai.label` | AI |
| `settings.ai.use` | ライターとチェックに使う AI です。libretto を動かしている PC に入れて、ログインしておきます。 |
| `settings.ai.ok` | 使えます |
| `settings.ai.missing` | 入っていません |
| `settings.ai.missingWhy` | AI が入っていないので、依頼が進みません。PC で次の 2 行を順に実行して入れてログインし、「もう一度確かめる」を押してください。 |
| `settings.ai.old` | バージョンが古いです |
| `settings.ai.oldWhy` | AI のバージョンが古いので、依頼が進みません。PC で次の 1 行を実行して新しくしてから、「もう一度確かめる」を押してください。 |
| `settings.ai.signedOut` | ログインが切れています |
| `settings.ai.signedOutWhy` | AI のログインが切れているので、依頼が止まっています。PC で次の 1 行を実行してログインし直してから、「もう一度確かめる」を押してください。止まっていた依頼は続きから進みます。 |
| `settings.isolation.label` | チェック項目をライターから隠す仕組み |
| `settings.isolation.use` | ライターには、チェック項目のファイルが見えない場所で下書きを書かせます。 |
| `settings.isolation.strong` | しっかり隠せています |
| `settings.isolation.weak` | 弱い |
| `settings.isolation.broken` | 動きません |
| `settings.isolation.why.windows` | Windows には OS の仕切りがありません。WSL2 で動かすと、しっかり隠せます。 |
| `settings.isolation.why.tools` | 必要なソフトが入っていません。PC で次の 1 行を実行してから「もう一度確かめる」を押すと、しっかり隠せます。 |
| `settings.isolation.why.userns` | OS の設定が仕切りを止めています。PC で次の 1 行を実行してから「もう一度確かめる」を押すと、しっかり隠せます。 |
| `settings.isolation.why.srt` | 仕切りの道具を起こせませんでした。「もう一度確かめる」を押してください。直らなければ libretto を起動し直してください。直るまで下書きは始まりません。 |
| `settings.isolation.why.network` | 仕切りの中から AI につながりませんでした。ネットワークを確かめてから「もう一度確かめる」を押してください。直るまで下書きは始まりません。 |
| `settings.probe.hidden` | ライターからチェック項目は見えませんでした |
| `settings.probe.visible` | ライターからチェック項目が見えました。「もう一度確かめる」を押してください。それでも見えるときは libretto を起動し直してください |
| `settings.probe.unknown` | チェックできませんでした。「もう一度確かめる」を押してください |
| `settings.probe.never` | まだ確認していません |
| `settings.probe.running` | 確認しています。1〜2 分かかります |
| `settings.probe.at` | {at} に確認 |
| `settings.probe.failed` | 確認を始められませんでした。もう一度お試しください。 |
| `settings.tools.label` | ファイルを作る道具 |
| `settings.tools.use` | PowerPoint・Excel・Word のファイルと Google スライドを作るとき、できあがりを画像にして見た目を確かめ、表の式を計算し直します。 |
| `settings.tools.ok` | 入っています |
| `settings.tools.missing` | 入っていません |
| `settings.tools.why` | LibreOffice と poppler が入っていないので、表とスライドの見た目を確かめられません。入れるまでは、PowerPoint・Excel・Word のファイルと Google スライドは保存先に出ません。PC で次の 1 行を実行してから「もう一度確かめる」を押してください。 |
| `settings.tools.windows` | LibreOffice と poppler が入っていないので、表とスライドの見た目を確かめられません。入れるまでは、PowerPoint・Excel・Word のファイルと Google スライドは保存先に出ません。Windows では libretto を WSL2 の中で動かし、WSL2 で次の 1 行を実行してください。 |
| `settings.tools.other` | LibreOffice と poppler が入っていないので、表とスライドの見た目を確かめられません。入れるまでは、PowerPoint・Excel・Word のファイルと Google スライドは保存先に出ません。この PC に LibreOffice と poppler を入れてから「もう一度確かめる」を押してください。 |
| `settings.envSlack.label` | Slack の権限 |
| `settings.envSlack.use` | Slack から取り込むときと、Slack に通知するときに使います。 |
| `settings.envSlack.ok` | そろっています |
| `settings.envSlack.missing` | 足りません |
| `settings.envSlack.scopes` | 権限 {scopes} が無いので、Slack から取り込めません。Slack アプリの設定画面の「OAuth & Permissions」で「User Token Scopes」に足し、アプリをワークスペースに入れ直してください。トークンが変わったら、「連携」の Slack の欄から貼り直してください。 |
| `settings.envSlack.bot` | 権限 chat:write が無いので、Slack に通知できません。Slack アプリの設定画面の「OAuth & Permissions」で「Bot Token Scopes」に足し、アプリをワークスペースに入れ直してください。トークンが変わったら、「お知らせ」の Slack の欄から貼り直してください。 |
| `settings.envSlack.open` | Slack アプリの設定画面を開く |
| `settings.envGoogle.label` | Google の API |
| `settings.envGoogle.use` | メールと会議メモの取り込みと、Google ドキュメントなどへの保存に使います。 |
| `settings.envGoogle.ok` | 有効です |
| `settings.envGoogle.missing` | 有効になっていません |
| `settings.envGoogle.gmail` | Gmail API が有効になっていないので、メールを取り込めません。 |
| `settings.envGoogle.drive` | Google Drive API が有効になっていないので、Google ドキュメント・スプレッドシート・スライドに保存できず、会議メモも読めません。 |
| `settings.envGoogle.how` | 開いたページで、連携に使っているプロジェクトを選んでから「有効にする」を押し、「もう一度確かめる」を押してください。反映に数分かかることがあります。 |
| `settings.envGoogle.openGmail` | Gmail API のページを開く |
| `settings.envGoogle.openDrive` | Google Drive API のページを開く |
| `settings.phone.label` | スマホから開く |
| `settings.phone.use` | 外出先のスマホで承認するときに使います。PC だけで使うなら要りません。 |
| `settings.phone.ok` | 設定済み |
| `settings.phone.unset` | 未設定 |
| `settings.phone.lead` | PC とスマホを Tailscale でつなぎ、Tailscale の HTTPS のアドレスで開きます。 |
| `settings.phone.step1` | PC とスマホに Tailscale を入れ、同じアカウントでログインします。WSL2 で動かしているときは、Windows の側に入れます。 |
| `settings.phone.step1Link` | Tailscale を入れる |
| `settings.phone.step2` | Tailscale の管理画面で「MagicDNS」と「HTTPS Certificates」を有効にします。 |
| `settings.phone.step2Link` | 管理画面を開く |
| `settings.phone.step3` | PC で次の 1 行を実行し、出た https:// で始まるアドレスを控えます（WSL2 なら Windows の PowerShell で）。 |
| `settings.phone.step4` | 控えたアドレスを足して、libretto を起動し直します。< > の中は手順 3 で出たアドレスに置き換えます。この手順だけは起動し直しが要ります。 |
| `settings.phone.step5` | 起動し直したら、「端末」の「別の端末を追加する」で出たアドレスをスマホで開きます。 |
| `settings.cmd.ai.install` | npm install -g @anthropic-ai/claude-code |
| `settings.cmd.ai.update` | claude update |
| `settings.cmd.ai.login` | claude auth login |
| `settings.cmd.tools.linux` | sudo apt install libreoffice poppler-utils |
| `settings.cmd.tools.darwin` | brew install --cask libreoffice && brew install poppler |
| `settings.cmd.isolation.tools` | sudo apt install bubblewrap socat ripgrep |
| `settings.cmd.isolation.userns` | sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0 |
| `settings.cmd.phone.serve` | tailscale serve --bg {port} |
| `settings.cmd.phone.start` | LIBRETTO_PORT={port} LIBRETTO_ORIGIN=http://127.0.0.1:{port},https://<PC の名前>.<tailnet の名前>.ts.net npm start |

**ホームの依頼の候補（ラベルを付けたメールと、リアクションを付けた Slack の投稿のカード。実装設計書 6.4 (7)・6.6 (7)）**

`cand.reason.*` は見送りの理由。ラベルとリアクションのカードでは「この人・この場所からは自動検出しなくてよい」を出さない（実装設計書 6.4 (5)）。`cand.othersPost` は他人の Slack の投稿のカードにだけ出す 1 行（設計書 10.3。画面では「材料」を「資料」と言う）。

| キー | 文 |
|---|---|
| `home.candHeading` | 依頼の候補 |
| `home.candRefresh` | 今すぐ取り込む |
| `home.candRefreshing` | 取り込んでいます |
| `home.candEmpty` | 依頼の候補はありません。メールにラベル libretto を、Slack の投稿にリアクション :memo: を付けると、ここに出ます。会議メモのあなたが担当の行動項目も、ここに出ます |
| `home.candLast` | {at} に取り込み |
| `home.lowFold` | ほかに {n} 件、依頼かどうかはっきりしないものがあります |
| `home.meetNotesLabel` | 読んだ会議メモ |
| `home.meetNote.none` | 「{title}」（{at}）: 行動項目はありませんでした |
| `home.meetNote.notMine` | 「{title}」（{at}）: あなたが担当の行動項目はありませんでした |
| `home.meetNote.unreadable` | 「{title}」（{at}）: 行動項目を見つけられませんでした。メモを開いて確かめてください |
| `cand.mark.gmail` | ラベル libretto |
| `cand.mark.slack` | リアクション :memo: |
| `cand.mark.meet.高` | 会議・高 |
| `cand.mark.meet.中` | 会議・中 |
| `cand.from` | {from}・{at} |
| `cand.meetFrom` | 担当: {from}・{at} |
| `cand.noAssignee` | 担当の記載なし |
| `cand.why` | 見つけた理由: {why} |
| `cand.askLabel` | 頼まれていそうなこと |
| `cand.make` | 作るもの: {doc}　保存先: {dest} |
| `cand.attach` | 添付「{names}」の中身は読んでいません。進めたあと、資料として貼り付けてください |
| `cand.aiNote` | プロンプトインジェクションの疑いがある文章が入っています。libretto はその文章を無視して作業します |
| `cand.open` | メールを開く |
| `cand.openSlack` | Slack で開く |
| `cand.openMeet` | メモを開く |
| `cand.othersPost` | {from}さんの投稿を資料にします。引用するときは {from}さんに一言伝えてください |
| `cand.proceed` | 進める |
| `cand.dismiss` | 見送る |
| `cand.dismissTitle` | この候補を見送りますか |
| `cand.dismissBody` | 理由を 1 つ選んでください。見送った候補は、もう出しません。 |
| `cand.reason.依頼ではない` | 依頼ではない |
| `cand.reason.自分の仕事ではない` | 自分の仕事ではない |
| `cand.reason.もう済んだ` | もう済んだ |
| `cand.reason.拾わなくてよい` | この人・この場所からは自動検出しなくてよい |
| `cand.cancel` | やめる |
| `cand.change` | 内容を修正 |
| `cand.changeClose` | 閉じる |
| `cand.talkHeading` | 内容を修正 |
| `cand.talkLabel` | 作るものや保存先、頼まれていることをどう変えたいか、ふだんの言葉で書いてください。 |
| `cand.talkPlaceholder` | 例: 会議で映すスライドにして。 |
| `cand.talkNote` | まとまったら候補の内容を書き直します。よければ「進める」を押してください。 |

**設定の面の連携（Google。実装設計書 6.4 (2)(7)）**

`settings.google.result.*` は連携の戻りの後に 1 回だけ出す 1 行。

| キー | 文 |
|---|---|
| `settings.linkHeading` | 連携 |
| `settings.google.label` | Google（Gmail・ドキュメント・会議メモ） |
| `settings.google.use` | メールの本文を読めます。添付は読みません。ラベルは付けません（送りません・消しません） |
| `settings.google.useDocs` | Google ドキュメントは、libretto が作ったものだけを作成・確認します。ほかのファイルは読みません。共有はしません。 |
| `settings.google.useMeet` | 会議メモは、Google Meet が作ったファイル（Gemini によるメモなど）を読める許可で読みます。libretto が読むのは「Gemini によるメモ」の行動項目の節だけです。 |
| `settings.google.docsMissing` | Google ドキュメントに保存するには、もう一度「連携する」を押して、ドライブの許可を足してください。 |
| `settings.google.meetMissing` | 会議メモの行動項目を取り込むには、もう一度「連携する」を押して、Google Meet のファイルの許可を足してください。 |
| `settings.google.signal` | 取り込みの目印はラベル {label} です。このラベルを付けたメールが依頼の候補に出ます。 |
| `settings.google.meetSignal` | 会議メモは、直近 14 日の「Gemini によるメモ」を見ます。あなたが担当の行動項目が依頼の候補に出ます。 |
| `settings.google.connected` | 連携済み |
| `settings.google.as` | {email} で連携しています |
| `settings.google.none` | 未連携 |
| `settings.google.expired` | 連携し直してください |
| `settings.google.expiredNote` | Google との連携が切れました。もう一度「連携する」を押してください。 |
| `settings.google.unconfigured` | 設定がありません |
| `settings.google.unconfiguredNote` | Google と連携するには、Google Cloud で作った OAuth クライアント（種類は「デスクトップ アプリ」）の JSON ファイルを選ぶか、ファイルの中身を貼り付けて保存してください。 |
| `settings.google.clientAt` | OAuth クライアントを {at} に保存しました |
| `settings.google.clientFile` | JSON ファイルを選ぶ |
| `settings.google.clientInput` | JSON ファイルの中身を貼り付け |
| `settings.google.clientReplaceNote` | 別の OAuth クライアントに入れ直すと、今の連携を解除します。 |
| `settings.google.clientSaved` | 保存しました。「連携する」を押してください。 |
| `settings.google.clientSavedKept` | 保存しました。 |
| `settings.google.clientSavedReset` | 保存しました。前の連携は解除しました。もう一度「連携する」を押してください。 |
| `settings.google.clientInvalid` | 読み取れませんでした。Google Cloud で種類を「デスクトップ アプリ」にして作った OAuth クライアントの JSON ファイルを選んでください。 |
| `settings.google.clientDeleteTitle` | Google の OAuth クライアントを削除しますか |
| `settings.google.clientDeleteBody` | Google との連携を解除し、メールの取り込みと Google ドキュメントへの保存を止めます。出ている依頼の候補はそのまま残ります。 |
| `settings.google.pcNote` | 連携は、libretto を動かしている PC のブラウザで行ってください。 |
| `settings.google.connect` | 連携する |
| `settings.google.disconnect` | 連携を解除 |
| `settings.google.disconnectTitle` | Google との連携を解除しますか |
| `settings.google.disconnectBody` | メールと会議メモの取り込みを止めます。出ている依頼の候補はそのまま残ります。 |
| `settings.google.cancel` | やめる |
| `settings.google.labelMissing` | Gmail にラベル {label} がありません。Gmail でラベルを作って、取り込みたいメールに付けてください。 |
| `settings.google.problem.rate_limited` | Gmail が混み合っていたので、取り込みを次の回に回しました。 |
| `settings.google.problem.api_disabled` | Gmail API が有効になっていません。Google Cloud のコンソールで、連携に使っているプロジェクトの「Gmail API」を有効にしてください。 |
| `settings.google.docsApiDisabled` | Google Drive API が有効になっていません。Google ドキュメントに保存するには、Google Cloud のコンソールで、連携に使っているプロジェクトの「Google Drive API」を有効にしてください。 |
| `settings.google.problem.network` | Gmail につながりませんでした。15 分後にもう一度見ます。 |
| `settings.google.meetProblem.rate_limited` | Google ドライブが混み合っていたので、会議メモの取り込みを次の回に回しました。 |
| `settings.google.meetProblem.network` | Google ドライブにつながりませんでした。会議メモは 15 分後にもう一度見ます。 |
| `settings.google.meetProblem.api_disabled` | Google Drive API が有効になっていないので、会議メモを読めません。Google Cloud のコンソールで、連携に使っているプロジェクトの「Google Drive API」を有効にしてください。 |
| `settings.google.lastAt` | {at} に取り込み |
| `settings.google.result.connected` | 連携しました。 |
| `settings.google.result.denied` | 連携をやめました。 |
| `settings.google.result.failed` | 連携できませんでした。もう一度お試しください。 |
| `settings.google.startFailed` | 連携を始められませんでした。もう一度お試しください。 |
| `settings.google.disconnectFailed` | 連携を解除できませんでした。もう一度お試しください。 |

**設定の面の連携（Slack。実装設計書 6.6 (2)(7)）**

Slack の行は API キーの行と同じ形（貼り付け・「入れ直す」・「削除」、保存後は「設定済み（末尾 1a2b）」。`settings.key.*` を使う）で、トークンは画面に二度と出さない（オーナー判断 2026-10-25）。下の文は Slack の行だけのもの。`settings.slack.missing` の {scopes} は足りない権限の名前（`reactions:read` など）をそのまま並べる。オーナーが Slack アプリの設定画面で探す名前なので、言い換えない。

| キー | 文 |
|---|---|
| `settings.slack.label` | Slack |
| `settings.slack.use` | あなたがリアクション :memo: を付けた投稿と、そのスレッドを読みます。自動検出では、あなた宛てのメンションと、選んだチャンネルの投稿も読みます。添付のファイルは読みません。投稿やリアクションはしません |
| `settings.slack.unsetNote` | Slack から取り込むには、Slack アプリを作り、その「User OAuth Token」（xoxp- で始まるもの）をここに貼り付けてください。 |
| `settings.slack.input` | トークンを貼り付け |
| `settings.slack.saved` | 保存しました。Slack からの取り込みを始めます。 |
| `settings.slack.invalid` | Slack アプリの「User OAuth Token」（xoxp- で始まるもの）を貼り付けてください。「Bot User OAuth Token」（xoxb- で始まるもの）では取り込めません。 |
| `settings.slack.deleteTitle` | Slack のトークンを削除しますか |
| `settings.slack.deleteBody` | Slack からの取り込みを止めます。出ている依頼の候補はそのまま残ります。 |
| `settings.slack.signal` | 取り込みの目印はリアクション :{emoji}: です。このリアクションを付けた投稿が依頼の候補に出ます。 |
| `settings.slack.as` | {team} の {user} で連携しています |
| `settings.slack.expiredNote` | Slack がこのトークンを受け付けませんでした（取り消されたか、期限が切れました）。Slack アプリの設定画面でアプリをワークスペースに入れ直し、出た「User OAuth Token」を「入れ直す」から貼り付けてください。 |
| `settings.slack.missing` | Slack アプリに権限 {scopes} がありません。Slack アプリの設定画面の「OAuth & Permissions」で「User Token Scopes」に足し、アプリをワークスペースに入れ直してください。トークンが変わったら「入れ直す」から貼り付けてください。 |
| `settings.slack.problem.rate_limited` | Slack が混み合っていたので、取り込みを次の回に回しました。 |
| `settings.slack.problem.network` | Slack につながりませんでした。15 分後にもう一度見ます。 |
| `settings.slack.lastAt` | {at} に取り込み |

**ホームと設定の自動検出（実装設計書 6.9）**

`cand.mark.inferred.*` は自動検出の候補のしるし（会議メモの担当が曖昧な候補も `低`）。`home.askSuppress` は推測の候補を同じ差出人・チャンネルから続けて 3 回「依頼ではない」で見送ったときに 1 回だけ出す（実装設計書 6.9 (7)）。`settings.infer.useJev` の Jev（TypeSafe）は API キーの欄と同じ名前で、送る範囲を書く（設計書 10.2）。

| キー | 文 |
|---|---|
| `cand.mark.inferred.高` | 自動検出・可能性 高 |
| `cand.mark.inferred.中` | 自動検出・可能性 中 |
| `cand.mark.inferred.低` | 自動検出・可能性 低 |
| `home.lowDismiss` | まとめて見送る |
| `home.lowDismissTitle` | まとめて見送りますか |
| `home.lowDismissBody` | 依頼かどうかはっきりしない {n} 件を、「依頼ではない」として見送ります。見送った候補は、もう出しません。 |
| `home.askSuppress` | {label} からの自動検出の候補を、続けて 3 回「依頼ではない」で見送りました。今後は自動検出から除外しますか |
| `home.askSuppressYes` | 除外する |
| `home.askSuppressNo` | 除外しない |
| `home.askSuppressDone` | {label} を自動検出から除外しました。設定の「自動検出」から戻せます。 |
| `settings.infer.heading` | 自動検出 |
| `settings.infer.use` | ラベルやリアクションが無くても、届いたメールと Slack の投稿から、文書づくりを頼まれていそうなものを見つけて依頼の候補に出します。本文は判断に使うだけで保存しません。依頼ではないと判断したものは、件名も差出人も残しません。 |
| `settings.infer.gmailDays` | メールを見る範囲 |
| `settings.infer.days` | 受信箱（メイン）の直近 {n} 日 |
| `settings.infer.slackChannels` | 見る Slack のチャンネル |
| `settings.infer.slackNote` | あなた宛てのメンションは、選ばなくても見ます（直近 7 日）。ダイレクトメッセージは見ません。 |
| `settings.infer.slackEmpty` | 選べるチャンネルがありません。 |
| `settings.infer.limit` | 1 日に判断する件数の上限 |
| `settings.infer.limitNote` | 0 にすると自動検出を止めます。 |
| `settings.infer.showLow` | 可能性が低い候補も出す |
| `settings.infer.useJev` | Jev（TypeSafe）にも件名と本文の先頭 600 字を送って、可能性を判断する |
| `settings.infer.save` | 保存 |
| `settings.infer.saved` | 保存しました。 |
| `settings.infer.invalid` | 保存できませんでした。上限は 0 から 1000 までの数で入れてください。 |
| `settings.infer.failed` | 保存できませんでした。もう一度お試しください。 |
| `settings.infer.today` | 今日判断した件数: {n} / {limit} 件 |
| `settings.infer.skipped` | 今日は {n} 件を見られませんでした。明日の取り込みで見ます。 |
| `settings.infer.recall` | ラベル・リアクションを付けた {total} 件のうち、自動検出が先に見つけていたのは {hit} 件（{pct}%）です（直近 30 日）。 |
| `settings.infer.recallNone` | 見落としの割合はまだありません。自動検出の範囲のメールや投稿にラベル・リアクションを付けると、ここに出ます。 |
| `settings.infer.excluded` | 除外した差出人・チャンネル |
| `settings.infer.excludedNone` | 除外したものはありません。 |
| `settings.modes.heading` | 進め方の初期設定 |
| `settings.modes.lead` | おまかせにした取り込み元では、ラベルやリアクションを付けたもの（会議メモはあなたの担当の項目）を、確認を求めずに自動で始めます。ほかの人に見える保存の前には確認します。おまかせに変える前に届いていた依頼の候補は、自動では始めません。 |
| `settings.modes.save` | 保存 |
| `settings.modes.saved` | 保存しました。 |
| `settings.modes.failed` | 保存できませんでした。もう一度お試しください。 |
| `settings.infer.restore` | 戻す |
| `settings.infer.restoreLabel` | {label} を戻す |
| `settings.infer.lastAt` | {at} に自動検出 |

**設定の面のお知らせ（実装設計書 6.8 (6)(7)）**

この端末の状態は 3 つ（`on`・`off`・`unavailable`）。`off` のときは「この端末に通知する」を出し、押したときだけブラウザの許可の画面を出す。ブラウザで拒んであれば `denied`、`http://` の Tailscale のアドレスなど通知を使えない開き方なら `insecure`、iPhone・iPad でホーム画面から開いていなければ `homescreen` を添える。画面を閉じたあとの通知に対応していないブラウザと、許可してもホストが登録を受け取れていない端末には `openOnly` を出す。前に送ったときに配信元へ届かなかった端末には `unreachable` を出す。出来事の名前は実装設計書 6.8 (1) の表の言葉。通知を止める時間帯（6.8 (14)）は、入れていれば `quietNow`、無ければ `quietNone` を出し、`quietOff` は入れているときだけ出す。

| キー | 文 |
|---|---|
| `settings.noticesHeading` | お知らせ |
| `settings.notices.use` | 依頼が確認待ちになったときや、依頼の候補が届いたときに、お知らせ欄に残し、この端末のブラウザにも通知します。 |
| `settings.notices.openOnly` | このブラウザでは、画面を開いているあいだだけ通知します |
| `settings.notices.device` | この端末 |
| `settings.notices.on` | この端末に通知します |
| `settings.notices.off` | 許可されていません |
| `settings.notices.unavailable` | この開き方では使えません |
| `settings.notices.enable` | この端末に通知する |
| `settings.notices.denied` | このブラウザでは libretto の通知が許可されていません。ブラウザのサイトの設定で通知を「許可」にしてから、もう一度押してください |
| `settings.notices.insecure` | この開き方では通知を使えません。https:// で始まるアドレス（Tailscale の HTTPS）で開き直してください |
| `settings.notices.homescreen` | iPhone では、ホーム画面に追加した libretto から開くと通知を受け取れます。Safari の共有ボタンから「ホーム画面に追加」を選び、追加したアイコンから開いてください |
| `settings.notices.unreachable` | 画面を閉じているときの通知を送れませんでした。libretto を動かしている PC がインターネットにつながっているか確かめてください。画面を開いているあいだの通知は出ます |
| `settings.notices.kinds` | 通知する出来事 |
| `settings.notices.kindsNote` | 切っても、お知らせ欄には残ります。 |
| `settings.notices.kind.your_turn` | 確認待ちになった |
| `settings.notices.kind.stopped` | 中止した |
| `settings.notices.kind.done` | 完了した |
| `settings.notices.kind.auto_started` | 自動で開始した |
| `settings.notices.kind.candidates` | 依頼の候補が届いた |
| `settings.notices.kind.started` | 下書きに取りかかった |
| `settings.notices.quiet` | 通知を止める時間帯 |
| `settings.notices.quietNote` | この時間帯は通知を出さず、明けたときに 1 通にまとめて知らせます。お知らせ欄にはその間も残ります。時刻は libretto を動かしている PC の時計で決まります。 |
| `settings.notices.quietNow` | {from}〜{to} は通知を止めます |
| `settings.notices.quietNone` | 通知を止める時間帯はありません |
| `settings.notices.quietFrom` | 始まり |
| `settings.notices.quietTo` | 終わり |
| `settings.notices.quietSave` | この時間帯で止める |
| `settings.notices.quietOff` | 止めない |
| `settings.notices.saved` | 保存しました。 |
| `settings.notices.failed` | 保存できませんでした。もう一度お試しください。 |

**設定の面のお知らせの Slack（実装設計書 6.8 (7)(8)(12)）**

お知らせの節の中の Slack の行。API キーの行と同じ形（貼り付け・「入れ直す」・「削除」、保存後は「設定済み（末尾 1a2b）」）で、トークンは画面に二度と出さない。保存すると Slack で確かめ、結果で `on`・`noUser`・`missingScope`・`rejected` のどれかを出す（Slack に届かなかったときは何も出さない）。`chat:write` は Slack アプリの設定画面で探す名前なので、言い換えない。

| キー | 文 |
|---|---|
| `settings.slackDm.label` | Slack |
| `settings.slackDm.use` | Slack の libretto アプリから、あなたにダイレクトメッセージで通知します。通知する出来事は下の選択と同じです。依頼の題が Slack に残ります |
| `settings.slackDm.unsetNote` | Slack に通知するには、Slack アプリにボットを足して出た Bot User OAuth Token（xoxb- で始まるもの）を貼ってください |
| `settings.slackDm.input` | Bot User OAuth Token を貼り付け |
| `settings.slackDm.saved` | 保存しました。 |
| `settings.slackDm.invalid` | Bot User OAuth Token（xoxb- で始まるもの）を貼ってください。User OAuth Token（xoxp-）は取り込みの欄に入れるものです |
| `settings.slackDm.deleteTitle` | Slack に通知するトークンを削除しますか |
| `settings.slackDm.deleteBody` | Slack への通知を止めます。お知らせ欄とこの端末の通知はそのままです。 |
| `settings.slackDm.on` | Slack に通知します |
| `settings.slackDm.noUser` | Slack で通知する相手が分かりません。上の連携の Slack の欄に User OAuth Token（xoxp- で始まるもの）を貼ってください。そのトークンのあなたに届きます |
| `settings.slackDm.missingScope` | Slack に通知を送る権限（chat:write）がありません。Slack アプリの設定でボットの権限に chat:write を足し、入れ直してから、出たトークンを貼り直してください |
| `settings.slackDm.rejected` | Slack がこのトークンを受け付けませんでした。Slack アプリを入れ直し、出た Bot User OAuth Token を貼り直してください |
| `settings.slackDm.openNote` | Slack の通知から libretto を開くには、その端末が Tailscale につながっている必要があります |

**設定の面の端末（実装設計書 6.12 (5)）**

この libretto を開ける端末（ペアリングしたブラウザ）の一覧と、別の端末の追加。この端末には `settings.devices.current` の印を付け、「外す」は出さない（自分を締め出さない）。追加用のアドレスは 10 分のあいだ 1 回だけ使え、期限を `settings.devices.expires` で添える。アドレスが `http://127.0.0.1` などこの PC の中だけのものなら `settings.devices.local` を添える。

| キー | 文 |
|---|---|
| `settings.devicesHeading` | 端末 |
| `settings.devices.use` | この libretto を開ける端末です。スマホなどほかの端末から開くには、ここで追加します。 |
| `settings.devices.current` | この端末 |
| `settings.devices.at` | {at} に追加 |
| `settings.devices.unnamed` | 名前のない端末 |
| `settings.devices.remove` | 外す |
| `settings.devices.removeLabel` | {label} を外す |
| `settings.devices.removeTitle` | この端末を外しますか |
| `settings.devices.removeBody` | 外した端末では libretto を開けなくなります。もう一度使うときは、ここから追加し直してください。 |
| `settings.devices.removeNo` | やめる |
| `settings.devices.add` | 別の端末を追加する |
| `settings.devices.nameLabel` | 追加する端末の名前（例: 私のスマホ） |
| `settings.devices.issue` | 追加用のアドレスを出す |
| `settings.devices.cancel` | やめる |
| `settings.devices.urlLead` | 追加する端末で、このアドレスを開いてください。1 回だけ使えます。 |
| `settings.devices.expires` | {at} まで使えます |
| `settings.devices.copy` | アドレスをコピー |
| `settings.devices.copied` | コピーしました |
| `settings.devices.local` | このアドレスは libretto を動かしている PC の中でしか開けません。スマホから開くには、PC で Tailscale の HTTPS を用意し、そのアドレスを libretto の起動の設定に足してください（requirements.md の「スマホから開く」）。 |
| `settings.devices.failed` | 出せませんでした。もう一度お試しください。 |
| `settings.devices.removeFailed` | 外せませんでした。もう一度お試しください。 |

**外から開いたときの帯（実装設計書 6.12 (6)）**

| キー | 文 |
|---|---|
| `band.origin` | このアドレスで開いた画面からは操作できません。libretto を動かしている PC で、このアドレスを起動の設定に足してください（requirements.md の「スマホから開く」） |
