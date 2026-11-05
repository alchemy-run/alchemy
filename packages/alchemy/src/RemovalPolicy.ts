import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * What the engine does with a resource's **physical** cloud object when the
 * resource is deleted — orphaned (its declaration was removed or renamed
 * away), destroyed (`alchemy destroy`), or superseded by a replacement's old
 * generation.
 *
 * - `"destroy"` (the default for most resource types) — call the provider's
 *   `delete`.
 * - `"retain"` — skip `provider.delete` entirely. The state row is still
 *   dropped: alchemy forgets the resource, the cloud object lives on.
 * - `"protect"` — refuse to plan the deletion at all. `plan`, `deploy` and
 *   `destroy` fail with {@link ProtectedResource} before anything is applied
 *   when the plan would replace or delete the resource.
 *
 * The policy is a *decoration* on the declaration, applied with
 * {@link retain} / {@link destroy} / {@link protect}, and it is persisted on the resource's
 * state row. Because it isn't a prop, changing it produces no diff — the
 * resource plans as a `noop` and the deploy re-commits the row's policy in
 * place (see the noop branch of `Apply.ts`). So a policy change does take
 * effect from the very next deploy, even though the plan shows no changes.
 *
 * A few resource types default to `"retain"` because their contents are
 * irreplaceable (e.g. `GitHub.Repository`, `Cloudflare.Zone`); those opt into
 * deletion with `destroy()`.
 */
export class RemovalPolicy extends Context.Service<
  RemovalPolicy,
  "retain" | "destroy" | "protect"
>()("RemovalPolicy") {}

/**
 * Retain the physical cloud resource when the resource is deleted: the
 * provider's `delete` is never called, and the state row is dropped so
 * alchemy stops tracking it.
 *
 * Applies to every resource declared inside the piped effect, so it can
 * decorate a single resource or a whole scope.
 *
 * @example Retain one resource
 * ```typescript
 * const bucket = yield* R2.Bucket("Uploads").pipe(RemovalPolicy.retain());
 * ```
 *
 * @example Retain only in production
 * ```typescript
 * const stack = yield* Stack;
 * const bucket = yield* R2.Bucket("Uploads").pipe(
 *   RemovalPolicy.retain(stack.stage === "prod"),
 * );
 * ```
 *
 * @param enabled `true` (the default) retains; `false` selects `destroy`.
 *   May also be an `Effect` producing the boolean.
 */
export const retain: {
  (
    enabled?: boolean,
  ): <R, Req = never>(enabled: Effect.Effect<R, never, Req>) => Effect.Effect<R, never, Req>;
  <Req = never>(
    enabled: Effect.Effect<boolean, never, Req>,
  ): <R, Req2 = never>(a: Effect.Effect<R, never, Req2>) => Effect.Effect<R, never, Req | Req2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, never, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(RemovalPolicy, enabled ? "retain" : "destroy")
        : Effect.provideServiceEffect(
            RemovalPolicy,
            enabled.pipe(Effect.map((a) => (a ? "retain" : "destroy"))),
          ),
    )) as any;

/**
 * Destroy the physical cloud resource when the resource is deleted — the
 * default for most resource types, and the way to opt out for the ones that
 * default to `retain` (e.g. `GitHub.Repository`, `Cloudflare.Zone`).
 *
 * @example Opt a retain-by-default resource into deletion
 * ```typescript
 * yield* GitHub.Repository("Preview", {
 *   owner: "my-org",
 *   name: "ephemeral-preview",
 * }).pipe(RemovalPolicy.destroy());
 * ```
 *
 * @param enabled `true` (the default) destroys; `false` selects `retain`.
 *   May also be an `Effect` producing the boolean.
 */
export const destroy: {
  (
    enabled?: boolean,
  ): <R, Req = never>(enabled: Effect.Effect<R, never, Req>) => Effect.Effect<R, never, Req>;
  <Req = never>(
    enabled: Effect.Effect<boolean, never, Req>,
  ): <R, Req2 = never>(a: Effect.Effect<R, never, Req2>) => Effect.Effect<R, never, Req | Req2>;
} = ((enabled: boolean | Effect.Effect<boolean, never, any> = true) =>
  (eff: Effect.Effect<any, never, any>) =>
    eff.pipe(
      typeof enabled === "boolean"
        ? Effect.provideService(RemovalPolicy, enabled ? "destroy" : "retain")
        : Effect.provideServiceEffect(
            RemovalPolicy,
            enabled.pipe(Effect.map((a) => (a ? "destroy" : "retain"))),
          ),
    )) as any;

/**
 * Protect the resource from replacement and deletion: a plan that would
 * replace or delete it fails with {@link ProtectedResource}, naming the
 * resource, before anything is applied. This covers a replacing prop change,
 * removing the declaration, and `alchemy destroy`.
 *
 * The policy is persisted on the state row, so removing the declaration is
 * refused too. To replace or delete the resource on purpose, deploy it with
 * another policy first (e.g. drop `protect()`), then make the change.
 *
 * Applies to every resource declared inside the piped effect, so it can
 * decorate a single resource or a whole scope.
 *
 * @example Protect one resource
 * ```typescript
 * const vpc = yield* AWS.EC2.Vpc("Vpc", { cidrBlock: "10.0.0.0/16" }).pipe(
 *   RemovalPolicy.protect(),
 * );
 * ```
 *
 * @example Protect only in production
 * ```typescript
 * const stack = yield* Stack;
 * const cluster = yield* AWS.EKS.Cluster("Cluster", { ... }).pipe(
 *   RemovalPolicy.protect(stack.stage === "prod"),
 * );
 * ```
 *
 * @param enabled `true` (the default) protects; `false` leaves the policy
 *   unchanged. May also be an `Effect` producing the boolean.
 */
export const protect =
  <Req = never>(enabled: boolean | Effect.Effect<boolean, never, Req> = true) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Req> =>
    Effect.flatMap(Effect.isEffect(enabled) ? enabled : Effect.succeed(enabled), (on) =>
      on ? Effect.provideService(effect, RemovalPolicy, "protect") : effect,
    );

/**
 * Raised by `Plan.make` when the plan would replace or delete resources whose
 * removal policy is `"protect"` (see {@link protect}). Nothing is applied.
 */
export class ProtectedResource extends Data.TaggedError("ProtectedResource")<{
  message: string;
  /** The refused operations, one per protected resource. */
  resources: ReadonlyArray<{ fqn: string; action: "replace" | "delete" }>;
}> {}
