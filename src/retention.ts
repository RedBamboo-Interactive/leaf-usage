import { sumRows, type SnapshotRow } from "./contracts.js"
import { eraseSubject, type Env, type StoryRow } from "./store.js"

const DAY_MS = 86_400_000

export const RETENTION = {
  deprecatedFoldAfterDays: 30,
  minimumCohort: 5,
  inactiveSubjectDays: 180,
  neverUploadedDays: 7,
  tombstoneDays: 400,
  // Bounded work per cron run; anything left over is picked up the next day.
  foldPeriodsPerRun: 60,
  eraseSubjectsPerRun: 100,
  deleteRowsPerRun: 500,
} as const

export interface RetentionReport {
  periodsFolded: number
  periodsSuppressed: number
  inactiveSubjectsErased: number
  emptySubjectsRemoved: number
  tombstonesExpired: number
  failedStages: string[]
}

function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}

/**
 * Folds deprecated story versions into subject-free totals. A period is kept as a total only when
 * at least five distinct subjects reported it; smaller cohorts are dropped. Either way, every
 * subject-level row of the period is deleted in the same transaction.
 */
async function foldDeprecated(env: Env, now: Date, report: RetentionReport): Promise<void> {
  const versions = await env.USAGE_DB.prepare(`
    SELECT s.* FROM stories s
    WHERE s.status = 'deprecated' AND s.deprecated_at <= ?
      AND EXISTS (SELECT 1 FROM snapshots n WHERE n.story_id = s.story_id AND n.story_version = s.version)
    ORDER BY s.deprecated_at
  `).bind(daysAgo(now, RETENTION.deprecatedFoldAfterDays)).all<StoryRow>()

  let budget: number = RETENTION.foldPeriodsPerRun
  for (const story of versions.results) {
    if (budget <= 0) return
    const periods = await env.USAGE_DB.prepare(`
      SELECT period, COUNT(*) AS subjects FROM snapshots
      WHERE story_id = ? AND story_version = ?
      GROUP BY period ORDER BY period LIMIT ?
    `).bind(story.story_id, story.version, budget).all<{ period: string; subjects: number }>()

    for (const { period, subjects } of periods.results) {
      budget--
      const remove = env.USAGE_DB.prepare(
        "DELETE FROM snapshots WHERE story_id = ? AND story_version = ? AND period = ?",
      ).bind(story.story_id, story.version, period)

      if (subjects < RETENTION.minimumCohort) {
        await remove.run()
        report.periodsSuppressed++
        continue
      }

      const rows = await env.USAGE_DB.prepare(
        "SELECT subject_id, rows_json FROM snapshots WHERE story_id = ? AND story_version = ? AND period = ?",
      ).bind(story.story_id, story.version, period).all<{ subject_id: string; rows_json: string }>()
      const distinct = new Set(rows.results.map((row) => row.subject_id)).size
      const totals = sumRows(rows.results.map((row) => JSON.parse(row.rows_json) as SnapshotRow[]))
      await env.USAGE_DB.batch([
        env.USAGE_DB.prepare(`
          INSERT INTO story_totals (story_id, story_version, period, rows_json, subject_count)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (story_id, story_version, period) DO NOTHING
        `).bind(story.story_id, story.version, period, JSON.stringify(totals), distinct),
        remove,
      ])
      report.periodsFolded++
    }
  }
}

async function eraseInactive(env: Env, now: Date, report: RetentionReport): Promise<void> {
  const subjects = await env.USAGE_DB.prepare(`
    SELECT subject_id FROM subjects
    WHERE last_upload_at IS NOT NULL AND last_upload_at < ?
    ORDER BY last_upload_at LIMIT ?
  `).bind(daysAgo(now, RETENTION.inactiveSubjectDays), RETENTION.eraseSubjectsPerRun).all<{ subject_id: string }>()
  for (const subject of subjects.results) {
    await eraseSubject(env, subject.subject_id, now)
    report.inactiveSubjectsErased++
  }
}

/**
 * Subjects that registered but never uploaded hold nothing but a label; they are removed without a
 * tombstone so the installation can register the same subject again when it has something to send.
 */
async function removeNeverUploaded(env: Env, now: Date, report: RetentionReport): Promise<void> {
  const result = await env.USAGE_DB.prepare(`
    DELETE FROM subjects WHERE subject_id IN (
      SELECT subject_id FROM subjects
      WHERE last_upload_at IS NULL AND created_at < ?
      ORDER BY created_at LIMIT ?
    ) AND last_upload_at IS NULL
  `).bind(daysAgo(now, RETENTION.neverUploadedDays), RETENTION.deleteRowsPerRun).run()
  report.emptySubjectsRemoved += result.meta.changes ?? 0
}

async function expireTombstones(env: Env, now: Date, report: RetentionReport): Promise<void> {
  const result = await env.USAGE_DB.prepare(`
    DELETE FROM tombstones WHERE subject_hash IN (
      SELECT subject_hash FROM tombstones WHERE erased_at < ? ORDER BY erased_at LIMIT ?
    )
  `).bind(daysAgo(now, RETENTION.tombstoneDays), RETENTION.deleteRowsPerRun).run()
  report.tombstonesExpired += result.meta.changes ?? 0
}

export async function runRetention(env: Env, now = new Date()): Promise<RetentionReport> {
  const report: RetentionReport = {
    periodsFolded: 0,
    periodsSuppressed: 0,
    inactiveSubjectsErased: 0,
    emptySubjectsRemoved: 0,
    tombstonesExpired: 0,
    failedStages: [],
  }
  // Stages are independent: a failure in one (for example a malformed stored row) must not
  // block the erasures that follow it.
  const stages = { foldDeprecated, eraseInactive, removeNeverUploaded, expireTombstones }
  for (const [name, stage] of Object.entries(stages)) {
    try {
      await stage(env, now, report)
    } catch (caught) {
      console.error("usage retention stage failed", name, caught instanceof Error ? caught.message : "unknown")
      report.failedStages.push(name)
    }
  }
  return report
}
