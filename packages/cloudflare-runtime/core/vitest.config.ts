import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Some binding sims are timing-sensitive (real Chrome launches, queue
    // delivery delays) and the small CI runners run the whole 460+-test suite
    // under load — absorb runner starvation the same way the fixture
    // playwright configs do (`retries: CI ? 2 : 0`). Tests that must be
    // deterministic (e.g. RateLimit) opt out with a per-test `{ retry: 0 }`.
    retry: process.env.CI ? 2 : 0,
    // The Windows CI runner is resource-constrained; unbounded file
    // parallelism starves the event loop while many `workerd` processes spawn
    // at once — that inflates wall-clock time for timing-sensitive tests
    // (e.g. queue delivery delays) and pushes layer setup/teardown hooks past
    // their timeout. But fully serial files cost ~4m45s wall, making this
    // suite the critical path of the whole CI job. Two bounded forks keep
    // peak load manageable while roughly halving the wall-clock.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
  },
});
