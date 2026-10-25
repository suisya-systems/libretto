# libretto
Document-work agent loop (articles, idea notes, spreadsheets, slides) — design stage

## 何をするものか

議事録や Slack、Gmail で仕事が出てきたら、気が進まないものでも、ひとまず最初の版まで作っておいてくれるエージェントです。記事やアイディアノート、スプレッドシート、スライドを下書きし、別の目で見直してから渡します。

- 勝手に始めるのは、取り込み元を「おまかせ」にして、合図を付けたものだけです。合図には Gmail のラベルと Slack のリアクションを使います。会議メモでは、自分が担当の項目が合図になります。
- 中身から推測して拾った仕事は、候補として並べるだけです。「進める」を押すまで動きません。
- ほかの人に見える場所へ保存する前には、止まって確認を求めます。人の発言を引用したときも同じです。
- 最初はどの取り込み元も「確認しながら」です。候補は「進める」を押してから始まり、途中でも節目ごとに確認を求めます。

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
