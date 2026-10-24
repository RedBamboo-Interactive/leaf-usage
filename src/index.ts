import {
  canonicalStoryJson,
  isStoryId,
  isUuid,
  parseUtcDay,
  publishedStory,
  validateBatch,
  validateRegistration,
  validateSnapshot,
  validateSnapshotEnvelope,
  validateStoryDefinition,
  validateSubjectUpdate,
  MAX_STORY_VERSION,
  type StoryDefinition,
} from "./contracts.js"
import { runRetention } from "./retention.js"
import {
  eraseSubject,
  parseDefinition,
  secureEquals,
  sha256Hex,
  tombstoneFor,
  type Env,
  type RateLimiterBinding,
  type StoryRow,
  type SubjectRow,
} from "./store.js"

const MAX_BODY_BYTES = 64 * 1024
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" }
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
}
const ADMIN_SNAPSHOT_LIMIT = 5000
const ADMIN_SUBJECT_LIMIT = 1000

type ItemStatus = "accepted" | "duplicate" | "story_inactive" | "invalid"

interface ItemResult {
  index: number
  snapshotId: string | null
  status: ItemStatus
  message?: string
}

function json(body: unknown, status = 200, cors = false): Response {
  return Response.json(body, {
    status,
    headers: {
      ...JSON_HEADERS,
      ...(cors ? CORS_HEADERS : {}),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

function error(code: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, message, ...extra }, status)
}

class BodyError extends Error {}

async function bodyJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (length > MAX_BODY_BYTES) throw new BodyError("body_too_large")
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) throw new BodyError("body_too_large")
  try {
    return JSON.parse(raw)
  } catch {
    throw new BodyError("invalid_json")
  }
}

async function readBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await bodyJson(request) }
  } catch (caught) {
    if (!(caught instanceof BodyError)) throw caught
    return caught.message === "body_too_large"
      ? { ok: false, response: error("body_too_large", "The request body exceeds 64 KB.", 413) }
      : { ok: false, response: error("invalid_json", "The request body is not valid JSON.", 400) }
  }
}

/** The client address is only ever used as a rate-limit key; it is never stored or logged. */
async function rateLimited(request: Request, limiter: RateLimiterBinding): Promise<boolean> {
  const hostname = new URL(request.url).hostname
  if (hostname === "127.0.0.1" || hostname === "localhost") return false
  const key = request.headers.get("cf-connecting-ip") || "unknown"
  const result = await limiter.limit({ key })
  return !result.success
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  const token = header.slice(7)
  return token.length >= 16 && token.length <= 512 ? token : null
}

type SubjectAuth = { ok: true; subject: SubjectRow } | { ok: false; response: Response }

/**
 * Subject bearer auth: the bearer is the subject secret; its SHA-256 is compared in constant time
 * with the hash stored at registration.
 */
async function authenticateSubject(request: Request, env: Env, subjectId: string): Promise<SubjectAuth> {
  const token = bearer(request)
  if (!token) return { ok: false, response: error("unauthorized", "A subject bearer token is required.", 401) }

  const subject = await env.USAGE_DB.prepare("SELECT * FROM subjects WHERE subject_id = ?")
    .bind(subjectId).first<SubjectRow>()
  const presented = await sha256Hex(token)
  if (!subject) {
    // Still spend the comparison so a missing subject costs the same as a wrong secret.
    await secureEquals(presented, "0".repeat(64))
    const tombstone = await tombstoneFor(env, subjectId)
    if (tombstone) {
      return { ok: false, response: error("subject_erased", "This subject has been erased.", 410, { erasedAt: tombstone.erased_at }) }
    }
    return { ok: false, response: error("subject_not_found", "This subject is not registered.", 404) }
  }
  if (!await secureEquals(presented, subject.secret_hash)) {
    return { ok: false, response: error("unauthorized", "The subject secret is not valid.", 401) }
  }
  return { ok: true, subject }
}

function publicSubject(row: SubjectRow) {
  return {
    subjectId: row.subject_id,
    mode: row.mode,
    label: row.label,
    createdAt: row.created_at,
    lastUploadAt: row.last_upload_at,
  }
}

function catalogueEntry(row: StoryRow) {
  return {
    storyId: row.story_id,
    version: row.version,
    status: row.status,
    activatedAt: row.activated_at,
    deprecatedAt: row.deprecated_at,
    definition: publishedStory(parseDefinition(row), row.status),
  }
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

async function catalogue(env: Env): Promise<Response> {
  const rows = await env.USAGE_DB.prepare("SELECT * FROM stories ORDER BY story_id, version").all<StoryRow>()
  return json({ stories: rows.results.map(catalogueEntry) }, 200, true)
}

async function registerSubject(request: Request, env: Env): Promise<Response> {
  if (await rateLimited(request, env.REGISTER_RATE_LIMITER)) {
    return error("rate_limited", "Too many registrations. Please try again shortly.", 429)
  }
  const body = await readBody(request)
  if (!body.ok) return body.response
  const validation = validateRegistration(body.value)
  if (!validation.ok) return error("invalid_registration", validation.message, 400)
  const registration = validation.value

  const tombstone = await tombstoneFor(env, registration.subjectId)
  if (tombstone) {
    return error("subject_erased", "This subject has been erased and cannot be registered again.", 410, { erasedAt: tombstone.erased_at })
  }

  const createdAt = new Date().toISOString()
  const inserted = await env.USAGE_DB.prepare(`
    INSERT INTO subjects (subject_id, secret_hash, mode, label, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (subject_id) DO NOTHING
  `).bind(registration.subjectId, registration.secretHash, registration.mode, registration.label, createdAt).run()

  const row = await env.USAGE_DB.prepare("SELECT * FROM subjects WHERE subject_id = ?")
    .bind(registration.subjectId).first<SubjectRow>()
  if (!row) throw new Error("subject registration was not persisted")
  if ((inserted.meta.changes ?? 0) === 1) return json(publicSubject(row), 201)

  // A retry of the same registration is idempotent; anything else is a conflict.
  if (await secureEquals(row.secret_hash, registration.secretHash) && row.mode === registration.mode && row.label === registration.label) {
    return json(publicSubject(row), 200)
  }
  return error("subject_exists", "This subject is already registered.", 409)
}

async function updateSubject(request: Request, env: Env, subjectId: string): Promise<Response> {
  const auth = await authenticateSubject(request, env, subjectId)
  if (!auth.ok) return auth.response
  const body = await readBody(request)
  if (!body.ok) return body.response
  const validation = validateSubjectUpdate(body.value)
  if (!validation.ok) return error("invalid_update", validation.message, 400)

  await env.USAGE_DB.prepare("UPDATE subjects SET mode = ?, label = ? WHERE subject_id = ?")
    .bind(validation.value.mode, validation.value.label, subjectId).run()
  return json(publicSubject({ ...auth.subject, ...validation.value }))
}

async function deleteSubject(request: Request, env: Env, subjectId: string): Promise<Response> {
  const auth = await authenticateSubject(request, env, subjectId)
  if (!auth.ok) return auth.response
  return json(await eraseSubject(env, subjectId, new Date()))
}

async function uploadSnapshots(request: Request, env: Env): Promise<Response> {
  if (await rateLimited(request, env.UPLOAD_RATE_LIMITER)) {
    return error("rate_limited", "Too many uploads. Please try again shortly.", 429)
  }
  const body = await readBody(request)
  if (!body.ok) return body.response
  const batch = validateBatch(body.value)
  if (!batch.ok) return error("invalid_batch", batch.message, 400)
  const auth = await authenticateSubject(request, env, batch.value.subjectId)
  if (!auth.ok) return auth.response

  const now = new Date()
  const receivedAt = now.toISOString()
  const stories = new Map<string, StoryDefinition | null>()
  const results: ItemResult[] = []
  const pending: { result: ItemResult; storyId: string; version: number; period: string; rowsJson: string }[] = []

  for (const [index, item] of batch.value.snapshots.entries()) {
    const envelope = validateSnapshotEnvelope(item)
    if (!envelope.ok) {
      const id = typeof item === "object" && item !== null && isUuid((item as Record<string, unknown>).snapshotId)
        ? String((item as Record<string, unknown>).snapshotId).toLowerCase()
        : null
      results.push({ index, snapshotId: id, status: "invalid", message: envelope.message })
      continue
    }
    const { storyId, storyVersion, snapshotId } = envelope.value

    const storyKey = `${storyId}@${storyVersion}`
    if (!stories.has(storyKey)) {
      const row = await env.USAGE_DB.prepare(
        "SELECT * FROM stories WHERE story_id = ? AND version = ? AND status = 'active'",
      ).bind(storyId, storyVersion).first<StoryRow>()
      stories.set(storyKey, row ? parseDefinition(row) : null)
    }
    const story = stories.get(storyKey)
    if (!story) {
      results.push({ index, snapshotId, status: "story_inactive" })
      continue
    }

    const validation = validateSnapshot(item, story, now)
    if (!validation.ok) {
      results.push({ index, snapshotId, status: "invalid", message: validation.message })
      continue
    }
    const result: ItemResult = { index, snapshotId, status: "accepted" }
    results.push(result)
    pending.push({ result, storyId, version: storyVersion, period: validation.value.period, rowsJson: JSON.stringify(validation.value.rows) })
  }

  if (pending.length > 0) {
    const subjectId = auth.subject.subject_id
    const inserts = await env.USAGE_DB.batch(pending.map((item) => env.USAGE_DB.prepare(`
      INSERT INTO snapshots (subject_id, story_id, story_version, period, rows_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (subject_id, story_id, story_version, period) DO NOTHING
    `).bind(subjectId, item.storyId, item.version, item.period, item.rowsJson, receivedAt)))

    let accepted = 0
    for (const [position, item] of pending.entries()) {
      if ((inserts[position].meta.changes ?? 0) === 1) {
        accepted++
        continue
      }
      // First write wins. An identical retry is a duplicate; a different payload for the same day is refused.
      const stored = await env.USAGE_DB.prepare(`
        SELECT rows_json FROM snapshots
        WHERE subject_id = ? AND story_id = ? AND story_version = ? AND period = ?
      `).bind(subjectId, item.storyId, item.version, item.period).first<{ rows_json: string }>()
      if (stored?.rows_json === item.rowsJson) {
        item.result.status = "duplicate"
      } else {
        item.result.status = "invalid"
        item.result.message = "A different snapshot for this story version and period was already accepted."
      }
    }
    if (accepted > 0) {
      await env.USAGE_DB.prepare("UPDATE subjects SET last_upload_at = ? WHERE subject_id = ?")
        .bind(receivedAt, subjectId).run()
    }
  }

  return json({ results })
}

// ---------------------------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------------------------

async function adminAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ") || !env.USAGE_ADMIN_API_KEY) return false
  return secureEquals(header.slice(7), env.USAGE_ADMIN_API_KEY)
}

function storyPath(id: string, version: string): { storyId: string; version: number } | null {
  const number = Number(version)
  if (!isStoryId(id) || !/^[1-9]\d*$/.test(version) || number > MAX_STORY_VERSION) return null
  return { storyId: id, version: number }
}

async function activateStory(request: Request, env: Env, storyId: string, version: number): Promise<Response> {
  const body = await readBody(request)
  if (!body.ok) return body.response
  const validation = validateStoryDefinition(body.value)
  if (!validation.ok) return error("invalid_story", validation.message, 400)
  const { definition, status } = validation.value
  if (definition.storyId !== storyId || definition.version !== version) {
    return error("invalid_story", "The definition's storyId and version must match the path.", 400)
  }

  // Story versions are immutable: re-activating is idempotent only for the identical definition
  // (compared on the canonical serialization, which leaves out status) and never revives a
  // deprecated version.
  const canonical = canonicalStoryJson(definition)
  const select = env.USAGE_DB.prepare("SELECT * FROM stories WHERE story_id = ? AND version = ?").bind(storyId, version)
  const unchanged = (row: StoryRow) => row.definition_json === canonical
    ? json({ result: "unchanged", story: catalogueEntry(row) })
    : error("story_version_conflict", "This story version already exists with a different definition.", 409)

  const existing = await select.first<StoryRow>()
  if (existing) return unchanged(existing)
  if (status !== "active") return error("invalid_story", "A deprecated story version cannot be activated.", 400)

  const inserted = await env.USAGE_DB.prepare(`
    INSERT INTO stories (story_id, version, definition_json, status, activated_at)
    VALUES (?, ?, ?, 'active', ?)
    ON CONFLICT (story_id, version) DO NOTHING
  `).bind(storyId, version, canonical, new Date().toISOString()).run()
  const row = await select.first<StoryRow>()
  if (!row) throw new Error("story activation was not persisted")
  if ((inserted.meta.changes ?? 0) === 1) return json({ result: "activated", story: catalogueEntry(row) }, 201)
  return unchanged(row)
}

async function deprecateStory(env: Env, storyId: string, version: number): Promise<Response> {
  await env.USAGE_DB.prepare(`
    UPDATE stories SET status = 'deprecated', deprecated_at = ?
    WHERE story_id = ? AND version = ? AND status = 'active'
  `).bind(new Date().toISOString(), storyId, version).run()
  const row = await env.USAGE_DB.prepare("SELECT * FROM stories WHERE story_id = ? AND version = ?")
    .bind(storyId, version).first<StoryRow>()
  if (!row) return error("not_found", "Story version not found.", 404)
  return json({ story: catalogueEntry(row) })
}

async function listSubjects(env: Env): Promise<Response> {
  const rows = await env.USAGE_DB.prepare(
    "SELECT * FROM subjects ORDER BY created_at, subject_id LIMIT ?",
  ).bind(ADMIN_SUBJECT_LIMIT + 1).all<SubjectRow>()
  const subjects = rows.results.slice(0, ADMIN_SUBJECT_LIMIT)
  return json({ subjects: subjects.map(publicSubject), truncated: rows.results.length > ADMIN_SUBJECT_LIMIT })
}

interface AdminQuery {
  clauses: string[]
  values: (string | number)[]
}

/** Shared filters for snapshots and totals: storyId is required, the rest optional. */
function storyQuery(url: URL): AdminQuery | Response {
  const storyId = url.searchParams.get("storyId")
  if (!isStoryId(storyId)) return error("invalid_query", "storyId is required.", 400)
  const query: AdminQuery = { clauses: ["story_id = ?"], values: [storyId] }

  const version = url.searchParams.get("version")
  if (version !== null) {
    if (!/^[1-9]\d*$/.test(version)) return error("invalid_query", "version must be a positive integer.", 400)
    query.clauses.push("story_version = ?")
    query.values.push(Number(version))
  }
  for (const [name, operator] of [["from", ">="], ["to", "<="]] as const) {
    const value = url.searchParams.get(name)
    if (value === null) continue
    if (parseUtcDay(value) === null) return error("invalid_query", `${name} must be a date (YYYY-MM-DD).`, 400)
    query.clauses.push(`period ${operator} ?`)
    query.values.push(value)
  }
  return query
}

async function querySnapshots(env: Env, url: URL): Promise<Response> {
  const query = storyQuery(url)
  if (query instanceof Response) return query
  const subject = url.searchParams.get("subject")
  if (subject !== null) {
    if (!isUuid(subject)) return error("invalid_query", "subject must be a UUID.", 400)
    query.clauses.push("subject_id = ?")
    query.values.push(subject.toLowerCase())
  }
  const rows = await env.USAGE_DB.prepare(`
    SELECT subject_id, story_id, story_version, period, rows_json, received_at FROM snapshots
    WHERE ${query.clauses.join(" AND ")}
    ORDER BY period, story_version, subject_id
    LIMIT ?
  `).bind(...query.values, ADMIN_SNAPSHOT_LIMIT + 1).all<{
    subject_id: string; story_id: string; story_version: number; period: string; rows_json: string; received_at: string
  }>()
  const snapshots = rows.results.slice(0, ADMIN_SNAPSHOT_LIMIT).map((row) => ({
    subjectId: row.subject_id,
    storyId: row.story_id,
    storyVersion: row.story_version,
    period: row.period,
    rows: JSON.parse(row.rows_json),
    receivedAt: row.received_at,
  }))
  return json({ snapshots, truncated: rows.results.length > ADMIN_SNAPSHOT_LIMIT })
}

async function queryTotals(env: Env, url: URL): Promise<Response> {
  const query = storyQuery(url)
  if (query instanceof Response) return query
  const rows = await env.USAGE_DB.prepare(`
    SELECT story_id, story_version, period, rows_json, subject_count FROM story_totals
    WHERE ${query.clauses.join(" AND ")}
    ORDER BY period, story_version
  `).bind(...query.values).all<{
    story_id: string; story_version: number; period: string; rows_json: string; subject_count: number
  }>()
  return json({
    totals: rows.results.map((row) => ({
      storyId: row.story_id,
      storyVersion: row.story_version,
      period: row.period,
      rows: JSON.parse(row.rows_json),
      subjectCount: row.subject_count,
    })),
  })
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!await adminAuthorized(request, env)) return error("unauthorized", "A valid admin key is required.", 401)
  const path = url.pathname

  const story = path.match(/^\/v1\/admin\/stories\/([^/]+)\/([^/]+)(\/deprecate)?$/)
  if (story) {
    const target = storyPath(story[1], story[2])
    if (!target) return error("not_found", "Story version not found.", 404)
    if (story[3] && request.method === "POST") return deprecateStory(env, target.storyId, target.version)
    if (!story[3] && request.method === "PUT") return activateStory(request, env, target.storyId, target.version)
    return error("method_not_allowed", "Method not allowed.", 405)
  }

  const reads: Record<string, (env: Env, url: URL) => Promise<Response>> = {
    "/v1/admin/subjects": (env) => listSubjects(env),
    "/v1/admin/snapshots": querySnapshots,
    "/v1/admin/totals": queryTotals,
  }
  const read = reads[path]
  if (!read) return error("not_found", "Endpoint not found.", 404)
  if (request.method !== "GET") return error("method_not_allowed", "Method not allowed.", 405)
  return read(env, url)
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { method } = request
  const path = url.pathname

  if (path === "/v1/catalogue") {
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS })
    if (method === "GET") return catalogue(env)
    return json({ error: "method_not_allowed", message: "Method not allowed." }, 405, true)
  }
  if (path === "/v1/subjects") {
    return method === "POST" ? registerSubject(request, env) : error("method_not_allowed", "Method not allowed.", 405)
  }
  if (path === "/v1/snapshots") {
    return method === "POST" ? uploadSnapshots(request, env) : error("method_not_allowed", "Method not allowed.", 405)
  }

  const subject = path.match(/^\/v1\/subjects\/([^/]+)$/)
  if (subject) {
    if (!isUuid(subject[1])) return error("not_found", "Endpoint not found.", 404)
    const subjectId = subject[1].toLowerCase()
    if (method === "PUT") return updateSubject(request, env, subjectId)
    if (method === "DELETE") return deleteSubject(request, env, subjectId)
    return error("method_not_allowed", "Method not allowed.", 405)
  }

  if (path.startsWith("/v1/admin/")) return admin(request, env, url)
  return error("not_found", "Endpoint not found.", 404)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      return await route(request, env, url)
    } catch (caught) {
      console.error("usage worker error", caught instanceof Error ? caught.message : "unknown")
      return json({ error: "internal_error", message: "The usage service could not handle this request." }, 500, url.pathname === "/v1/catalogue")
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(runRetention(env).then((report) => console.log("usage retention", JSON.stringify(report))))
  },
} satisfies ExportedHandler<Env>
