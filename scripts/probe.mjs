// Phase 1 exit probe against the deployed Worker.
//
//   node scripts/probe.mjs            probe https://usage.minititine.cc (or $USAGE_BASE_URL)
//
// Reads USAGE_ADMIN_API_KEY from .dev.vars and never prints it. Activates the throwaway story
// `probe-check` v1, registers a throwaway subject, uploads, deletes, verifies the erasure through
// the admin API, then removes the probe's footprint (story row and tombstone) from the remote D1
// with `wrangler d1 execute --remote` so the public catalogue stays clean.
import { spawnSync } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const base = (process.env.USAGE_BASE_URL ?? "https://usage.minititine.cc").replace(/\/$/, "")
const STORY_ID = "probe-check"

const adminKey = readFileSync(join(root, ".dev.vars"), "utf8").match(/^USAGE_ADMIN_API_KEY=(.+)$/m)?.[1]?.trim()
if (!adminKey) {
  console.error("USAGE_ADMIN_API_KEY is missing from .dev.vars.")
  process.exit(2)
}

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex")
const utcDay = (offset) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - offset * 86_400_000)
    .toISOString().slice(0, 10)
}

let failures = 0
function check(label, condition, detail) {
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${detail === undefined ? "" : ` -> ${detail}`}`)
  if (!condition) failures++
  return condition
}

async function request(method, path, { body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers["Content-Type"] = "application/json"
  if (token) headers.Authorization = `Bearer ${token}`
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: response.status, json }
}
const admin = (method, path, body) => request(method, path, { body, token: adminKey })

function wranglerRemote(sql) {
  const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js")
  const result = spawnSync(process.execPath, [wrangler, "d1", "execute", "leaf-usage", "--remote", "--json", "--command", sql], {
    cwd: root,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`wrangler d1 execute failed: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout)
}

const story = {
  schemaVersion: 1,
  storyId: STORY_ID,
  version: 1,
  status: "active",
  question: "Phase 1 exit probe. Not a real question.",
  shares: "Nothing; this story is removed right after the probe.",
  period: "day",
  backfillDays: 0,
  dimensions: [{ key: "outcome", values: ["ok", "other"] }],
  measures: [{ key: "checks", type: "count", max: 10 }],
  clientObservations: [],
  introducedIn: "0.0.0",
}
const subjectId = randomUUID()
const secret = randomBytes(32).toString("base64url")
const tombstone = sha256(subjectId)
const snapshot = {
  schemaVersion: 1,
  snapshotId: randomUUID(),
  storyId: STORY_ID,
  storyVersion: 1,
  period: utcDay(1),
  rows: [{ dims: { outcome: "ok" }, checks: 1 }],
}

console.log(`Probing ${base} with subject ${subjectId}, period ${snapshot.period}`)

const activated = await admin("PUT", `/v1/admin/stories/${STORY_ID}/1`, story)
check("activate probe-check v1", activated.status === 201 || activated.status === 200, `${activated.status} ${activated.json.result ?? activated.json.error}`)

const registered = await request("POST", "/v1/subjects", { body: { subjectId, secretHash: sha256(secret), mode: "anonymous" } })
check("register throwaway subject", registered.status === 201, registered.status)

const upload = () => request("POST", "/v1/snapshots", { body: { subjectId, snapshots: [snapshot] }, token: secret })
const first = await upload()
check("upload yesterday's snapshot", first.json.results?.[0]?.status === "accepted", first.json.results?.[0]?.status ?? first.status)
const retry = await upload()
check("re-upload is a duplicate", retry.json.results?.[0]?.status === "duplicate", retry.json.results?.[0]?.status ?? retry.status)

const before = await admin("GET", `/v1/admin/snapshots?storyId=${STORY_ID}&subject=${subjectId}`)
check("admin API sees the snapshot", before.json.snapshots?.length === 1, before.json.snapshots?.length)

const erased = await request("DELETE", `/v1/subjects/${subjectId}`, { token: secret })
const receipt = erased.json
check("delete returns an erasure receipt", erased.status === 200 && receipt.status === "erased" && receipt.subjectId === subjectId
  && receipt.snapshotsDeleted === 1 && receipt.tombstone === tombstone && typeof receipt.erasedAt === "string",
JSON.stringify(receipt))

const subjects = await admin("GET", "/v1/admin/subjects")
check("admin API no longer lists the subject", subjects.status === 200 && !subjects.json.subjects.some((row) => row.subjectId === subjectId),
  `${subjects.json.subjects?.length} subject(s) listed`)
const after = await admin("GET", `/v1/admin/snapshots?storyId=${STORY_ID}`)
check("admin API returns no probe snapshots", after.status === 200 && after.json.snapshots.length === 0, after.json.snapshots?.length)

const again = await request("POST", "/v1/subjects", { body: { subjectId, secretHash: sha256(secret), mode: "anonymous" } })
check("re-registration is refused", again.status === 410 && again.json.error === "subject_erased", `${again.status} ${again.json.error}`)

const cleanup = [
  `DELETE FROM snapshots WHERE story_id = '${STORY_ID}' OR subject_id = '${subjectId}'`,
  `DELETE FROM subjects WHERE subject_id = '${subjectId}'`,
  `DELETE FROM story_totals WHERE story_id = '${STORY_ID}'`,
  `DELETE FROM stories WHERE story_id = '${STORY_ID}'`,
  `DELETE FROM tombstones WHERE subject_hash = '${tombstone}'`,
].join("; ")

if (failures > 0) {
  console.log(`\n${failures} check(s) failed. Probe data left in place for inspection. To remove it:`)
  console.log(`npx wrangler d1 execute leaf-usage --remote --command "${cleanup}"`)
  process.exit(1)
}

console.log("\nRemoving the probe footprint with wrangler d1 execute --remote")
wranglerRemote(cleanup)
const [remaining] = wranglerRemote(`
  SELECT
    (SELECT COUNT(*) FROM stories WHERE story_id = '${STORY_ID}') AS probe_stories,
    (SELECT COUNT(*) FROM tombstones WHERE subject_hash = '${tombstone}') AS probe_tombstones,
    (SELECT COUNT(*) FROM subjects WHERE subject_id = '${subjectId}') AS probe_subjects,
    (SELECT COUNT(*) FROM snapshots WHERE story_id = '${STORY_ID}') AS probe_snapshots
`).map((result) => result.results[0])
check("probe rows removed from D1", Object.values(remaining).every((count) => count === 0), JSON.stringify(remaining))

const catalogue = await request("GET", "/v1/catalogue")
console.log(`GET /v1/catalogue -> ${catalogue.status} ${JSON.stringify(catalogue.json)}`)
check("public catalogue holds no probe story", catalogue.status === 200 && !catalogue.json.stories.some((entry) => entry.storyId === STORY_ID))

process.exit(failures > 0 ? 1 : 0)
