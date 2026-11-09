// CSS 중괄호 균형 검사. 브랜치 병합 중 충돌을 풀다가 닫는 중괄호가 빠지면 이후 규칙이 조용히 무시되는데,
// 빌드는 실패하지 않아 발견이 늦다(#11·#12 병합에서 실제로 발생). CI에서 이를 막는다.
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
let failed = false
for (const file of files) {
  // 주석과 문자열 안의 중괄호는 세지 않는다
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
  let depth = 0
  let line = 1
  for (const ch of src) {
    if (ch === '\n') line++
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (depth < 0) {
      console.error(`${file}:${line} 여는 중괄호 없이 닫혔습니다`)
      failed = true
      break
    }
  }
  if (depth > 0) {
    console.error(`${file}: 닫히지 않은 중괄호 ${depth}개`)
    failed = true
  }
}
if (failed) process.exit(1)
console.log(`CSS 중괄호 검사 통과 (${files.length}개 파일)`)
