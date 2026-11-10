// e2e/NN-*.mjs 시나리오를 순서대로 실행한다. 인자로 파일 이름 일부를 주면 그것만 실행한다 (예: npm run e2e -- 05)
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

const filter = process.argv[2] ?? ''
const files = readdirSync(import.meta.dirname)
  .filter((f) => /^\d+-.*\.mjs$/.test(f) && f.includes(filter))
  .sort()
let failed = 0
for (const f of files) {
  console.log(`\n=== ${f}`)
  const r = spawnSync(process.execPath, [`${import.meta.dirname}/${f}`], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}
process.exitCode = failed === 0 ? 0 : 1
