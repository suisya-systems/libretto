# libretto
Document-work agent loop (articles, idea notes, spreadsheets, slides) — design stage

## 何をするものか

Google Meetでの議事録や Slack、Gmail を監視してタスクが発生したとき、タスクを抽出したり自動的に初期対応を実施してくれるエージェントです。記事やアイディアノート、スプレッドシート、スライドを下書きし、作業を実施したエージェントとは別のエージェントがレビューしてからユーザーに引き渡してくれます。

### おまかせモード

- 特定のラベル・絵文字を付けたGmail、Slackの投稿、議事録で次のステップで名指しされたアクションは「おまかせ」をONにしておくと作業に自動的に取りかかります
- ユーザー以外に見える形での成果が必要なタスクでは必ずユーザーに最終確認を実施します

### タスク抽出

- 「もしかしたらユーザーのタスクかも？」というタスクを抽出する機能があります
- 抽出したタスクはユーザーがタスクを進める処理をする必要があります

### お知らせ機能

- タスク抽出やタスクの状況をSlackのDMで受け取ることができます

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
