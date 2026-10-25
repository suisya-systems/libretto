# libretto
Document-work agent loop (articles, idea notes, spreadsheets, slides) — design stage

## 何をするものか

議事録や Slack・Gmail で仕事が発生したとき、気が進むかどうかにかかわらず、とりあえず最初の版まで手を付けておいてくれるエージェントです。記事・アイディアノート・スプレッドシート・スライドを下書きし、別の目で検品してから、あなたに渡します。画面の会話欄から直接頼むこともできます。

- Gmail・Slack・会議メモを見て、頼まれていそうなことを依頼の候補として並べます。
- 取り込み元を「おまかせ」にすると、合図の付いた候補（Gmail のラベル、Slack のリアクション、会議メモのうちあなたの担当と読み取れた項目）は、確認を求めずに自動で始まり、下書きと検品まで進みます。おまかせに変える前に届いていた候補は自動では始めません。
- 内容から推測して拾っただけの候補は、おまかせでも並べるだけです。あなたが「進める」を押すまで動きません。
- ほかの人にも見える保存先への保存や、ほかの人の言葉を引用した成果物は、おまかせでも保存の前に止まり、あなたの確認を待ちます。あなただけに見える保存先へは、そのまま保存します。
- 自動で始まった依頼はホームの一覧に出て、保存に入る前なら取り消せます。
- 既定はどの取り込み元も「確認しながら」です。このときは候補が並ぶだけで、あなたが「進める」を押してから始まり、途中の要所でも承認を待ちます。

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
