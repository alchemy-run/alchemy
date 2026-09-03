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
 * `Config.redacted("GIT_SERVICE_SECRET")` at deploy time. So that suites
 * work out of the box (local dev especially), a deterministic default is
 * installed into `process.env` at module load — before any deploy plans run —
 * unless the caller already exported one.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Authenticate,
  BlobStoreR2,
  isReadAction,
  parseSecret,
  Policy,
  SECRET_CONFIG_KEY,
  GIT_WORKER_OPTIONS,
  HasherInline,
  ReposDurableObject,
  RegistryDurableObject,
  Server,
  ServerLive,
} from "@/Git/index.ts";

/**
 * The admin key every suite authenticates with. Honors a caller-provided
 * `GIT_SERVICE_SECRET` (the deployed-cloud suites may point at a
 * standing deployment); otherwise a deterministic test-only value.
 */
export const TEST_SECRET: string =
  process.env[SECRET_CONFIG_KEY] ?? "test-secret-git-service-suite";
/** A second credential, resolved to a second principal (see `AuthenticateTest`). */
export const TEST_SECRET_DEV = "test-secret-git-service-suite-dev";
export const TEST_PRINCIPAL = { id: "e2e", name: "Suite" } as const;
export const TEST_PRINCIPAL_DEV = { id: "dev", name: "Dev" } as const;
process.env[SECRET_CONFIG_KEY] ??= TEST_SECRET;

/**
 * Two shared secrets, two principals: `TEST_SECRET` is the suite's owner
 * principal, `TEST_SECRET_DEV` a second user for policy tests. Anything
 * else is anonymous.
 */
export const AuthenticateTest: Layer.Layer<Authenticate> = Layer.succeed(
  Authenticate,
  (headers) =>
    Effect.sync(() => {
      const presented = parseSecret(headers);
      if (presented === TEST_SECRET) return TEST_PRINCIPAL;
      if (presented === TEST_SECRET_DEV) return TEST_PRINCIPAL_DEV;
      return undefined;
    }),
);

/**
 * The suite's policy: any principal may do anything (the suite creates
 * repos under several owners), anonymous callers read public repos.
 * `PolicyOwners` has its own unit test.
 */
export const PolicyTest: Layer.Layer<Policy> = Layer.succeed(Policy, {
  authorize: ({ principal, repo, action }) =>
    Effect.succeed(
      principal !== undefined ||
        (repo !== null && repo.public && isReadAction(action)),
    ),
});

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
  // In-process hashing: service-binding fan-out runs on the caller's
  // thread on Workers (DESIGN §22.10), so the simpler layer is the reference.
  Layer.provide(HasherInline),
  Layer.provide(BlobStoreR2(GitObjects)),
  Layer.provide(AuthenticateTest),
  Layer.provide(PolicyTest),
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
