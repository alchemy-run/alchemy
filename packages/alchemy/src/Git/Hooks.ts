/**
 * The engine holds no auth. Who may call which route is decided by the
 * `HttpApi` middleware you put in front of the routes, before the engine
 * sees a request. The one decision a middleware cannot make is about the
 * refs a push wants to move, because the pack has not been parsed yet.
 * That is what git's own pre-receive hook is for, and {@link Hooks} is
 * that hook: it runs in the Worker, in the request's context, with the
 * parsed ref updates, before any ref moves.
 */
import { RuntimeContext } from "../RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpRouter from "effect/unstable/http/HttpRouter";
import type { RepoMetaData } from "./RepoObject.ts";

/**
 * One ref a push wants to move: `oldOid` is the expected current value
 * (all-zeros for a create), `newOid` the target (all-zeros for a delete).
 */
export interface RefUpdate {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
}

/** A ref the hook refused, with the reason git reports for it. */
export interface RefRejection {
  readonly ref: string;
  readonly reason: string;
}

export interface HooksShape {
  /**
   * Runs before refs move: on `git push`, on the REST ref writes, and on
   * a pull request merge. Returns the refs to refuse, each with a reason;
   * an empty array accepts. A push with any refused ref is rejected as a
   * whole, and git reports the reason per ref.
   *
   * Runs in the Worker, inside the request, so whatever your middleware
   * put in context is readable here with `Effect.serviceOption`.
   */
  readonly preReceive: (input: {
    readonly repo: RepoMetaData;
    readonly updates: ReadonlyArray<RefUpdate>;
  }) => Effect.Effect<
    ReadonlyArray<RefRejection>,
    never,
    RuntimeContext | HttpRouter.Provided
  >;
}

/**
 * `Git.Hooks` — git's pre-receive hook as a service. Optional:
 * {@link HooksNone} accepts everything.
 *
 * **Example:** only the repository's owner moves `main`
 * ```typescript
 * const ProtectedMain = Layer.succeed(Git.Hooks, {
 *   preReceive: ({ repo, updates }) =>
 *     Effect.gen(function* () {
 *       const user = yield* Effect.serviceOption(User); // what your middleware provided
 *       const owner = Option.map(user, (u) => u.id).pipe(Option.getOrUndefined);
 *       return updates.flatMap((u) =>
 *         u.ref === "refs/heads/main" && owner !== repo.owner
 *           ? [{ ref: u.ref, reason: "only the owner may push main" }]
 *           : [],
 *       );
 *     }),
 * });
 * ```
 *
 * @binding
 */
export class Hooks extends Context.Service<Hooks, HooksShape>()(
  "alchemy/Git/Hooks",
) {}

/**
 * No hooks: every ref update is accepted.
 *
 * @layer
 * @provides Git.Hooks
 */
export const HooksNone: Layer.Layer<Hooks> = Layer.succeed(Hooks, {
  preReceive: () => Effect.succeed([]),
});
