import type { D1Migration } from "cloudflare:test"
import type { Env as WorkerEnv } from "../../src/store"

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
