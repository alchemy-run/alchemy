import type { Limit } from "@alchemy.run/test";

/**
 * Bound concurrency across live Render suites so parallel test files stay under
 * Render's REST API rate limit.
 */
export const renderApi: Limit = {
  label: "render-api",
  permits: Number(process.env.ALCHEMY_TEST_RENDER_PERMITS ?? 1),
};
