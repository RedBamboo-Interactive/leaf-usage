// Copies RedLeaf's generated Usage Insights schemas (schemas/usage/v1/*.json) into ./schemas.
//
//   node scripts/sync-schemas.mjs            copy from ../redleaf (or $REDLEAF_DIR)
//   node scripts/sync-schemas.mjs --check    exit 1 when ./schemas differs from the source
//   node scripts/sync-schemas.mjs <redleaf>  copy from another checkout
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const check = args.includes("--check")
const redleaf = resolve(args.find((arg) => !arg.startsWith("--")) ?? process.env.REDLEAF_DIR ?? join(root, "..", "redleaf"))
const source = join(redleaf, "schemas", "usage", "v1")
const target = join(root, "schemas")

if (!existsSync(source)) {
  console.error(`No RedLeaf usage schemas at ${source}. Generate them in the redleaf checkout first.`)
  process.exit(2)
}

const jsonFiles = (directory) => existsSync(directory)
  ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
  : []

const wanted = jsonFiles(source)
if (wanted.length === 0) {
  console.error(`${source} contains no .json files.`)
  process.exit(2)
}

const drift = []
for (const name of wanted) {
  const content = readFileSync(join(source, name))
  const destination = join(target, name)
  if (!existsSync(destination) || !readFileSync(destination).equals(content)) drift.push(`changed: ${name}`)
}
for (const name of jsonFiles(target)) {
  if (!wanted.includes(name)) drift.push(`stale: ${name}`)
}

if (check) {
  if (drift.length > 0) {
    console.error(`schemas/ differs from ${source}:\n  ${drift.join("\n  ")}\nRun npm run sync-schemas.`)
    process.exit(1)
  }
  console.log(`schemas/ matches ${source} (${wanted.length} files).`)
  process.exit(0)
}

mkdirSync(target, { recursive: true })
for (const name of jsonFiles(target)) {
  if (!wanted.includes(name)) rmSync(join(target, name))
}
for (const name of wanted) writeFileSync(join(target, name), readFileSync(join(source, name)))
console.log(`Copied ${wanted.length} schema file(s) from ${source}.${drift.length ? `\n  ${drift.join("\n  ")}` : " No changes."}`)
