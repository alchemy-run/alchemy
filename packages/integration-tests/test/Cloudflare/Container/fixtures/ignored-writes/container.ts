import * as Cloudflare from "@alchemy.run/cloudflare";
import * as pathe from "pathe";

/**
 * A fixed build context under the suite's `.tmp` dir. The test writes the
 * Dockerfile and content, and points the run's `.alchemy` INSIDE it — the
 * `context: "."` layout from #3233.
 */
export const IGNORED_WRITES_CONTEXT_DIR = pathe.resolve(
  import.meta.dirname,
  "../../../../.tmp/container-ignored-writes-context",
);

/** Must match the port baked into the Dockerfile the test writes. */
export const IGNORED_WRITES_PORT = 17363;

export class IgnoredWritesContainer extends Cloudflare.Container<IgnoredWritesContainer>()(
  "IgnoredWritesContainer",
  {
    context: IGNORED_WRITES_CONTEXT_DIR,
    observability: { logs: { enabled: true } },
  },
) {}
