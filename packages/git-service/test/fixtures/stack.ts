/**
 * Shared test-stack fixture for the git-service suites (DESIGN.md §9).
 *
 * git-service ships no Stack of its own — {@link GitService} is a function
 * returning an Effect that users instantiate inside their own
 * `Alchemy.Stack`, and these suites do exactly that. Every suite deploys
 * under its own stack name so concurrently-running suites never share (or
 * race on) a deployment. The local dev suite composes its own Stack with
 * `Alchemy.localState()` directly in the test file.
 *
 * The Worker resolves its admin secret from the deployer environment via
 * `Config.redacted("GIT_SERVICE_ADMIN_TOKEN")` at deploy time. So that suites
 * work out of the box (local dev especially), a deterministic default is
 * installed into `process.env` at module load — before any deploy plans run —
 * unless the caller already exported one.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { ADMIN_TOKEN_CONFIG_KEY } from "../../src/GitWorker.ts";
import { GitService } from "../../src/Service.ts";

/**
 * The admin key every suite authenticates with. Honors a caller-provided
 * `GIT_SERVICE_ADMIN_TOKEN` (the deployed-cloud suites may point at a
 * standing deployment); otherwise a deterministic test-only value.
 */
export const TEST_ADMIN_TOKEN: string =
  process.env[ADMIN_TOKEN_CONFIG_KEY] ?? "gs_test-admin-key-git-service-suite";

// Installed at module load (test collection time), before any deploy resolves
// `Config.redacted(ADMIN_TOKEN_CONFIG_KEY)`. `??=` keeps a caller-exported
// value authoritative.
process.env[ADMIN_TOKEN_CONFIG_KEY] ??= TEST_ADMIN_TOKEN;

/**
 * Builds the deployable test stack under a suite-specific name.
 *
 * @example
 * ```typescript
 * const Stack = makeTestStack("GitServiceTestStack");
 * const stack = beforeAll(deploy(Stack));
 * afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));
 * ```
 */
export const makeTestStack = (name: string) =>
  Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
      const git = yield* GitService();
      return { url: git.url };
    }),
  );
