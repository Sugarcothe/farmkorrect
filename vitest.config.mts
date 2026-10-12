import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${root}/` },
      // the real package throws outside React Server Components
      { find: /^server-only$/, replacement: `${root}/tests/support/empty.ts` },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/support/setup.ts"],
    // one in-memory replica set per file; argon2 hashing is deliberately slow
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
