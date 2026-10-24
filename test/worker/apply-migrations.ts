import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"

await applyD1Migrations(env.USAGE_DB, env.TEST_MIGRATIONS)
