import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test"
import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import worker from "../../src/index"
import { runRetention } from "../../src/retention"
import { sha256Hex } from "../../src/store"
import {
  activeStory,
  admin,
  day,
  daysAgoIso,
  db,
  registeredSubject,
  send,
  snapshot,
  upload,
  type Story,
} from "./helpers"

async function deprecateDaysAgo(story: Story, days: number): Promise<void> {
  await admin("POST", `/v1/admin/stories/${story.storyId}/${story.version}/deprecate`)
  await db().prepare("UPDATE stories SET deprecated_at = ? WHERE story_id = ? AND version = ?")
    .bind(daysAgoIso(days), story.storyId, story.version).run()
}

async function snapshotCount(story: Story): Promise<number> {
  return (await db().prepare("SELECT COUNT(*) AS n FROM snapshots WHERE story_id = ?").bind(story.storyId).first<number>("n"))!
}

type Totals = { totals: { period: string; subjectCount: number; rows: Record<string, unknown>[] }[] }

describe("deprecated story folding", () => {
  it("folds periods with at least five subjects into totals and deletes every subject row", async () => {
    const story = await activeStory()
    const subjects = await Promise.all(Array.from({ length: 6 }, () => registeredSubject()))
    for (const [index, subject] of subjects.entries()) {
      const rows = [{ dims: { harness: "codex", initiator: "you" }, sessions: index + 1, messages: 10 }]
      if (index % 2 === 0) rows.push({ dims: { harness: "claude-code", initiator: "agent" }, sessions: 1, messages: 2 })
      await upload(subject, [snapshot(story, day(2), rows)])
    }
    // Five subjects for day 3: still at the threshold.
    for (const subject of subjects.slice(0, 5)) await upload(subject, [snapshot(story, day(3))])

    await deprecateDaysAgo(story, 31)
    const report = await runRetention(env)
    expect(report.failedStages).toEqual([])
    expect(report.periodsFolded).toBeGreaterThanOrEqual(2)
    expect(await snapshotCount(story)).toBe(0)

    const { totals } = await (await admin("GET", `/v1/admin/totals?storyId=${story.storyId}&version=1`)).json() as Totals
    expect(totals.map((total) => [total.period, total.subjectCount])).toEqual([[day(3), 5], [day(2), 6]])
    const dayTwo = totals.find((total) => total.period === day(2))!
    expect(dayTwo.rows).toEqual([
      { dims: { harness: "claude-code", initiator: "agent" }, sessions: 3, messages: 6 },
      { dims: { harness: "codex", initiator: "you" }, sessions: 21, messages: 60 },
    ])
    // Totals are subject-free.
    const raw = await db().prepare("SELECT * FROM story_totals WHERE story_id = ?").bind(story.storyId).all()
    for (const subject of subjects) expect(JSON.stringify(raw.results)).not.toContain(subject.subjectId)

    const ranged = await (await admin("GET", `/v1/admin/totals?storyId=${story.storyId}&from=${day(2)}&to=${day(2)}`)).json() as Totals
    expect(ranged.totals).toHaveLength(1)
  })

  it("drops periods with fewer than five subjects instead of keeping totals", async () => {
    const story = await activeStory()
    const subjects = await Promise.all(Array.from({ length: 4 }, () => registeredSubject()))
    for (const subject of subjects) await upload(subject, [snapshot(story, day(1)), snapshot(story, day(2))])

    await deprecateDaysAgo(story, 31)
    const report = await runRetention(env)
    expect(report.periodsSuppressed).toBeGreaterThanOrEqual(2)
    expect(await snapshotCount(story)).toBe(0)
    const totals = await db().prepare("SELECT COUNT(*) AS n FROM story_totals WHERE story_id = ?").bind(story.storyId).first<number>("n")
    expect(totals).toBe(0)
  })

  it("leaves versions deprecated for less than 30 days and active versions alone", async () => {
    const recent = await activeStory()
    const active = await activeStory()
    const subjects = await Promise.all(Array.from({ length: 5 }, () => registeredSubject()))
    for (const subject of subjects) await upload(subject, [snapshot(recent, day(1)), snapshot(active, day(1))])
    await deprecateDaysAgo(recent, 29)

    await runRetention(env)
    expect(await snapshotCount(recent)).toBe(5)
    expect(await snapshotCount(active)).toBe(5)
  })
})

describe("subject retention", () => {
  it("erases subjects inactive for 180 days like a delete, and keeps recent ones", async () => {
    const story = await activeStory()
    const stale = await registeredSubject("Old tester")
    const recent = await registeredSubject()
    await upload(stale, [snapshot(story, day(1))])
    await upload(recent, [snapshot(story, day(1))])
    await db().prepare("UPDATE subjects SET last_upload_at = ? WHERE subject_id = ?").bind(daysAgoIso(181), stale.subjectId).run()
    await db().prepare("UPDATE subjects SET last_upload_at = ? WHERE subject_id = ?").bind(daysAgoIso(179), recent.subjectId).run()

    const report = await runRetention(env)
    expect(report.inactiveSubjectsErased).toBeGreaterThanOrEqual(1)

    expect(await db().prepare("SELECT COUNT(*) AS n FROM subjects WHERE subject_id = ?").bind(stale.subjectId).first("n")).toBe(0)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM snapshots WHERE subject_id = ?").bind(stale.subjectId).first("n")).toBe(0)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM tombstones WHERE subject_hash = ?").bind(await sha256Hex(stale.subjectId)).first("n")).toBe(1)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM subjects WHERE subject_id = ?").bind(recent.subjectId).first("n")).toBe(1)

    const again = await send("POST", "/v1/subjects", { subjectId: stale.subjectId, secretHash: await sha256Hex(stale.secret), mode: "anonymous" })
    expect(again.status).toBe(410)
  })

  it("removes subjects that never uploaded after 7 days, without a tombstone", async () => {
    const empty = await registeredSubject()
    const young = await registeredSubject()
    await db().prepare("UPDATE subjects SET created_at = ? WHERE subject_id = ?").bind(daysAgoIso(8), empty.subjectId).run()
    await db().prepare("UPDATE subjects SET created_at = ? WHERE subject_id = ?").bind(daysAgoIso(6), young.subjectId).run()

    await runRetention(env)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM subjects WHERE subject_id = ?").bind(empty.subjectId).first("n")).toBe(0)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM subjects WHERE subject_id = ?").bind(young.subjectId).first("n")).toBe(1)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM tombstones WHERE subject_hash = ?").bind(await sha256Hex(empty.subjectId)).first("n")).toBe(0)
  })

  it("expires tombstones after 400 days", async () => {
    const old = await sha256Hex(crypto.randomUUID())
    const kept = await sha256Hex(crypto.randomUUID())
    await db().batch([
      db().prepare("INSERT INTO tombstones (subject_hash, erased_at) VALUES (?, ?)").bind(old, daysAgoIso(401)),
      db().prepare("INSERT INTO tombstones (subject_hash, erased_at) VALUES (?, ?)").bind(kept, daysAgoIso(399)),
    ])
    await runRetention(env)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM tombstones WHERE subject_hash = ?").bind(old).first("n")).toBe(0)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM tombstones WHERE subject_hash = ?").bind(kept).first("n")).toBe(1)
  })
})

describe("cron", () => {
  it("runs retention from the scheduled handler", async () => {
    const empty = await registeredSubject()
    await db().prepare("UPDATE subjects SET created_at = ? WHERE subject_id = ?").bind(daysAgoIso(30), empty.subjectId).run()

    const context = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: "23 3 * * *" }), env, context)
    await waitOnExecutionContext(context)
    expect(await db().prepare("SELECT COUNT(*) AS n FROM subjects WHERE subject_id = ?").bind(empty.subjectId).first("n")).toBe(0)
  })
})
