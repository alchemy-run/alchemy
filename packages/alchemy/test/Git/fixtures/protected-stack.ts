/**
 * A SECOND building-block assembly with a `Git.Hooks` in the graph: the
 * suite's middleware, plus one branch-protection rule. This is the
 * reference for "a rule about refs": a pre-receive hook is a page of code
 * over the parsed updates, it reads what the middleware put in context,
 * and it never sees a credential.
 *
 * Lives in its own module (not `stack.ts`) because a Worker's generated
 * entry imports its `main` module's DEFAULT export — one Worker class
 * per entry module.
 */
import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  BlobStoreR2,
  GIT_WORKER_OPTIONS,
  Handlers,
  HasherInline,
  Hooks,
  ReposDurableObject,
  RegistryDurableObject,
  Server,
} from "@/Git/index.ts";
import { TestApi, TestAuthLive, TestCaller } from "./test-auth.ts";

/**
 * Direct updates to `refs/heads/main` only by the repository's owner;
 * every other ref moves freely. Runs on `git push`, on the REST ref
 * writes, and on a merge, with the caller the middleware resolved.
 */
const ProtectedMain: Layer.Layer<Hooks> = Layer.succeed(Hooks, {
  preReceive: ({ repo, updates }) =>
    Effect.gen(function* () {
      const caller = yield* Effect.serviceOption(TestCaller);
      const user = Option.isSome(caller) ? caller.value.user : null;
      return updates.flatMap((update) =>
        update.ref === "refs/heads/main" && user?.id !== repo.owner
          ? [
              {
                ref: update.ref,
                reason: "not permitted: only the owner moves main",
              },
            ]
          : [],
      );
    }),
});

/** This assembly's bucket (its own stack, so no clash with `stack.ts`). */
const GitObjects = Cloudflare.R2.Bucket("GitObjects");

const ProtectedGitLive = Server.layer(TestApi).pipe(
  Layer.provide(Handlers),
  Layer.provide(TestAuthLive),
  Layer.provide(ProtectedMain),
  Layer.provide(ReposDurableObject),
  Layer.provide(RegistryDurableObject),
  Layer.provide(HasherInline),
  Layer.provide(BlobStoreR2(GitObjects)),
);

/** Identical to the shared fixture's host except for the hook. */
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
