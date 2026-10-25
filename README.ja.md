# libretto
[English](README.md)

## 何をするものか

Google Meetでの議事録や Slack、Gmail を監視してタスクが発生したとき、タスクを抽出したり自動的に初期対応を実施してくれるエージェントです。記事やアイディアノート、スプレッドシート、スライドを下書きし、作業を実施したエージェントとは別のエージェントがレビューしてからユーザーに引き渡してくれます。

### おまかせモード

- 特定のラベル・絵文字を付けたGmail、Slackの投稿、議事録で次のステップでユーザーが名指しされたアクションは「おまかせ」をONにしておくと作業に自動的に取りかかります
- ユーザー以外に見える形での成果が必要なタスクでは必ずユーザーに最終確認を実施します

### タスク抽出

- 「もしかしたらユーザーのタスクかも？」というタスクを抽出する機能があります
- 抽出したタスクはユーザーがタスクを進める処理をする必要があります

### お知らせ機能

- タスク抽出やタスクの状況をSlackのDMで受け取ることができます

## 似たものとの違い

Slack などに AI の同僚を置いて仕事を任せる製品に、Anthropic の [Claude Tag](https://claude.com/docs/claude-tag) と OpenAI の [dots](https://openai.com/index/introducing-dots/) があります。どちらも作業は基本的にベンダーのクラウドで動き、覚え書きや作業の記録もベンダーのサービスに残ります。

### Librettoはワークフローを自分で管理できる

- 依頼が届いてから送り出すまでの段取りは公開されていて、誰でも読めます（[遷移表](docs/implementation.md)）
- 承認の記録と作業の進み方の記録は日時付きで手元に残り、あとから書き換えも削除もされません。おまかせで自動に進んだものも、そうと分かる形で残ります
- Gmail・Slack・議事録などの取り込み元ごとに「おまかせ」か「確認しながら」を選べるので、どこで手を止めてユーザーに確認するかを自分で決められます
- 段取りと記録はユーザーの PC に置かれ、役割ごとに使うモデルは表で差し替えられる作りです（[役割とモデルの表](host/src/model/roles.ts)）
- これらの記録や仕組みを元にフォークして自分たちの業務に最適化したカスタマイズを自身で行うことが可能です

Claude Tag と dots の記述は、2026-10-26 時点の公式の説明（[Claude Tag のドキュメント](https://claude.com/docs/claude-tag)・[セキュリティとデータの扱い](https://claude.com/docs/claude-tag/concepts/security-and-data.md)、[Introducing dots](https://openai.com/index/introducing-dots/)・[dots のヘルプ](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)）によります。

## Development

```
npm ci --ignore-scripts
npm run verify   # typecheck + Biome + vitest
```

Run the built page (one origin, `http://127.0.0.1:7780`):

```
npm run build
npm start        # open the pairing URL it prints
```

Work on the page with Vite (docs/implementation.md 5.8 (2)). Use `127.0.0.1`, never `localhost`:

```
npm run dev:host # terminal 1: host allows the Vite origin and prints a pairing URL on it
npm run dev      # terminal 2: http://127.0.0.1:5173
```

Open the pairing URL from terminal 1 (`http://127.0.0.1:5173/pair/...`) and press the button on that page once, then use `http://127.0.0.1:5173`.

## License

MIT
