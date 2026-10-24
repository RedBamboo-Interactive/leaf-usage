# Leaf Usage Insights ingestion

Publisher-owned ingestion Worker for RedLeaf Usage Insights (`usage.minititine.cc`). Opted-in
installations register a pseudonymous subject and upload one content-free daily snapshot per usage
story: enum dimensions and bounded integers, nothing else. The Worker accepts only snapshots that
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
- Each row is `{ dims, <every measure> }`. `dims` names exactly the story's dimensions, each value a
  member of its enum, so a string outside an enum can never be stored. Measures are integers from 0
  to the measure's `max`. Dimension combinations are unique and all-zero rows are refused (zero rows
  are omitted by contract). An empty `rows` array is a valid "nothing to report" day.
- Rows are stored canonically (definition key order, sorted by dimension values), so retries
  compare byte for byte.

### Admin

`Authorization: Bearer <USAGE_ADMIN_API_KEY>`, compared in constant time.

| Route | Behaviour |
|---|---|
| `PUT /v1/admin/stories/{id}/{version}` | activate a definition (`usage-story.schema.json`); `201 activated`, `200 unchanged` when identical, `409` when the version exists with a different definition |
| `POST /v1/admin/stories/{id}/{version}/deprecate` | deprecate now; uploads become `story_inactive` |
| `GET /v1/admin/subjects` | subject id, mode, label, created and last upload (max 1000, `truncated` flag) |
| `GET /v1/admin/snapshots?storyId=&version=&from=&to=&subject=` | subject-level rows (max 5000, `truncated` flag) |
| `GET /v1/admin/totals?storyId=&version=&from=&to=` | subject-free aggregates kept after deprecation |

Story versions are immutable. The stored definition is a canonical serialization without `status`
(lifecycle lives in the `stories.status` column), so "byte-identical" means identical after
canonicalization: key order and whitespace do not matter, every value and array order does. A
deprecated version is never revived, and a definition submitted as `deprecated` is accepted only
when that version already exists. The catalogue returns each definition in schema shape with the
live `status`.

## Retention (daily cron, 03:23 UTC)

Each run does bounded work (`src/retention.ts`, `RETENTION`); leftovers are handled the next day.
Stages run independently so one failure cannot block the erasures after it.

- Deprecated story versions, 30 days after deprecation: each period with at least 5 distinct subjects
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

Not done yet; Nova reviews first. In order:

```powershell
npm install
npm test
npx wrangler d1 create leaf-usage --jurisdiction eu
.\scripts\provision.ps1 -DatabaseId <D1 id>
npx wrangler secret put USAGE_ADMIN_API_KEY
npm run migrate:remote
npm run deploy
```

The Worker owns the custom domain `usage.minititine.cc` (`workers_dev` and preview URLs are off).
The admin key is entered once in the Insights extension settings on Laurent's installation and in
Release Manager. After deploying, run the Phase 1 exit probe (throwaway story and subject, delete,
verify through the admin API that nothing remains).

## Data location

Wrangler 4.152 `d1 create` offers:

- `--jurisdiction eu`: the database runs and stores data only inside the EU. It overrides any
  location hint and cannot be changed after creation.
- `--location weur|eeur`: a placement hint only, with no guarantee.

Planned: `--jurisdiction eu`. To fill at provisioning:

- D1 database id: _TBD_
- Jurisdiction / location actually applied: _TBD_ (confirm in the dashboard or `wrangler d1 info leaf-usage`)
- Date provisioned: _TBD_

The Worker code itself runs at the Cloudflare edge closest to each caller; the jurisdiction governs
where the D1 data is stored and processed.
