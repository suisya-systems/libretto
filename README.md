# libretto
Document-work agent loop (articles, idea notes, spreadsheets, slides) — design stage

[日本語](README.ja.md)

## What it does

libretto watches your Google Meet notes, Slack, and Gmail. When a task comes up, it picks the task out and can take a first pass at it on its own. It drafts articles, idea notes, spreadsheets, and slides, and a separate agent reviews each draft before it reaches you.

### Auto mode (おまかせ)

- With Auto mode on, libretto starts work by itself on Gmail messages and Slack posts marked with a specific label or emoji, and on action items that meeting notes assign to you by name as next steps.
- If a task produces something other people will see, libretto always asks you for a final check first.

### Task extraction

- libretto also picks out messages that might be a task for you.
- These extracted tasks wait until you choose to go ahead with them.

### Notifications

- You can get extracted tasks and task status updates as Slack DMs.

## How it differs from similar tools

Anthropic's [Claude Tag](https://claude.com/docs/claude-tag) and OpenAI's [dots](https://openai.com/index/introducing-dots/) also put an AI coworker in Slack and similar tools to take on work. In both, the work mostly runs in the vendor's cloud, and notes and work records are kept in the vendor's service.

### With libretto, you manage the workflow yourself

- The steps from receiving a request to sending out the result are public, so anyone can read them (the [transition table](docs/implementation.md)).
- Records of your approvals and of how each task progressed are kept on your machine with timestamps, and are never edited or deleted afterwards. Work that moved forward automatically in Auto mode is recorded as such.
- You choose Auto mode or Review mode (確認しながら) for each source, such as Gmail, Slack, or meeting notes, so you decide where libretto stops to ask you.
- The workflow and records live on your PC, and the model each role uses can be swapped out in a table (the [role-and-model table](host/src/model/roles.ts)).
- You can fork libretto and customize it for your own work, building on these records and mechanisms.

The descriptions of Claude Tag and dots are based on their official documentation as of 2026-10-26 ([Claude Tag docs](https://claude.com/docs/claude-tag), [Security and data](https://claude.com/docs/claude-tag/concepts/security-and-data.md), [Introducing dots](https://openai.com/index/introducing-dots/), [Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)).

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
