# libretto
Document-work agent loop (articles, idea notes, spreadsheets, slides) — design stage

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

Open the pairing URL from terminal 1 (`http://127.0.0.1:5173/pair/...`) once, then use `http://127.0.0.1:5173`.

## License

MIT
