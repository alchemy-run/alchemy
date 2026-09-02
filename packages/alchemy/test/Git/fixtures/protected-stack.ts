/**
 * A SECOND building-block assembly whose Auth layer is swapped: same
 * authentication as `AuthTokens`, plus one branch-protection rule. This
 * is the swappability proof for RFC §3.2 — and the reference for
 * "implement your own auth": a policy is a page of code over
 * `GitAction`, not a reimplementation of credentials.
 *
 * Lives in its own module (not `stack.ts`) because a Worker's generated
 * entry imports its `main` module's DEFAULT export — one Worker class
 * per entry module.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  Auth,
  AuthTokens,
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  HasherSelf,
  ReposDurableObject,
  RegistryDurableObject,
  Server,
  ServerLive,
} from "@/Git/index.ts";
// Installs the TEST_ADMIN_TOKEN into the deployer env at module load.
import "./stack.ts";

/**
 * The RFC §3.2 example, live: direct pushes to `refs/heads/main` are
 * admin-only, everything else defers to the default — composed by
 * WRAPPING `AuthTokens` (admin key + scoped repo tokens) rather than
 * reimplementing it.
 */
const ProtectedMainAuth: Layer.Layer<Auth> = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const base = yield* Auth;
    return {
      authenticate: base.authenticate,
      authorize: (input) =>
        input.action._tag === "Push" &&
        input.action.updates.some((u) => u.ref === "refs/heads/main") &&
        input.actor.kind !== "admin"
          ? Effect.succeed(false)
          : base.authorize(input),
    };
  }),
).pipe(Layer.provide(AuthTokens));

/** This assembly's bucket (its own stack, so no clash with `stack.ts`). */
const GitObjects = Cloudflare.R2.Bucket("GitObjects");

const ProtectedGitLive = ServerLive.pipe(
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherSelf),
  Layer.provide(BlobStoreR2(GitObjects)),
  Layer.provide(ProtectedMainAuth),
);

/** Identical to the shared fixture's host except for the Auth block. */
export default class ProtectedGitHost extends Cloudflare.Worker<ProtectedGitHost>()(
  "GitProtectedWorker",
  {
    main: import.meta.url,
    ...GIT_WORKER_OPTIONS,
  },
  Effect.gen(function* () {
    const git = yield* Server;
    return { fetch: git.fetch };
  }).pipe(Effect.provide(ProtectedGitLive)),
) {}

/** Deployable stack for the protected-branch test. */
export const makeProtectedStack = (name: string) =>
  Alchemy.Stack(
    name,
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Effect.gen(function* () {
      const host = yield* ProtectedGitHost;
      return { url: host.url.as<string>() };
    }),
  );
