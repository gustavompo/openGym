// Import audit for the fork's wear-* modules.
//
// Why this exists: vitest's SSR transform turns a *missing* named export into `undefined` instead of
// a load-time error, so an import of something that was renamed or never added stays green until
// something asserts on its value (`docs/STATUS.md` section 6, the `isWarmupRow` lesson). This checks
// every `import { … } from './x'` in `src/lib/wear-*` against the export lists of its target.
//
// Run from the frontend root: node tools/import-audit.cjs
const fs = require('fs')
const path = require('path')

const dir = 'src/lib'
const files = fs.readdirSync(dir).filter(f => f.startsWith('wear-')).map(f => path.join(dir, f))

const imports = []
const importRe = new RegExp("import[ ]*\\{([^}]+)\\}[ ]*from[ ]*'([^']+)'", 'g')
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  let m
  while ((m = importRe.exec(src))) imports.push({ from: f, names: m[1], specifier: m[2] })
}

const ws = '[^A-Za-z0-9_$]'
let checked = 0
let bad = 0
for (const { from, names, specifier } of imports) {
  // Only relative specifiers resolve to files; `vitest` and `@capacitor/core` are packages.
  if (!specifier.startsWith('.')) continue
  const target = path.join(path.dirname(from), specifier)
  if (!fs.existsSync(target)) {
    console.log('MISSING FILE  ' + from + ' -> ' + target)
    bad++
    continue
  }
  const text = fs.readFileSync(target, 'utf8')
  for (const raw of names.split(',')) {
    const name = raw.trim().split(/[ \t]+as[ \t]+/)[0].trim()
    if (!name) continue
    checked++
    const decl = new RegExp('export' + ws + '+(?:async' + ws + '+)?(?:function|const|let|var|class)' + ws + '+' + name + ws)
    const list = new RegExp('export' + ws + '*\\{[^}]*' + ws + '+' + name + ws)
    if (!decl.test(text) && !list.test(text)) {
      console.log('MISSING EXPORT  ' + name + '  in ' + target + '  (imported by ' + from + ')')
      bad++
    }
  }
}

console.log(
  bad === 0
    ? 'AUDIT OK: ' + checked + ' named imports of wear-* modules resolve to exports'
    : 'AUDIT FAILED: ' + bad + ' unresolved of ' + checked,
)