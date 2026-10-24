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
| 作れるものの点検・いま点検する | 動作環境の確認・今すぐ確認 | 設計書の内部の言葉。アプリの画面では普段そう言う |
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

**会話欄に足す 1 行（`SAY` の 8 個）**

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

**話し相手の代わりに会話欄に書く 1 行（`host/src/roles/conversation.ts` の `TALK`。実装設計書 6.2.1 (7)）**

`retry` と `retryWhy` は `failed` の行に付ける選択肢の文と、その 1 行。`moved` は案件の中の会話で直す内容がまとまったが、その間に依頼の状態が変わっていたときの 1 行（実装設計書 6.2.2 (8)）。

| キー | 文 |
|---|---|
| `failed` | 返事を作れませんでした |
| `costCap` | 費用の上限に達したので返事できません |
| `stopped` | 停止したので返事を止めました |
| `retry` | もう一度送る |
| `retryWhy` | 同じ内容で、もう一度返事を作ります |
| `moved` | 依頼の状態が変わったので、直す内容を受け付けられませんでした |

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
| `dest.file` | ファイル（{format}） |
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
| `entrance.gatherNote` | 進めると、libretto がこれをウェブで探します。 |
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
| `event.delivery.failed` | 保存できなかったので中止しました |
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

`approval.diff.*` は前のバージョンとの違いの 1 行の印。`approval.early.*` は 3 回目を待たずに本人に上げたときだけ、「直しきれなかった項目が N 件」の下に出す 1 行（なぜ今あなたの番なのか）。`approval.stuck` は 2 回続けて直らなかった項目に付ける印（実装設計書 6.2.7 (5)）。履歴の `event.review.fail` / `event.format.failed` は、行き先が承認待ちなら `.up`、停止なら `.stop` の文に替える。`approval.sameFamily` と `approval.noJudgeModel` / `approval.judgeModelPartial` は判定の結果の注記（`familyNote` / `jevNote` があるとき）。`approval.judgeModel` / `approval.judgeModelUnsure` は判定専用の AI が確かめた数（`ReviewSummary.jev`。実装設計書 7.6 (6)）。`approval.marks*` / `approval.mark.*` は【要確認】の付いた文ごとの選択で（キーの `印のまま` / `削る` は `approval.ok.marks` の値。画面の文はオーナー判断 2026-10-25 で改めた）、削るが 1 つでもあれば主ボタンが `approval.okCut` に替わる。`approval.sources*` / `approval.source.*` は出典ごとのチェックの結果（`SourceRow.verdict` の値ごと。実装設計書 6.3.1 (8)(11)）。

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
| `approval.sourceOpens` | 別のタブで開く |

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
| `deliver.pasteFailed` | 貼り付け用の文を読み込めませんでした |

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
| `settings.envHeading` | 動作環境の確認 |
| `settings.isolation.label` | チェック項目をライターから隠す仕組み |
| `settings.isolation.use` | ライターには、チェック項目のファイルが見えない場所で下書きを書かせます。 |
| `settings.isolation.strong` | しっかり隠せています |
| `settings.isolation.weak` | 弱い |
| `settings.isolation.broken` | 動きません |
| `settings.isolation.why.windows` | Windows には OS の仕切りがありません。WSL2 で動かすと、しっかり隠せます。 |
| `settings.isolation.why.tools` | 必要なソフトが入っていません。PC で `apt install bubblewrap socat ripgrep` を実行すると、しっかり隠せます。 |
| `settings.isolation.why.userns` | OS の設定が仕切りを止めています。PC で `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` を実行すると、しっかり隠せます。 |
| `settings.isolation.why.srt` | 仕切りの道具を起こせませんでした。libretto を再起動してください。直るまで下書きは始まりません。 |
| `settings.isolation.why.network` | 仕切りの中から AI につながりませんでした。libretto を再起動してください。直るまで下書きは始まりません。 |
| `settings.probe.hidden` | ライターからチェック項目は見えませんでした |
| `settings.probe.visible` | ライターからチェック項目が見えました。libretto を再起動して、もう一度確認してください |
| `settings.probe.unknown` | チェックできませんでした。もう一度「今すぐ確認」を押してください |
| `settings.probe.never` | まだ確認していません |
| `settings.probe.running` | 確認しています。1〜2 分かかります |
| `settings.probe.at` | {at} に確認 |
| `settings.probe.run` | 今すぐ確認 |
| `settings.probe.failed` | 確認を始められませんでした。もう一度お試しください。 |
