import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

interface RawFixture {
  name: string
  valid: boolean
  layer?: "schema" | "story"
  value?: unknown
  patch?: Record<string, unknown>
  omit?: string[]
}

export interface Fixture {
  name: string
  valid: boolean
  layer: "schema" | "story" | null
  value: Record<string, unknown>
}

const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/conformance.json", import.meta.url)), "utf8")) as {
  now: string
  referenceStory: Record<string, unknown>
  stories: RawFixture[]
  snapshots: RawFixture[]
}

/** Expands `patch`/`omit` fixtures against the first full value in the list. */
function expand(list: RawFixture[]): Fixture[] {
  const resolve = (value: unknown) => value === "$referenceStory" ? raw.referenceStory : value as Record<string, unknown>
  const base = resolve(list.find((fixture) => fixture.value !== undefined)!.value)
  return list.map((fixture) => {
    let value = fixture.value !== undefined ? resolve(fixture.value) : { ...base, ...fixture.patch }
    if (fixture.omit) value = Object.fromEntries(Object.entries(value).filter(([key]) => !fixture.omit!.includes(key)))
    return { name: fixture.name, valid: fixture.valid, layer: fixture.layer ?? null, value: structuredClone(value) }
  })
}

export const now = new Date(raw.now)
export const referenceStory = raw.referenceStory
export const storyFixtures = expand(raw.stories)
export const snapshotFixtures = expand(raw.snapshots)
