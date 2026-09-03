/**
 * A SECOND building-block assembly whose Policy is swapped: the suite's
 * two principals, plus one branch-protection rule. This is the
 * swappability proof for the Auth design — and the reference for
 * "implement your own rule": a policy is a page of code over
 * `GitAction`, and it never sees a credential.
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
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  HasherInline,
  isReadAction,
  Policy,
  ReposDurableObject,
  RegistryDurableObject,
  Server,
  ServerLive,
} from "@/Git/index.ts";
import { AuthenticatedTest } from "./stack.ts";

/**
 * Direct pushes to `refs/heads/main` only by the repository's owner;
 * everything else is the suite's permissive rule (any principal may act,
 * anonymous callers read public repos).
 */
const ProtectedMainPolicy: Layer.Layer<Policy> = Layer.succeed(Policy, {
  authorize: ({ principal, repo, action }) =>
    Effect.succeed(
      principal === undefined
        ? repo !== null && repo.public && isReadAction(action)
        : action._tag === "Push"
          ? action.updates.every((u) =>
              u.ref === "refs/heads/main" ? repo?.owner === principal.id : true,
            )
          : true,
    ),
});

/** This assembly's bucket (its own stack, so no clash with `stack.ts`). */
const GitObjects = Cloudflare.R2.Bucket("GitObjects");

const ProtectedGitLive = ServerLive.pipe(
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherInline),
  Layer.provide(BlobStoreR2(GitObjects)),
  Layer.provide(AuthenticatedTest),
  Layer.provide(ProtectedMainPolicy),
);

/** Identical to the shared fixture's host except for the Policy. */
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
