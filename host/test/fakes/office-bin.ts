// 偽の soffice と pdftoppm を一時フォルダに置く（中身は office.ts）。返すのは Tools の形
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function fakeOffice(): { soffice: string; pdftoppm: string } {
  const bin = mkdtempSync(join(tmpdir(), 'libretto-office-'))
  const script = fileURLToPath(new URL('./office.ts', import.meta.url))
  const make = (name: string) => {
    const p = join(bin, name)
    writeFileSync(
      p,
      `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${script}" ${name} "$@"\n`,
    )
    chmodSync(p, 0o755)
    return p
  }
  return { soffice: make('soffice'), pdftoppm: make('pdftoppm') }
}
