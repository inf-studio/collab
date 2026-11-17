// 校验 skills/*/SKILL.md 的 frontmatter（name/description 必填且非空），供 CI 使用。
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const root = "skills"
if (!existsSync(root)) {
  console.log("no skills/ directory — skip")
  process.exit(0)
}
let bad = 0
for (const dir of readdirSync(root)) {
  const file = join(root, dir, "SKILL.md")
  if (!existsSync(file)) continue
  const text = readFileSync(file, "utf8")
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (!fm) { console.error(`✗ ${file}: missing frontmatter`); bad++; continue }
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim()
  if (!name) { console.error(`✗ ${file}: missing name`); bad++ }
  if (!desc || desc.length < 20) { console.error(`✗ ${file}: description missing/too short`); bad++ }
  if (name && dir !== name) { console.error(`✗ ${file}: name "${name}" != directory "${dir}"`); bad++ }
  if (!bad) console.log(`✓ ${file} (${name})`)
}
if (bad) { console.error(`${bad} skill check(s) failed`); process.exit(1) }
console.log("skills ok")
