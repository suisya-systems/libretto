// srt の偽物（docs/implementation.md 8.9）。argv と --settings の中身を FAKE_SRT_RECORD（無ければ設定の隣）に書き、-- の後ろを起こす
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const at = argv.indexOf('--')
const settingsFile = argv[argv.indexOf('--settings') + 1]
if (at < 0 || !settingsFile) process.exit(64)
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
const inner = argv.slice(at + 1)
const record = process.env.FAKE_SRT_RECORD ?? join(dirname(settings.filesystem.allowWrite[0]), 'srt-record.json')
writeFileSync(record, JSON.stringify({ argv, settings, env: process.env, inner }))
if (settings.fail) process.exit(1)
const [cmd, ...args] = inner
const child = spawn(cmd, args, { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 1))
