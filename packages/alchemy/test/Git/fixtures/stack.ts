/**
 * Shared test-stack fixture for the git-service suites (DESIGN.md §9).
 *
 * git-service ships no Worker of its own — the package exports building
 * blocks (`Server`, `ServerLive`, `ReposDurableObject`,
 * `RegistryDurableObject`, …) that users assemble into their own
 * `Cloudflare.Worker`. This fixture is exactly that assembly: the same
 * shape the example app and the RFC's headline snippet use.
 *
 * Every suite deploys under its own stack name so concurrently-running
 * suites never share (or race on) a deployment.
 *
 * The Worker resolves its admin secret from the deployer environment via
 * `Config.redacted("GIT_SERVICE_ADMIN_TOKEN")` at deploy time. So that suites
 * work out of the box (local dev especially), a deterministic default is
 * installed into `process.env` at module load — before any deploy plans run —
 * unless the caller already exported one.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ADMIN_TOKEN_CONFIG_KEY,
  AuthTokens,
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  HasherSelf,
  ReposDurableObject,
  RegistryDurableObject,
  Server,
  ServerLive,
} from "@/Git/index.ts";

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

/** The suites' bucket — owned by the assembly, like any user's. */
const GitObjects = Cloudflare.R2.Bucket("GitObjects", {
  // Test stacks must tear down even with packs/bundles/head snapshots
  // still in the bucket (the e2e benches leave repos behind by design).
  forceDestroy: true,
});

/** One layer graph, one Effect.provide — the RFC assembly, verbatim. */
const GitLive = ServerLive.pipe(
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(BlobStoreR2(GitObjects)),
  Layer.provide(HasherSelf),
  Layer.provide(AuthTokens),
);

/** The suites' git host: the reference building-block assembly. */
export default class TestGitHost extends Cloudflare.Worker<TestGitHost>()(
  "GitWorker",
  {
    main: import.meta.url,
    ...GIT_WORKER_OPTIONS,
    observability: { enabled: true },
  },
  Effect.gen(function* () {
    const git = yield* Server;
    return { fetch: git.fetch };
  }).pipe(Effect.provide(GitLive)),
) {}

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
      const host = yield* TestGitHost;
      return { url: host.url.as<string>() };
    }),
  );
