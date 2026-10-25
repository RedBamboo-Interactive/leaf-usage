# Leaf Usage Insights ingestion

Publisher-owned ingestion Worker for RedLeaf Usage Insights (`usage.minititine.cc`). Opted-in
installations register a pseudonymous subject and upload one content-free daily snapshot per usage
story: enum (or strictly formatted) dimensions and bounded integers, nothing else. The Worker accepts only snapshots that
match an active story version, erases a subject completely on request, and ages data out on a daily
cron. Laurent's Insights extension reads it through the admin API; there is no other copy.

Design: `redleaf/docs/usage-insights-architecture.md` ("Ingestion Worker") and
`redleaf/docs/usage-insights-implementation-plan.md` (Phase 1).

No IP address, user agent or `request.cf` data is stored. The client address is used only as the
key of the Cloudflare rate-limit binding on registration and uploads.

## Routes

Bodies are JSON, at most 64 KB. Every object is strict: unknown keys are rejected at every level.
Errors are `{ "error": "<code>", "message": "..." }`.

### Public

| Route | Auth | Behaviour |
|---|---|---|
| `GET /v1/catalogue` | none, CORS | `{ stories: [{ storyId, version, status, activatedAt, deprecatedAt, definition }] }`, active and deprecated |
| `POST /v1/subjects` | none, rate limited | register `{ subjectId, secretHash, mode, label? }` |
| `PUT /v1/subjects/{id}` | subject bearer | `{ mode, label? }`; switching to `anonymous` nulls the label |
| `POST /v1/snapshots` | subject bearer, rate limited | `{ subjectId, snapshots: [1..50] }` → `{ results: [{ index, snapshotId, status, message? }] }` |
| `DELETE /v1/subjects/{id}` | subject bearer | erases the subject and every snapshot, writes a tombstone, returns the receipt |

- `subjectId` is a UUID (stored lowercase). `secretHash` is the lowercase hex SHA-256 of the exact
  UTF-8 string the installation later sends as `Authorization: Bearer <secret>`. The Worker hashes
  the bearer and compares it with the stored hash in constant time.
- `mode` is `anonymous` (no label) or `named` (label of 1-40 printable characters).
- Registration is idempotent for the same `subjectId`, hash, mode and label (`200`); a different
  registration for an existing id is `409 subject_exists`; a tombstoned id is `410 subject_erased`.
- Subject routes answer `401 unauthorized` for a missing or wrong secret, `404 subject_not_found`
  for an id that is not registered (re-register), and `410 subject_erased` for an erased id.
- Per-item upload results: `accepted`, `duplicate` (identical retry of an accepted snapshot),
  `story_inactive` (story version unknown or deprecated) or `invalid` (with a `message`). First write
  wins: a different payload for the same subject, story version and period is `invalid`.
- Erasure receipt: `{ status: "erased", subjectId, erasedAt, snapshotsDeleted, tombstone }`, where
  `tombstone` is the SHA-256 of the lowercase subject id, the only trace that remains.

### Snapshot validation

The stored story definition drives validation (`src/contracts.ts`):

- Snapshot shape per `schemas/usage-snapshot.schema.json`: `schemaVersion` 1, lowercase UUID
  `snapshotId`, `storyId`, `storyVersion`, `period`, `rows`.
- `period` is a real `YYYY-MM-DD` closed UTC day: before today (UTC), because first write wins and a
  partial day would lock the period, and not older than the story's `backfillDays` + 7 days.
- A story dimension is exactly `{ key, values }` (a closed enum) or exactly `{ key, format }`. There
  are two formats. `release-version`: a value must be a release number matching
  `^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$` or the literal `unknown`.
  `git-commit`: a value must be a short commit matching `^[0-9a-f]{7}$` or the literal `none`.
  Both, neither, or an unknown format are refused at activation. The format is part of the shape
  hash, so changing it is a shape change; stories without formats hash exactly as before.
- Each row is `{ dims, <every measure> }`. `dims` names exactly the story's dimensions, each value a
  member of its enum or of its format, so free text can never be stored. Measures are integers from 0
  to the measure's `max`. Dimension combinations are unique and all-zero rows are refused (zero rows
  are omitted by contract). An empty `rows` array is a valid "nothing to report" day.
- Rows are stored canonically (definition key order, sorted by dimension values), so retries
  compare byte for byte.

### Admin

`Authorization: Bearer <USAGE_ADMIN_API_KEY>`, compared in constant time.

| Route | Behaviour |
|---|---|
| `PUT /v1/admin/stories/{id}/1` | activate or edit a story (`usage-story.schema.json`); `201 activated`, `200 unchanged`, `200 updated` |
| `GET /v1/admin/stories/{id}/history` | read-only: the current definition and every previous one, newest first, each with its shape hash |
| `POST /v1/admin/stories/{id}/1/deprecate` | deprecate now; uploads become `story_inactive` |
| `GET /v1/admin/subjects` | subject id, mode, label, created and last upload (max 1000, `truncated` flag) |
| `GET /v1/admin/snapshots?storyId=&version=&from=&to=&subject=` | subject-level rows with their `shapeHash` (max 5000, `truncated` flag) |
| `GET /v1/admin/totals?storyId=&version=&from=&to=` | subject-free aggregates kept after deprecation |

A story is one thing, edited in place: its wire `version` is fixed at 1 (any other value is
refused), and there are no version bumps. Re-activating an existing story:

- Identical definition: `200 unchanged`.
- Any other definition, wording or data shape: the stored definition is replaced in place and the
  previous one is appended to `story_definitions_history`. The answer is
  `200 { result: "updated", updatedAt, shapeChanged, story }`; status and `activatedAt` are
  untouched, and the catalogue serves the new definition from then on.

Uploads are always validated against the current definition, so a lagging installation's old-shape
snapshots are rejected as `invalid`; RedLeaf's collector recalculates those days from local history
once it has updated. The **shape hash** is the SHA-256 of the canonical data shape (`storyId`,
`version`, `period`, `backfillDays`, `dimensions`, `measures`, `clientObservations`, in that order,
without the wording; `storyShapeJson`). A format dimension is written `{"key":...,"format":...}`, so
the format is part of the shape; enum dimensions are written `{"key":...,"values":[...]}` as before. It is recorded on every accepted snapshot (`snapshots.shape_hash`,
NULL for rows accepted before migration 0002) and on every history row, so each answer row can be tied
to the definition it was accepted under. RedLeaf computes the same hash for its outbox rows. Nothing
else depends on the history.

The stored definition is a canonical serialization without `status` (lifecycle lives in the
`stories.status` column). A deprecated story is never revived (it can still be edited), and a
definition submitted as `deprecated` is accepted only when the story already exists. The catalogue
returns each definition in schema shape with the live `status`. Retention folds a deprecated story's
periods by each row's own dimensions, so periods spanning a shape change are summed without
reinterpreting older rows.

## Retention (daily cron, 03:23 UTC)

Each run does bounded work (`src/retention.ts`, `RETENTION`); leftovers are handled the next day.
Stages run independently so one failure cannot block the erasures after it.

- Deprecated stories, 30 days after deprecation: each period with at least 5 distinct subjects
  is summed into `story_totals` (dimension combination → summed measures, plus `subject_count`);
  periods with fewer subjects are dropped. All subject-level rows of the period are deleted in the
  same transaction.
- Subjects with no upload for 180 days are erased like a Delete (tombstone written).
- Subjects that registered but never uploaded are removed after 7 days, without a tombstone, so the
  installation can register the same id again once it has something to send.
- Tombstones expire after 400 days.

## Schemas

`schemas/*.json` are copies of RedLeaf's generated `schemas/usage/v1/*.json`:

```powershell
npm run sync-schemas            # copy from ../redleaf (or $env:REDLEAF_DIR)
npm run check-schemas           # fail if the copy differs
```

`test/node/schemas.test.ts` fails when the copy differs from a sibling `../redleaf` checkout, and
checks that the Worker validator and the schemas agree on `test/fixtures/conformance.json`.

## Local development

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars   # then set USAGE_ADMIN_API_KEY
npm run migrate:local
npm run dev
```

`.npmrc` sets `legacy-peer-deps` because npm 11.5 crashes resolving Vitest 4's optional peers.

## Tests

```powershell
npm run typecheck
npm test
```

`test/worker` runs inside workerd with a local D1 through `@cloudflare/vitest-plugin` (migrations
applied in `test/worker/apply-migrations.ts`): registration, uploads, duplicates, inactive stories,
validation, bearer auth, deletion and tombstones, rate limiting, admin routes and every retention
rule. `test/node` covers the pure validator and the schema conformance.

## Provisioning and deploy

Provisioned and deployed on 2026-10-24. The steps, for reference or a rebuild:

```powershell
npm install
npm test
npx wrangler d1 create leaf-usage --jurisdiction eu
.\scripts\provision.ps1 -DatabaseId <D1 id>
# USAGE_ADMIN_API_KEY: 32 random bytes, base64url, piped over stdin and kept in the gitignored .dev.vars
npx wrangler secret put USAGE_ADMIN_API_KEY
npm run migrate:remote
npm run deploy
npm run probe
```

The Worker owns the custom domain `usage.minititine.cc` (`workers_dev` and preview URLs are off).
The admin key is entered once in the Insights extension settings on Laurent's installation and in
Release Manager.

`npm run probe` (`scripts/probe.mjs`) is the Phase 1 exit probe. It reads the admin key from
`.dev.vars` without printing it, activates the throwaway story `probe-check` v1, registers a
throwaway subject, uploads yesterday's snapshot (`accepted`, then `duplicate`), deletes the subject,
checks the receipt, the erasure through the admin API and the `410` on re-registration, then removes
the story row and tombstone with `wrangler d1 execute --remote` and shows the public catalogue.

## Data location

- D1 database `leaf-usage`, id `ebccb94a-5546-4736-b671-09818d1df5ec`, on Laurent's Cloudflare account.
- Created on 2026-10-24 (13:33:50 UTC) with `--jurisdiction eu`. `wrangler d1 info leaf-usage`
  reports `"jurisdiction": "eu"`, `"running_in_region": "EEUR"`, read replication disabled.

The EU jurisdiction keeps the database's execution and storage inside the European Union and cannot
be changed after creation. Wrangler 4.152 also offers a `--location` hint, which gives no guarantee
and is ignored when a jurisdiction is set. The Worker code itself runs at the Cloudflare edge closest
to each caller; the jurisdiction governs where the D1 data is stored and processed.
