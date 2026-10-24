import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  canonicalStoryJson,
  parseUtcDay,
  storyShapeJson,
  sumRows,
  validateRegistration,
  validateSnapshot,
  validateStoryDefinition,
  type StoryDefinition,
} from "../../src/contracts"
import { now, referenceStory, snapshotFixtures, storyFixtures } from "./fixtures"

const story = (() => {
  const result = validateStoryDefinition(referenceStory)
  if (!result.ok) throw new Error(result.message)
  return result.value.definition
})()

describe("story definitions", () => {
  it.each(storyFixtures.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    expect(validateStoryDefinition(fixture.value).ok).toBe(fixture.valid)
  })

  it("serializes equal definitions to identical bytes regardless of key order or status", () => {
    const reordered = Object.fromEntries(Object.entries(referenceStory).reverse())
    reordered.status = "deprecated"
    const result = validateStoryDefinition(reordered)
    expect(result.ok).toBe(true)
    if (result.ok) expect(canonicalStoryJson(result.value.definition)).toBe(canonicalStoryJson(story))
    expect(canonicalStoryJson(story)).not.toContain("status")
  })
})

describe("snapshots", () => {
  it.each(snapshotFixtures.map((fixture) => [fixture.name, fixture] as const))("%s", (_name, fixture) => {
    expect(validateSnapshot(fixture.value, story, now).ok).toBe(fixture.valid)
  })

  it("rejects a snapshot for another story version", () => {
    const valid = snapshotFixtures.find((fixture) => fixture.valid)!.value
    expect(validateSnapshot({ ...valid, storyVersion: 2 }, story, now).ok).toBe(false)
  })

  it("rejects prototype keys smuggled through JSON", () => {
    const input = JSON.parse(`{"schemaVersion":1,"snapshotId":"6f1f9a52-5b0e-4c3a-9d55-0d6f3c1b2a10","storyId":"ai-harness","storyVersion":1,"period":"2026-10-24","rows":[{"dims":{"harness":"codex","initiator":"you","__proto__":{"x":1}},"sessions":1,"messages":1}]}`)
    expect(validateSnapshot(input, story, now).ok).toBe(false)
  })
})

describe("closed days", () => {
  const valid = snapshotFixtures.find((fixture) => fixture.valid)!.value
  const at = (period: string, time: string) => validateSnapshot({ ...valid, period }, story, new Date(time))

  it("refuses today even at 23:59:59.999 UTC", () => {
    expect(at("2026-10-25", "2026-10-25T23:59:59.999Z")).toEqual({ ok: false, message: "period must be a closed UTC day." })
    expect(at("2026-10-24", "2026-10-25T23:59:59.999Z").ok).toBe(true)
  })

  it("accepts yesterday from 00:00:00 UTC", () => {
    expect(at("2026-10-25", "2026-10-26T00:00:00.000Z").ok).toBe(true)
    expect(at("2026-10-26", "2026-10-26T00:00:00.000Z").ok).toBe(false)
  })

  it("keeps the backfill window: backfillDays + 7 days back, inclusive", () => {
    expect(at("2026-09-18", "2026-10-25T00:00:00.000Z").ok).toBe(true)
    expect(at("2026-09-17", "2026-10-25T23:59:59.999Z").ok).toBe(false)
  })
})

describe("dates", () => {
  it.each([
    ["2026-10-24", true], ["2024-02-29", true], ["2026-02-29", false], ["2026-13-01", false],
    ["2026-1-01", false], ["2026-10-24T00:00:00Z", false], [20261024, false],
  ] as const)("%s -> %s", (value, valid) => {
    expect(parseUtcDay(value) !== null).toBe(valid)
  })
})

describe("totals", () => {
  it("sums measures per dimension combination", () => {
    const rows = sumRows([
      [{ dims: { harness: "codex", initiator: "you" }, sessions: 1, messages: 2 }],
      [{ dims: { initiator: "you", harness: "codex" }, sessions: 3, messages: 4 }, { dims: { harness: "other", initiator: "agent" }, sessions: 1, messages: 1 }],
    ])
    expect(rows).toEqual([
      { dims: { harness: "codex", initiator: "you" }, sessions: 4, messages: 6 },
      { dims: { harness: "other", initiator: "agent" }, sessions: 1, messages: 1 },
    ])
  })

  it("keeps rows accepted under different shapes apart instead of reinterpreting them", () => {
    const rows = sumRows([
      [{ dims: { harness: "codex", initiator: "you" }, sessions: 1, messages: 2 }],
      [{ dims: { harness: "codex" }, sessions: 5 }],
    ])
    expect(rows).toEqual([
      { dims: { harness: "codex", initiator: "you" }, sessions: 1, messages: 2 },
      { dims: { harness: "codex" }, sessions: 5 },
    ])
  })
})

describe("shape hash", () => {
  // The same golden value is asserted by RedLeaf's collector tests (UsageStoryShape), so both
  // sides hash a definition identically.
  it("is the SHA-256 of the canonical shape JSON, ignoring wording", async () => {
    const shape = storyShapeJson(story)
    expect(shape).toBe('{"schemaVersion":1,"storyId":"ai-harness","version":1,"period":"day","backfillDays":30,"dimensions":[{"key":"harness","values":["claude-code","codex","opencode","other"]},{"key":"initiator","values":["you","agent"]}],"measures":[{"key":"sessions","type":"count","max":10000},{"key":"messages","type":"count","max":1000000}],"clientObservations":[]}')
    expect(createHash("sha256").update(shape).digest("hex")).toBe("0dd0eb8b1400abff30e123d6396b0620fa75d593a59ae51f6d38334a82b2fef5")
    const reworded: StoryDefinition = { ...story, question: "Another question?", shares: "Something else.", introducedIn: "9.9.9" }
    expect(storyShapeJson(reworded)).toBe(shape)
    expect(storyShapeJson({ ...story, backfillDays: 7 })).not.toBe(shape)
  })
})

describe("story version", () => {
  it("is fixed at 1", () => {
    expect(validateStoryDefinition({ ...referenceStory, version: 2 })).toEqual({ ok: false, message: "version is fixed at 1; edit the story in place instead." })
  })
})

describe("registration", () => {
  const base = { subjectId: "6F1F9A52-5B0E-4C3A-9D55-0D6F3C1B2A10", secretHash: "a".repeat(64) }
  it("normalises the subject id", () => {
    const result = validateRegistration({ ...base, mode: "anonymous" })
    expect(result.ok && result.value.subjectId).toBe(base.subjectId.toLowerCase())
  })
  it("trims labels and allows digits", () => {
    const result = validateRegistration({ ...base, mode: "named", label: "  Juju 2028  " })
    expect(result.ok && result.value.label).toBe("Juju 2028")
  })
  it.each(["Ju\nju", "Ju\u2028ju", "\u0085"])("refuses control characters (%j)", (label) => {
    expect(validateRegistration({ ...base, mode: "named", label }).ok).toBe(false)
  })
})
