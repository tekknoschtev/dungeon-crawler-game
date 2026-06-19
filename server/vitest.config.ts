import { defineConfig } from "vitest/config";

// Server unit tests run in a plain Node environment. We test the pure game
// logic (logic.ts) and the seeded map generator (map.ts) — no Colyseus room or
// network needed. Test files live next to the code as *.test.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
