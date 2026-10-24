import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

// Same value as ADMIN_KEY in test/worker/helpers.ts.
const TEST_ADMIN_KEY = "test-admin-key-0123456789abcdef"

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations")
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml" },
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations, USAGE_ADMIN_API_KEY: TEST_ADMIN_KEY },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            setupFiles: ["./test/worker/apply-migrations.ts"],
          },
        },
        {
          test: {
            name: "node",
            environment: "node",
            include: ["test/node/**/*.test.ts"],
          },
        },
      ],
    },
  }
})
