// 開発の起点は http://127.0.0.1:5173 の 1 つ（docs/implementation.md 5.8 (2)）。Origin と Cookie は書き換えずにホストへ中継する
import { defineConfig } from 'vite'

const host = 'http://127.0.0.1:7780'

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 版のあるページはホストが配信する（6.2.8 (4)）。/cases/:id の画面の経路は中継しない
    proxy: { '/api': host, '/pair': host, '^/cases/[^/]+/page(?:[?#]|$)': host },
  },
})
