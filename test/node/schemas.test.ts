import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { describe, expect, it } from "vitest"
import { validateSnapshot, validateStoryDefinition } from "../../src/contracts"
import { now, referenceStory, snapshotFixtures, storyFixtures, type Fixture } from "./fixtures"

// RedLeaf generates schemas/usage/v1/*.schema.json from its C# contracts; scripts/sync-schemas.mjs
// copies them into ./schemas. These tests are skipped (visibly) until the copy exists.
const root = fileURLToPath(new URL("../..", import.meta.url))
const copied = join(root, "schemas")
const source = resolve(process.env.REDLEAF_DIR ?? join(root, "..", "redleaf"), "schemas", "usage", "v1")
const STORY_SCHEMA = "usage-story.schema.json"
const SNAPSHOT_SCHEMA = "usage-snapshot.schema.json"

const jsonFiles = (directory: string) => existsSync(directory)
  ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
  : []

const hasCopy = jsonFiles(copied).length > 0
const hasSource = jsonFiles(source).length > 0

describe.skipIf(!hasSource)("schema sync with the RedLeaf checkout", () => {
  it("schemas/ is an exact copy of redleaf/schemas/usage/v1 (run npm run sync-schemas)", () => {
    expect(jsonFiles(copied)).toEqual(jsonFiles(source))
    for (const name of jsonFiles(source)) {
      expect(readFileSync(join(copied, name), "utf8"), name).toBe(readFileSync(join(source, name), "utf8"))
    }
  })
})

describe.skipIf(!hasCopy)("validator conformance with the copied schemas", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  addFormats(ajv)
  const compiled = new Map<string, ValidateFunction>()
  const load = (name: string) => {
    if (!compiled.has(name)) {
      const path = join(copied, name)
      if (!existsSync(path)) throw new Error(`schemas/${name} is missing; RedLeaf's schema names changed?`)
      compiled.set(name, ajv.compile(JSON.parse(readFileSync(path, "utf8"))))
    }
    return compiled.get(name)!
  }
  const story = validateStoryDefinition(referenceStory)
  if (!story.ok) throw new Error(story.message)

  const cases = (fixtures: Fixture[]) => fixtures.map((fixture) => [fixture.name, fixture] as const)

  it.each(cases(storyFixtures))("story: %s", (_name, fixture) => {
    const schemaValid = load(STORY_SCHEMA)(fixture.value)
    const ours = validateStoryDefinition(fixture.value).ok
    if (fixture.valid) {
      expect(schemaValid, "schema rejects a valid fixture").toBe(true)
      expect(ours).toBe(true)
    } else {
      expect(ours).toBe(false)
      if (fixture.layer === "schema") expect(schemaValid, "schema accepts a structurally invalid fixture").toBe(false)
    }
  })

  it.each(cases(snapshotFixtures))("snapshot: %s", (_name, fixture) => {
    const schemaValid = load(SNAPSHOT_SCHEMA)(fixture.value)
    const ours = validateSnapshot(fixture.value, story.value.definition, now).ok
    if (fixture.valid) {
      expect(schemaValid, "schema rejects a valid fixture").toBe(true)
      expect(ours).toBe(true)
    } else {
      expect(ours).toBe(false)
      if (fixture.layer === "schema") expect(schemaValid, "schema accepts a structurally invalid fixture").toBe(false)
    }
  })
})

describe("schema copy status", () => {
  it("reports whether the RedLeaf schemas are available", () => {
    if (!hasCopy) console.warn(`No copied schemas in ${copied}; conformance tests skipped. Run npm run sync-schemas once RedLeaf generates them.`)
    expect(true).toBe(true)
  })
})
