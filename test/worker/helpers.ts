import { env, exports } from "cloudflare:workers"
import { formatUtcDay, utcDay } from "../../src/contracts"
import { sha256Hex } from "../../src/store"

export const ADMIN_KEY = "test-admin-key-0123456789abcdef"
const BASE = "http://localhost"
const DAY_MS = 86_400_000

export function call(path: string, init: RequestInit = {}, base = BASE): Promise<Response> {
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(base + path, init))
}

export function send(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers["Content-Type"] = "application/json"
  if (token) headers.Authorization = `Bearer ${token}`
  return call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

export function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return send(method, path, body, ADMIN_KEY)
}

/** UTC day `offset` days before today. */
export function day(offset = 1): string {
  return formatUtcDay(utcDay(new Date()) - offset * DAY_MS)
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

let counter = 0

export function storyDefinition(overrides: Record<string, unknown> = {}) {
  counter++
  return {
    schemaVersion: 1,
    storyId: `test-story-${counter}-${crypto.randomUUID().slice(0, 8)}`,
    version: 1,
    status: "active",
    question: "Which AI coding harness do you use?",
    shares: "Per day: number of AI sessions by harness.",
    period: "day",
    backfillDays: 30,
    dimensions: [
      { key: "harness", values: ["claude-code", "codex", "opencode", "other"] },
      { key: "initiator", values: ["you", "agent"] },
    ],
    measures: [
      { key: "sessions", type: "count", max: 10000 },
      { key: "messages", type: "count", max: 1000000 },
    ],
    clientObservations: [],
    introducedIn: "0.1.40",
    ...overrides,
  }
}

export type Story = ReturnType<typeof storyDefinition>

export async function activeStory(overrides: Record<string, unknown> = {}): Promise<Story> {
  const definition = storyDefinition(overrides)
  const response = await admin("PUT", `/v1/admin/stories/${definition.storyId}/${definition.version}`, definition)
  if (response.status !== 201) throw new Error(`activation failed: ${response.status} ${await response.text()}`)
  return definition
}

export interface Subject {
  subjectId: string
  secret: string
}

export async function newSubject(): Promise<Subject & { secretHash: string }> {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return { subjectId: crypto.randomUUID(), secret, secretHash: await sha256Hex(secret) }
}

export async function registeredSubject(label?: string): Promise<Subject> {
  const subject = await newSubject()
  const response = await send("POST", "/v1/subjects", {
    subjectId: subject.subjectId,
    secretHash: subject.secretHash,
    mode: label ? "named" : "anonymous",
    ...(label ? { label } : {}),
  })
  if (response.status !== 201) throw new Error(`registration failed: ${response.status} ${await response.text()}`)
  return subject
}

export function snapshot(story: { storyId: string; version: number }, period: string, rows: unknown[] = [
  { dims: { harness: "codex", initiator: "you" }, sessions: 3, messages: 41 },
  { dims: { harness: "claude-code", initiator: "agent" }, sessions: 1, messages: 12 },
]) {
  return {
    schemaVersion: 1,
    snapshotId: crypto.randomUUID(),
    storyId: story.storyId,
    storyVersion: story.version,
    period,
    rows,
  }
}

export interface UploadResult {
  index: number
  snapshotId: string | null
  status: "accepted" | "duplicate" | "story_inactive" | "invalid"
  message?: string
}

export async function upload(subject: Subject, snapshots: unknown[]): Promise<UploadResult[]> {
  const response = await send("POST", "/v1/snapshots", { subjectId: subject.subjectId, snapshots }, subject.secret)
  if (response.status !== 200) throw new Error(`upload failed: ${response.status} ${await response.text()}`)
  return ((await response.json()) as { results: UploadResult[] }).results
}

export function db(): D1Database {
  return env.USAGE_DB
}
