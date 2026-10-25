import { afterEach, describe, expect, it, vi } from "vitest"
import {
  activeStory,
  admin,
  call,
  day,
  db,
  newSubject,
  registeredSubject,
  send,
  snapshot,
  storyDefinition,
  upload,
} from "./helpers"
import { sha256Hex } from "../../src/store"
import { formatUtcDay, utcDay } from "../../src/contracts"

describe("catalogue", () => {
  it("lists active and deprecated story versions with CORS", async () => {
    const active = await activeStory()
    const stopped = await activeStory()
    await admin("POST", `/v1/admin/stories/${stopped.storyId}/1/deprecate`)

    const response = await call("/v1/catalogue")
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    const { stories } = await response.json() as { stories: { storyId: string; status: string; definition: { storyId: string } }[] }
    expect(stories.find((story) => story.storyId === active.storyId)?.status).toBe("active")
    expect(stories.find((story) => story.storyId === stopped.storyId)?.status).toBe("deprecated")
    // The published definition matches the RedLeaf schema, with the Worker's live status.
    const { definition } = stories.find((story) => story.storyId === stopped.storyId) as unknown as { definition: Record<string, unknown> }
    expect(definition).toEqual({ ...stopped, status: "deprecated" })
    expect(Object.keys(definition).slice(0, 4)).toEqual(["schemaVersion", "storyId", "version", "status"])

    const preflight = await call("/v1/catalogue", { method: "OPTIONS" })
    expect(preflight.status).toBe(204)
  })

  it("does not send CORS headers on server-side routes", async () => {
    const response = await send("POST", "/v1/subjects", {})
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("subject registration", () => {
  it("registers an anonymous subject and is idempotent on retry", async () => {
    const subject = await newSubject()
    const body = { subjectId: subject.subjectId, secretHash: subject.secretHash, mode: "anonymous" }
    const first = await send("POST", "/v1/subjects", body)
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ subjectId: subject.subjectId, mode: "anonymous", label: null, lastUploadAt: null })

    const retry = await send("POST", "/v1/subjects", body)
    expect(retry.status).toBe(200)

    const other = await newSubject()
    const conflict = await send("POST", "/v1/subjects", { ...body, secretHash: other.secretHash })
    expect(conflict.status).toBe(409)
  })

  it("registers a named subject with its label", async () => {
    const subject = await newSubject()
    const response = await send("POST", "/v1/subjects", {
      subjectId: subject.subjectId, secretHash: subject.secretHash, mode: "named", label: "Juju 2029",
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ mode: "named", label: "Juju 2029" })
  })

  it.each([
    ["unknown key", { mode: "anonymous", ip: "1.2.3.4" }],
    ["named without label", { mode: "named" }],
    ["anonymous with label", { mode: "anonymous", label: "Juju" }],
    ["label too long", { mode: "named", label: "x".repeat(41) }],
    ["control character in label", { mode: "named", label: "Ju\u0000ju" }],
    ["unknown mode", { mode: "public" }],
  ])("refuses %s", async (_name, extra) => {
    const subject = await newSubject()
    const response = await send("POST", "/v1/subjects", { subjectId: subject.subjectId, secretHash: subject.secretHash, ...extra })
    expect(response.status).toBe(400)
  })

  it("refuses a malformed secret hash", async () => {
    const subject = await newSubject()
    const response = await send("POST", "/v1/subjects", { subjectId: subject.subjectId, secretHash: subject.secret.toUpperCase(), mode: "anonymous" })
    expect(response.status).toBe(400)
  })

  it("never stores the client address or user agent", async () => {
    const subject = await newSubject()
    await call("/v1/subjects", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.9", "User-Agent": "LeafKernel/1.0" },
      body: JSON.stringify({ subjectId: subject.subjectId, secretHash: subject.secretHash, mode: "anonymous" }),
    })
    const row = await db().prepare("SELECT * FROM subjects WHERE subject_id = ?").bind(subject.subjectId).first()
    expect(Object.keys(row!).sort()).toEqual(["created_at", "label", "last_upload_at", "mode", "secret_hash", "subject_id"])
    expect(JSON.stringify(row)).not.toContain("203.0.113.9")
    expect(JSON.stringify(row)).not.toContain("LeafKernel")
  })
})

describe("subject update", () => {
  it("switching to anonymous nulls the label", async () => {
    const subject = await registeredSubject("Juju")
    const response = await send("PUT", `/v1/subjects/${subject.subjectId}`, { mode: "anonymous" }, subject.secret)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: "anonymous", label: null })
    const row = await db().prepare("SELECT label FROM subjects WHERE subject_id = ?").bind(subject.subjectId).first<{ label: string | null }>()
    expect(row?.label).toBeNull()
  })

  it("changes the label of a named subject", async () => {
    const subject = await registeredSubject()
    const response = await send("PUT", `/v1/subjects/${subject.subjectId}`, { mode: "named", label: "Nova" }, subject.secret)
    expect(await response.json()).toMatchObject({ mode: "named", label: "Nova" })
  })

  it("refuses a wrong bearer", async () => {
    const subject = await registeredSubject("Juju")
    const other = await registeredSubject()
    const wrong = await send("PUT", `/v1/subjects/${subject.subjectId}`, { mode: "anonymous" }, other.secret)
    expect(wrong.status).toBe(401)
    const missing = await send("PUT", `/v1/subjects/${subject.subjectId}`, { mode: "anonymous" })
    expect(missing.status).toBe(401)
    const row = await db().prepare("SELECT label FROM subjects WHERE subject_id = ?").bind(subject.subjectId).first<{ label: string }>()
    expect(row?.label).toBe("Juju")
  })
})

describe("snapshot upload", () => {
  it("accepts a valid snapshot, stores canonical rows and records the upload", async () => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const item = snapshot(story, day(1), [
      { messages: 12, sessions: 1, dims: { initiator: "agent", harness: "codex" } },
      { dims: { harness: "claude-code", initiator: "you" }, sessions: 2, messages: 0 },
    ])
    const [result] = await upload(subject, [item])
    expect(result).toMatchObject({ index: 0, snapshotId: item.snapshotId, status: "accepted" })

    const row = await db().prepare("SELECT rows_json FROM snapshots WHERE subject_id = ? AND story_id = ?")
      .bind(subject.subjectId, story.storyId).first<{ rows_json: string }>()
    expect(JSON.parse(row!.rows_json)).toEqual([
      { dims: { harness: "claude-code", initiator: "you" }, sessions: 2, messages: 0 },
      { dims: { harness: "codex", initiator: "agent" }, sessions: 1, messages: 12 },
    ])
    const stored = await db().prepare("SELECT last_upload_at FROM subjects WHERE subject_id = ?").bind(subject.subjectId).first<{ last_upload_at: string }>()
    expect(stored?.last_upload_at).toBeTruthy()
  })

  it("accepts an empty snapshot for a day with no rows", async () => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const [result] = await upload(subject, [snapshot(story, day(2), [])])
    expect(result.status).toBe("accepted")
  })

  it("accepts yesterday and the oldest day of the backfill window plus 7 days", async () => {
    const story = await activeStory({ backfillDays: 3 })
    const subject = await registeredSubject()
    const results = await upload(subject, [snapshot(story, day(1)), snapshot(story, day(10))])
    expect(results.map((result) => result.status)).toEqual(["accepted", "accepted"])
  })

  it("refuses today, because a partial day would lock the period", async () => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const [result] = await upload(subject, [snapshot(story, day(0))])
    expect(result).toMatchObject({ status: "invalid", message: "period must be a closed UTC day." })
    expect(await db().prepare("SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?").bind(subject.subjectId).first("n")).toBe(0)
  })

  describe("closed-day boundary", () => {
    const today = utcDay(new Date())
    afterEach(() => {
      vi.useRealTimers()
    })

    it("still refuses today at 23:59:59 UTC", async () => {
      const story = await activeStory()
      const subject = await registeredSubject()
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(today + 86_400_000 - 1000)
      const results = await upload(subject, [snapshot(story, formatUtcDay(today)), snapshot(story, formatUtcDay(today - 86_400_000))])
      expect(results.map((result) => result.status)).toEqual(["invalid", "accepted"])
    })

    it("accepts that day at 00:00:00 UTC the next day", async () => {
      const story = await activeStory()
      const subject = await registeredSubject()
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(today + 86_400_000)
      const results = await upload(subject, [snapshot(story, formatUtcDay(today)), snapshot(story, formatUtcDay(today + 86_400_000))])
      expect(results.map((result) => result.status)).toEqual(["accepted", "invalid"])
    })
  })

  it("reports an identical retry as duplicate, even with keys reordered", async () => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const item = snapshot(story, day(1))
    expect((await upload(subject, [item]))[0].status).toBe("accepted")

    const reordered = { ...item, snapshotId: crypto.randomUUID(), rows: [...item.rows].reverse() }
    const results = await upload(subject, [item, reordered])
    expect(results.map((result) => result.status)).toEqual(["duplicate", "duplicate"])
  })

  it("keeps the first write when a different payload arrives for the same day", async () => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const item = snapshot(story, day(1))
    await upload(subject, [item])
    const [changed] = await upload(subject, [snapshot(story, day(1), [{ dims: { harness: "codex", initiator: "you" }, sessions: 99, messages: 99 }])])
    expect(changed.status).toBe("invalid")
    const row = await db().prepare("SELECT rows_json FROM snapshots WHERE subject_id = ? AND story_id = ?")
      .bind(subject.subjectId, story.storyId).first<{ rows_json: string }>()
    expect(row!.rows_json).not.toContain("99")
  })

  it("reports deprecated and unknown story versions as story_inactive", async () => {
    const story = await activeStory()
    await admin("POST", `/v1/admin/stories/${story.storyId}/1/deprecate`)
    const subject = await registeredSubject()
    const results = await upload(subject, [
      snapshot(story, day(1)),
      snapshot({ storyId: story.storyId, version: 2 }, day(1)),
      snapshot({ storyId: "never-activated", version: 1 }, day(1)),
    ])
    expect(results.map((result) => result.status)).toEqual(["story_inactive", "story_inactive", "story_inactive"])
    const count = await db().prepare("SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?").bind(subject.subjectId).first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  const codex = { harness: "codex", initiator: "you" }
  const invalidRows: [string, unknown[]][] = [
    ["enum smuggling in a dimension", [{ dims: { harness: "my-secret-repo", initiator: "you" }, sessions: 1, messages: 1 }]],
    ["free text smuggled as a dimension value", [{ dims: { harness: "Juju's project", initiator: "you" }, sessions: 1, messages: 1 }]],
    ["a float measure", [{ dims: codex, sessions: 1.5, messages: 1 }]],
    ["a numeric string measure", [{ dims: codex, sessions: "1", messages: 1 }]],
    ["a measure over max", [{ dims: codex, sessions: 10001, messages: 1 }]],
    ["a negative measure", [{ dims: codex, sessions: -1, messages: 1 }]],
    ["an unknown measure", [{ dims: codex, sessions: 1, messages: 1, tokens: 5 }]],
    ["an unknown dimension", [{ dims: { ...codex, repo: "other" }, sessions: 1, messages: 1 }]],
    ["a missing dimension", [{ dims: { harness: "codex" }, sessions: 1, messages: 1 }]],
    ["a missing measure", [{ dims: codex, sessions: 1 }]],
    ["a repeated dimension combination", [{ dims: codex, sessions: 1, messages: 1 }, { dims: codex, sessions: 2, messages: 2 }]],
    ["an all-zero row", [{ dims: codex, sessions: 0, messages: 0 }]],
    ["a nested object as a dimension value", [{ dims: { harness: { value: "codex" }, initiator: "you" }, sessions: 1, messages: 1 }]],
  ]
  it.each(invalidRows)("rejects %s and stores nothing", async (_name, rows) => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const [result] = await upload(subject, [snapshot(story, day(1), rows)])
    expect(result.status).toBe("invalid")
    expect(result.message).toBeTruthy()
    const stored = await db().prepare("SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?").bind(subject.subjectId).first<{ n: number }>()
    expect(stored?.n).toBe(0)
  })

  it.each([
    ["an unknown top-level key", (item: Record<string, unknown>) => ({ ...item, hostname: "juju-pc" })],
    ["a future period", (item: Record<string, unknown>) => ({ ...item, period: formatUtcDay(utcDay(new Date()) + 86_400_000) })],
    ["a period older than backfill + 7 days", (item: Record<string, unknown>) => ({ ...item, period: day(38) })],
    ["an impossible date", (item: Record<string, unknown>) => ({ ...item, period: "2026-02-30" })],
    ["a timestamp period", (item: Record<string, unknown>) => ({ ...item, period: `${day(1)}T10:00:00Z` })],
    ["a wrong schema version", (item: Record<string, unknown>) => ({ ...item, schemaVersion: 2 })],
    ["a non-UUID snapshot id", (item: Record<string, unknown>) => ({ ...item, snapshotId: "abc" })],
    ["an upper-case snapshot id", (item: Record<string, unknown>) => ({ ...item, snapshotId: String(item.snapshotId).toUpperCase() })],
    ["a float story version", (item: Record<string, unknown>) => ({ ...item, storyVersion: 1.5 })],
    ["rows that are not an array", (item: Record<string, unknown>) => ({ ...item, rows: {} })],
  ])("rejects %s", async (_name, mutate) => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const [result] = await upload(subject, [mutate(snapshot(story, day(1)))])
    expect(result.status).toBe("invalid")
  })

  it("accepts the period on the edge of the window and rejects the day after", async () => {
    const story = await activeStory({ backfillDays: 30 })
    const subject = await registeredSubject()
    const results = await upload(subject, [snapshot(story, day(37)), snapshot(story, day(38))])
    expect(results.map((result) => result.status)).toEqual(["accepted", "invalid"])
  })

  it("returns a result per item in a mixed batch", async () => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const results = await upload(subject, [
      snapshot(story, day(1)),
      snapshot(story, day(1)),
      snapshot({ storyId: "missing-story", version: 1 }, day(1)),
      "not an object",
    ])
    expect(results.map((result) => [result.index, result.status])).toEqual([
      [0, "accepted"], [1, "duplicate"], [2, "story_inactive"], [3, "invalid"],
    ])
  })

  it("refuses a wrong or missing bearer", async () => {
    const story = await activeStory()
    const subject = await registeredSubject()
    const other = await registeredSubject()
    const body = { subjectId: subject.subjectId, snapshots: [snapshot(story, day(1))] }
    expect((await send("POST", "/v1/snapshots", body, other.secret)).status).toBe(401)
    expect((await send("POST", "/v1/snapshots", body)).status).toBe(401)
    expect((await send("POST", "/v1/snapshots", body, "Bearer-looking-but-wrong-secret")).status).toBe(401)
    const count = await db().prepare("SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?").bind(subject.subjectId).first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it("reports an unregistered subject as not found", async () => {
    const story = await activeStory()
    const subject = await newSubject()
    const response = await send("POST", "/v1/snapshots", { subjectId: subject.subjectId, snapshots: [snapshot(story, day(1))] }, subject.secret)
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: "subject_not_found" })
  })

  it("refuses batches over 50 items, empty batches and unknown envelope keys", async () => {
    const story = await activeStory({ backfillDays: 30 })
    const subject = await registeredSubject()
    const items = Array.from({ length: 51 }, (_, index) => snapshot(story, day(1 + (index % 30))))
    expect((await send("POST", "/v1/snapshots", { subjectId: subject.subjectId, snapshots: items }, subject.secret)).status).toBe(400)
    expect((await send("POST", "/v1/snapshots", { subjectId: subject.subjectId, snapshots: [] }, subject.secret)).status).toBe(400)
    expect((await send("POST", "/v1/snapshots", { subjectId: subject.subjectId, snapshots: [snapshot(story, day(1))], client: "x" }, subject.secret)).status).toBe(400)
  })

  it("accepts a full batch of 50", async () => {
    const story = await activeStory({ backfillDays: 30 })
    const other = await activeStory({ backfillDays: 30 })
    const subject = await registeredSubject()
    const items = Array.from({ length: 50 }, (_, index) => snapshot(index < 25 ? story : other, day(1 + (index % 25))))
    const results = await upload(subject, items)
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(50)
  })

  it("refuses bodies over 64 KB", async () => {
    const subject = await registeredSubject()
    const response = await call("/v1/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${subject.secret}` },
      body: JSON.stringify({ subjectId: subject.subjectId, snapshots: [], padding: "x".repeat(65 * 1024) }),
    })
    expect(response.status).toBe(413)
  })

  it("refuses invalid JSON", async () => {
    const subject = await registeredSubject()
    const response = await call("/v1/snapshots", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${subject.secret}` },
      body: "{not json",
    })
    expect(response.status).toBe(400)
  })
})

describe("subject deletion", () => {
  it("erases the subject and its snapshots, writes a tombstone and refuses re-registration", async () => {
    const story = await activeStory()
    const subject = await registeredSubject("Juju")
    await upload(subject, [snapshot(story, day(1)), snapshot(story, day(2))])

    const response = await send("DELETE", `/v1/subjects/${subject.subjectId}`, undefined, subject.secret)
    expect(response.status).toBe(200)
    const receipt = await response.json() as Record<string, unknown>
    expect(receipt).toMatchObject({ status: "erased", subjectId: subject.subjectId, snapshotsDeleted: 2 })
    expect(receipt.tombstone).toBe(await sha256Hex(subject.subjectId))
    expect(typeof receipt.erasedAt).toBe("string")

    expect(await db().prepare("SELECT COUNT(*) AS n FROM subjects WHERE subject_id = ?").bind(subject.subjectId).first("n")).toBe(0)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?").bind(subject.subjectId).first("n")).toBe(0)
    const tombstone = await db().prepare("SELECT * FROM tombstones WHERE subject_hash = ?").bind(receipt.tombstone).first()
    expect(tombstone).toBeTruthy()
    // The tombstone never holds the subject id itself.
    const everything = await db().prepare("SELECT * FROM tombstones").all()
    expect(JSON.stringify(everything.results)).not.toContain(subject.subjectId)

    const admins = await (await admin("GET", `/v1/admin/snapshots?storyId=${story.storyId}`)).json() as { snapshots: unknown[] }
    expect(admins.snapshots).toHaveLength(0)
    const subjects = await (await admin("GET", "/v1/admin/subjects")).json() as { subjects: { subjectId: string }[] }
    expect(subjects.subjects.some((row) => row.subjectId === subject.subjectId)).toBe(false)

    const again = await send("POST", "/v1/subjects", {
      subjectId: subject.subjectId,
      secretHash: await sha256Hex(subject.secret),
      mode: "anonymous",
    })
    expect(again.status).toBe(410)
    expect(await again.json()).toMatchObject({ error: "subject_erased" })

    const late = await send("POST", "/v1/snapshots", { subjectId: subject.subjectId, snapshots: [snapshot(story, day(3))] }, subject.secret)
    expect(late.status).toBe(410)
    const repeat = await send("DELETE", `/v1/subjects/${subject.subjectId}`, undefined, subject.secret)
    expect(repeat.status).toBe(410)
  })

  it("refuses deletion with a wrong bearer", async () => {
    const subject = await registeredSubject()
    const other = await registeredSubject()
    const response = await send("DELETE", `/v1/subjects/${subject.subjectId}`, undefined, other.secret)
    expect(response.status).toBe(401)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM subjects WHERE subject_id = ?").bind(subject.subjectId).first("n")).toBe(1)
  })

  it("accepts an upper-case subject id in the path", async () => {
    const subject = await registeredSubject()
    const response = await send("DELETE", `/v1/subjects/${subject.subjectId.toUpperCase()}`, undefined, subject.secret)
    expect(response.status).toBe(200)
  })
})

describe("rate limiting", () => {
  it("limits registrations per client address without storing it", async () => {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 12; attempt++) {
      const subject = await newSubject()
      const response = await call("/v1/subjects", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "198.51.100.77" },
        body: JSON.stringify({ subjectId: subject.subjectId, secretHash: subject.secretHash, mode: "anonymous" }),
      }, "https://usage.minititine.cc")
      statuses.push(response.status)
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })

  it("does not rate limit the catalogue", async () => {
    for (let attempt = 0; attempt < 15; attempt++) {
      const response = await call("/v1/catalogue", { headers: { "cf-connecting-ip": "198.51.100.78" } }, "https://usage.minititine.cc")
      expect(response.status).toBe(200)
    }
  })
})

describe("admin", () => {
  it("refuses a wrong or missing admin key", async () => {
    expect((await call("/v1/admin/subjects")).status).toBe(401)
    expect((await send("GET", "/v1/admin/subjects", undefined, "wrong-key")).status).toBe(401)
    const subject = await registeredSubject()
    expect((await send("GET", "/v1/admin/subjects", undefined, subject.secret)).status).toBe(401)
  })

  type History = {
    storyId: string
    current: { status: string; shapeHash: string; definition: Record<string, unknown> } | null
    history: { changedAt: string; shapeHash: string; definition: Record<string, unknown> }[]
  }
  const historyOf = async (storyId: string) => (await admin("GET", `/v1/admin/stories/${storyId}/history`)).json() as Promise<History>

  it("activates a story and is idempotent for the identical definition", async () => {
    const definition = storyDefinition()
    const path = `/v1/admin/stories/${definition.storyId}/1`
    const first = await admin("PUT", path, definition)
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ result: "activated" })

    const same = await admin("PUT", path, { ...definition, status: "active" })
    expect(same.status).toBe(200)
    expect(await same.json()).toMatchObject({ result: "unchanged" })
    expect((await historyOf(definition.storyId)).history).toEqual([])
  })

  it("updates the wording in place and records the previous definition", async () => {
    const story = await activeStory()
    const path = `/v1/admin/stories/${story.storyId}/1`
    const subject = await registeredSubject()
    expect((await upload(subject, [snapshot(story, day(2))]))[0].status).toBe("accepted")

    const reworded = { ...story, question: "Which harness runs your sessions?", shares: "Per day: sessions by harness and initiator.", introducedIn: "0.1.41" }
    const response = await admin("PUT", path, reworded)
    expect(response.status).toBe(200)
    const body = await response.json() as { result: string; updatedAt: string; shapeChanged: boolean; story: { status: string; definition: Record<string, unknown> } }
    expect(body).toMatchObject({ result: "updated", shapeChanged: false, story: { status: "active" } })
    expect(typeof body.updatedAt).toBe("string")
    expect(body.story.definition).toEqual(reworded)

    // The catalogue serves the current wording, and the same wording again is unchanged.
    const { stories } = await (await call("/v1/catalogue")).json() as { stories: { storyId: string; definition: Record<string, unknown> }[] }
    expect(stories.find((entry) => entry.storyId === story.storyId)?.definition).toEqual(reworded)
    expect(await (await admin("PUT", path, reworded)).json()).toMatchObject({ result: "unchanged" })

    // The previous definition is kept; a wording edit leaves the shape hash alone.
    const record = await historyOf(story.storyId)
    expect(record.history).toHaveLength(1)
    expect(record.history[0]).toMatchObject({ changedAt: body.updatedAt, definition: { question: story.question } })
    expect(record.history[0].definition).not.toHaveProperty("status")
    expect(record.history[0].shapeHash).toBe(record.current!.shapeHash)

    // The data is untouched: earlier snapshots stay, and an identical retry is still a duplicate.
    const results = await upload(subject, [snapshot(story, day(2)), snapshot(story, day(1))])
    expect(results.map((result) => result.status)).toEqual(["duplicate", "accepted"])
  })

  it("edits the data shape in place; old-shape uploads are invalid and every answer keeps its shape hash", async () => {
    const story = await activeStory()
    const path = `/v1/admin/stories/${story.storyId}/1`
    const subject = await registeredSubject()
    expect((await upload(subject, [snapshot(story, day(3))]))[0].status).toBe("accepted")

    const reshaped = {
      ...story,
      dimensions: [{ key: "harness", values: ["claude-code", "codex", "opencode", "cursor", "other"] }, story.dimensions[1]],
      measures: [story.measures[0]],
    }
    const response = await admin("PUT", path, reshaped)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: "updated", shapeChanged: true, story: { version: 1, definition: reshaped } })

    // A lagging installation still sends the old shape: rejected, nothing stored.
    const [old] = await upload(subject, [snapshot(story, day(2))])
    expect(old.status).toBe("invalid")
    // After it updates, the recalculated day fits the current shape.
    const [fresh] = await upload(subject, [snapshot(story, day(2), [{ dims: { harness: "cursor", initiator: "you" }, sessions: 4 }])])
    expect(fresh.status).toBe("accepted")

    const record = await historyOf(story.storyId)
    expect(record.history).toHaveLength(1)
    expect(record.history[0].shapeHash).not.toBe(record.current!.shapeHash)

    type Rows = { snapshots: { period: string; shapeHash: string }[] }
    const { snapshots } = await (await admin("GET", `/v1/admin/snapshots?storyId=${story.storyId}`)).json() as Rows
    expect(snapshots.map((row) => [row.period, row.shapeHash])).toEqual([
      [day(3), record.history[0].shapeHash],
      [day(2), record.current!.shapeHash],
    ])
  })

  it("activates a story with release-version and git-commit format dimensions and validates uploads against them", async () => {
    const story = await activeStory({
      backfillDays: 0,
      dimensions: [
        { key: "component", values: ["redleaf", "nova", "other"] },
        { key: "build", values: ["release", "source", "unknown"] },
        { key: "version", format: "release-version" },
        { key: "commit", format: "git-commit" },
        { key: "state", values: ["enabled", "disabled"] },
      ],
      measures: [{ key: "components", type: "count", max: 500 }],
    })
    const stored = await (await admin("GET", `/v1/admin/stories/${story.storyId}/history`)).json() as { current: { definition: { dimensions: unknown[] } } }
    expect(stored.current.definition.dimensions[2]).toEqual({ key: "version", format: "release-version" })
    expect(stored.current.definition.dimensions[3]).toEqual({ key: "commit", format: "git-commit" })

    const subject = await registeredSubject()
    const [accepted] = await upload(subject, [snapshot(story, day(1), [
      { dims: { component: "redleaf", build: "release", version: "0.1.37", commit: "none", state: "enabled" }, components: 1 },
      { dims: { component: "nova", build: "source", version: "0.1.6", commit: "ccbb5c4", state: "enabled" }, components: 1 },
      { dims: { component: "other", build: "unknown", version: "unknown", commit: "none", state: "disabled" }, components: 2 },
    ])])
    expect(accepted.status).toBe("accepted")

    const other = await registeredSubject()
    const [refused] = await upload(other, [snapshot(story, day(1), [
      { dims: { component: "nova", build: "release", version: "0.1.38-beta.1", commit: "none", state: "enabled" }, components: 1 },
    ])])
    expect(refused).toMatchObject({ status: "invalid", message: 'Row 0 has a value outside the "version" release-version format.' })

    const third = await registeredSubject()
    const [dirty] = await upload(third, [snapshot(story, day(1), [
      { dims: { component: "nova", build: "source", version: "0.1.6", commit: "ccbb5c4.dirty", state: "enabled" }, components: 1 },
    ])])
    expect(dirty).toMatchObject({ status: "invalid", message: 'Row 0 has a value outside the "commit" git-commit format.' })
  })

  it("keeps every previous definition, newest first", async () => {
    const story = await activeStory()
    const path = `/v1/admin/stories/${story.storyId}/1`
    await admin("PUT", path, { ...story, question: "Second wording?" })
    await admin("PUT", path, { ...story, question: "Third wording?", backfillDays: 7 })
    const record = await historyOf(story.storyId)
    expect(record.current?.definition).toMatchObject({ question: "Third wording?", backfillDays: 7 })
    expect(record.history.map((entry) => entry.definition.question)).toEqual(["Second wording?", story.question])
  })

  it("answers 404 for the history of an unknown story and refuses writes to it", async () => {
    expect((await admin("GET", "/v1/admin/stories/never-activated/history")).status).toBe(404)
    const story = await activeStory()
    expect((await admin("POST", `/v1/admin/stories/${story.storyId}/history`)).status).toBe(405)
    expect((await call(`/v1/admin/stories/${story.storyId}/history`)).status).toBe(401)
  })

  it("updates a deprecated story in place without reviving it", async () => {
    const story = await activeStory()
    const path = `/v1/admin/stories/${story.storyId}/1`
    await admin("POST", `${path}/deprecate`)
    const response = await admin("PUT", path, { ...story, status: "deprecated", question: "Retired wording?" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: "updated", story: { status: "deprecated", definition: { question: "Retired wording?", status: "deprecated" } } })
  })

  it("refuses any story version other than 1", async () => {
    const story = storyDefinition()
    const response = await admin("PUT", `/v1/admin/stories/${story.storyId}/2`, { ...story, version: 2 })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ message: "version is fixed at 1; edit the story in place instead." })
  })

  it("never revives a deprecated version", async () => {
    const story = await activeStory()
    const path = `/v1/admin/stories/${story.storyId}/1`
    const deprecated = await admin("POST", `${path}/deprecate`)
    expect(deprecated.status).toBe(200)
    expect(await deprecated.json()).toMatchObject({ story: { status: "deprecated" } })
    const again = await admin("PUT", path, story)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ result: "unchanged", story: { status: "deprecated" } })
    // A release that ships the seed already marked deprecated is still the same definition.
    const seed = await admin("PUT", path, { ...story, status: "deprecated" })
    expect(seed.status).toBe(200)
    expect((await admin("POST", "/v1/admin/stories/no-such-story/1/deprecate")).status).toBe(404)
  })

  it.each([
    ["path mismatch", (definition: Record<string, unknown>) => ({ ...definition, version: 2 })],
    ["unknown key", (definition: Record<string, unknown>) => ({ ...definition, owner: "laurent" })],
    ["string measure type", (definition: Record<string, unknown>) => ({ ...definition, measures: [{ key: "name", type: "string", max: 1 }] })],
    ["no measures", (definition: Record<string, unknown>) => ({ ...definition, measures: [] })],
    ["backfill over 30", (definition: Record<string, unknown>) => ({ ...definition, backfillDays: 31 })],
    ["repeated enum value", (definition: Record<string, unknown>) => ({ ...definition, dimensions: [{ key: "harness", values: ["codex", "codex"] }] })],
    ["free-text enum value", (definition: Record<string, unknown>) => ({ ...definition, dimensions: [{ key: "harness", values: ["Claude Code"] }] })],
    ["measure named dims", (definition: Record<string, unknown>) => ({ ...definition, measures: [{ key: "dims", type: "count", max: 1 }] })],
    ["deprecated status", (definition: Record<string, unknown>) => ({ ...definition, status: "deprecated" })],
    ["unknown key in a dimension", (definition: Record<string, unknown>) => ({ ...definition, dimensions: [{ key: "harness", values: ["codex"], label: "x" }] })],
    ["hourly period", (definition: Record<string, unknown>) => ({ ...definition, period: "hour" })],
    ["missing schemaVersion", (definition: Record<string, unknown>) => ({ ...definition, schemaVersion: undefined })],
    ["unknown client observation", (definition: Record<string, unknown>) => ({ ...definition, clientObservations: ["screen-size"] })],
  ])("refuses a definition with %s", async (_name, mutate) => {
    const definition = storyDefinition()
    const response = await admin("PUT", `/v1/admin/stories/${definition.storyId}/1`, mutate(definition))
    expect(response.status).toBe(400)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM stories WHERE story_id = ?").bind(definition.storyId).first("n")).toBe(0)
  })

  it("lists subjects with mode, label and last upload", async () => {
    const story = await activeStory()
    const named = await registeredSubject("Juju")
    await upload(named, [snapshot(story, day(1))])
    const { subjects } = await (await admin("GET", "/v1/admin/subjects")).json() as { subjects: Record<string, unknown>[] }
    const entry = subjects.find((subject) => subject.subjectId === named.subjectId)
    expect(entry).toMatchObject({ mode: "named", label: "Juju" })
    expect(entry?.lastUploadAt).toBeTruthy()
    expect(entry).not.toHaveProperty("secretHash")
  })

  it("queries snapshots by story, version, date range and subject", async () => {
    const story = await activeStory()
    const first = await registeredSubject()
    const second = await registeredSubject()
    await upload(first, [snapshot(story, day(1)), snapshot(story, day(3)), snapshot(story, day(5))])
    await upload(second, [snapshot(story, day(3))])

    type Rows = { snapshots: { subjectId: string; period: string; rows: unknown[] }[] }
    const all = await (await admin("GET", `/v1/admin/snapshots?storyId=${story.storyId}&version=1`)).json() as Rows
    expect(all.snapshots).toHaveLength(4)
    const ranged = await (await admin("GET", `/v1/admin/snapshots?storyId=${story.storyId}&from=${day(4)}&to=${day(2)}`)).json() as Rows
    expect(ranged.snapshots.map((row) => row.period)).toEqual([day(3), day(3)])
    const bySubject = await (await admin("GET", `/v1/admin/snapshots?storyId=${story.storyId}&subject=${first.subjectId}`)).json() as Rows
    expect(bySubject.snapshots).toHaveLength(3)
    expect(bySubject.snapshots[0].rows).toHaveLength(2)
    const otherVersion = await (await admin("GET", `/v1/admin/snapshots?storyId=${story.storyId}&version=2`)).json() as Rows
    expect(otherVersion.snapshots).toHaveLength(0)

    expect((await admin("GET", "/v1/admin/snapshots")).status).toBe(400)
    expect((await admin("GET", `/v1/admin/snapshots?storyId=${story.storyId}&from=yesterday`)).status).toBe(400)
  })
})

describe("routing", () => {
  it("answers unknown routes and methods with JSON errors", async () => {
    expect((await call("/")).status).toBe(404)
    expect((await call("/v1/subjects")).status).toBe(405)
    expect((await call("/v1/subjects/not-a-uuid", { method: "DELETE" })).status).toBe(404)
  })
})
