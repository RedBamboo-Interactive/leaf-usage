import type { StoryDefinition } from "./contracts.js"

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  USAGE_DB: D1Database
  REGISTER_RATE_LIMITER: RateLimiterBinding
  UPLOAD_RATE_LIMITER: RateLimiterBinding
  USAGE_ADMIN_API_KEY: string
}

export interface StoryRow {
  story_id: string
  version: number
  definition_json: string
  status: "active" | "deprecated"
  activated_at: string
  deprecated_at: string | null
}

export interface SubjectRow {
  subject_id: string
  secret_hash: string
  mode: "anonymous" | "named"
  label: string | null
  created_at: string
  last_upload_at: string | null
}

export interface ErasureReceipt {
  status: "erased"
  subjectId: string
  erasedAt: string
  snapshotsDeleted: number
  tombstone: string
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function secureEquals(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ])
  const aa = new Uint8Array(a)
  const bb = new Uint8Array(b)
  let difference = 0
  for (let index = 0; index < aa.length; index++) difference |= aa[index] ^ bb[index]
  return difference === 0
}

/** Tombstones store a hash of the subject id, never the id itself. */
export function subjectHash(subjectId: string): Promise<string> {
  return sha256Hex(subjectId.toLowerCase())
}

export async function tombstoneFor(env: Env, subjectId: string): Promise<{ erased_at: string } | null> {
  return env.USAGE_DB.prepare("SELECT erased_at FROM tombstones WHERE subject_hash = ?")
    .bind(await subjectHash(subjectId)).first<{ erased_at: string }>()
}

export function parseDefinition(row: StoryRow): StoryDefinition {
  return JSON.parse(row.definition_json) as StoryDefinition
}

/**
 * Deletes the subject and every snapshot it uploaded and writes a tombstone, in one D1 batch
 * (a single transaction), so an erasure is never half done.
 */
export async function eraseSubject(env: Env, subjectId: string, now: Date): Promise<ErasureReceipt> {
  const erasedAt = now.toISOString()
  const hash = await subjectHash(subjectId)
  const [snapshots] = await env.USAGE_DB.batch([
    env.USAGE_DB.prepare("DELETE FROM snapshots WHERE subject_id = ?").bind(subjectId),
    env.USAGE_DB.prepare("DELETE FROM subjects WHERE subject_id = ?").bind(subjectId),
    env.USAGE_DB.prepare(
      "INSERT INTO tombstones (subject_hash, erased_at) VALUES (?, ?) ON CONFLICT (subject_hash) DO UPDATE SET erased_at = excluded.erased_at",
    ).bind(hash, erasedAt),
  ])
  return { status: "erased", subjectId, erasedAt, snapshotsDeleted: snapshots.meta.changes ?? 0, tombstone: hash }
}
