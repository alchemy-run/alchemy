import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Binding from "../../Binding.ts";
import type { Named } from "../../Named.ts";
import { Resource } from "../../Resource.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { sanitizeKey } from "../../RuntimeContext.ts";
import { FunctionTypeId, isFunction, type Function } from "./Function.ts";

/**
 * Forward-reference constructor for a target Function: registers (or joins)
 * the target's resource row by logical id WITHOUT building its class — the
 * #874 bare-tag pattern. The returned handle's attribute Outputs carry the
 * dependency edge; the target class's own build repairs the row's Props.
 */
const FunctionForwardRef = Resource<Function>(FunctionTypeId);

/**
 * The header Vercel's deployment protection accepts to bypass SSO/preview
 * protection — sent on every request when the target function's
 * automation-bypass secret is bound (§6.7: the secret is minted at project
 * ensure, BEFORE the first deploy, and never regenerated).
 */
const PROTECTION_BYPASS_HEADER = "x-vercel-protection-bypass";

/** Env keys the deploy half binds for a target function's logical id. */
const invokeEnvKey = (logicalId: string, suffix: "URL" | "BYPASS"): string =>
  `${sanitizeKey(logicalId)}_${suffix}`;

/**
 * The typed HTTP client returned by {@link InvokeFunction} — a full
 * `HttpClient` surface (`get`/`post`/`execute`/…) whose requests are
 * rewritten against the target Function's read-back URL and carry the
 * target's protection-bypass secret. Colored with {@link RuntimeContext}:
 * it only functions inside a deployed Function, where the bound env vars
 * exist.
 */
export interface InvokeFunctionClient extends HttpClient.HttpClient.With<
  HttpClientError.HttpClientError,
  RuntimeContext
> {
  /**
   * The target Function's URL — the value bound from the target's
   * READ-BACK production URL (never computed), resolved from env at call
   * time.
   */
  readonly url: Effect.Effect<string, never, RuntimeContext>;
}

/**
 * A by-logical-id forward reference to a target Function. This is the way
 * one side of a circular invoke pair names its sibling WITHOUT importing
 * the sibling's module: importing the class would make each class's *type*
 * depend on its own initializer through the other side's impl, which
 * TypeScript collapses to `any` (TS7022). The deploy half resolves the id
 * through the same `Function.ref` forward reference it uses for a class
 * target, so the runtime topology is identical.
 */
export interface InvokeRef {
  readonly LogicalId: string;
}

/**
 * What {@link invoke} accepts: a resolved `Vercel.Function` handle, a
 * Function class (its `LogicalId` is read statically — the class is
 * deliberately NEVER yielded, see {@link invoke}), or a by-logical-id
 * forward reference ({@link InvokeRef}) for the module-cycle-free side of
 * a circular pair.
 */
export type InvokeTarget =
  | Function
  | (Effect.Effect<Function, any, any> & Named<string>)
  | InvokeRef;

/**
 * Invoke another Vercel Function over HTTP.
 *
 * The deploy half binds two project env vars on the host — the target's
 * read-back URL (`{LogicalId}_URL`) and its automation protection-bypass
 * secret (`{LogicalId}_BYPASS`, a sensitive env var) — so the runtime
 * client can reach the target even when Vercel's deployment protection
 * (team SSO / preview protection) guards it. Circular topologies (A
 * invokes B, B invokes A) work: the engine pre-creates both projects, so
 * each side's URL and bypass secret exist before either deploys.
 *
 * Provide the implementation with
 * `Effect.provide(Vercel.InvokeFunctionHttp)`.
 *
 * @binding
 * @section Invoking another Function
 * @example Calling a sibling Function from a handler
 * ```typescript
 * import Billing from "./billing.ts";
 *
 * export default class Api extends Vercel.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const billing = yield* Vercel.invoke(Billing);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const res = yield* billing.get("/invoices").pipe(Effect.orDie);
 *         return yield* HttpServerResponse.json(yield* res.json.pipe(Effect.orDie));
 *       }),
 *     };
 *   }).pipe(Effect.provide(Vercel.InvokeFunctionHttp)),
 * ) {}
 * ```
 *
 * @example Circular invocation (A ↔ B)
 * ```typescript
 * // a.ts — imports B's class normally and invokes it.
 * import B from "./b.ts";
 * const b = yield* Vercel.invoke(B);
 *
 * // b.ts — deliberately does NOT import a.ts. Referencing the sibling by
 * // logical id keeps the module graph — and therefore the type graph —
 * // acyclic (a mutual class import makes each class's type depend on its
 * // own initializer and TypeScript collapses both to `any`). The deploy
 * // half forward-refs the id exactly like a class target, and the
 * // engine's pre-create step provides both URLs + bypass secrets before
 * // either function deploys, so the RUNTIME topology is fully circular.
 * const a = yield* Vercel.invoke({ LogicalId: "A" });
 * ```
 */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "Vercel.InvokeFunction",
  (fn: Function) => Effect.Effect<InvokeFunctionClient>
> {}

export const InvokeFunction = Binding.Service<InvokeFunction>(
  "Vercel.InvokeFunction",
);

/**
 * Ergonomic alias: `const billing = yield* Vercel.invoke(Billing)`.
 *
 * Accepts the target Function **class**, a resolved handle, or a
 * by-logical-id forward reference (`{ LogicalId: "Billing" }`, see
 * {@link InvokeRef}). The class is wrapped so the binding machinery never
 * yields it — yielding a sibling class inside another Function's init
 * resolves that sibling's `Self`, which deadlocks the layer build in a
 * circular A↔B topology. The implementation instead forward-references
 * the target through `Function.ref(LogicalId)`, which routes through
 * Output resolution and stays acyclic. In a circular pair, at least one
 * side must use the by-id form so the *module* graph stays acyclic too —
 * see the Circular example on {@link InvokeFunction}.
 */
export const invoke = (
  target: InvokeTarget,
): Effect.Effect<InvokeFunctionClient, never, InvokeFunction> =>
  InvokeFunction(Effect.sync(() => target as unknown as Function));

/**
 * HTTP implementation of {@link InvokeFunction}.
 *
 * Deploy half (guarded by `__ALCHEMY_RUNTIME__`): binds the target's `url`
 * and `protectionBypass` attributes onto the host's env channel — via a
 * `Function.ref` forward reference when handed a class, so circular
 * topologies never resolve each other's init. Runtime half: an
 * `HttpClient` whose requests are prefixed with the bound URL and carry
 * `x-vercel-protection-bypass` when the target has a bypass secret (it may
 * not, e.g. a tenant-mode target on a foreign project without one).
 *
 * Provide on the Function's init Effect:
 * `Effect.provide(Vercel.InvokeFunctionHttp)`.
 */
export const InvokeFunctionHttp: Layer.Layer<
  InvokeFunction,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  InvokeFunction,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient;
    return Effect.fn(function* (fn: Function) {
      const logicalId = (fn as { LogicalId?: string }).LogicalId;
      if (logicalId === undefined) {
        return yield* Effect.die(
          new Error(
            "Vercel.InvokeFunction: target has no LogicalId — pass a Vercel.Function class or handle",
          ),
        );
      }
      const urlKey = invokeEnvKey(logicalId, "URL");
      const bypassKey = invokeEnvKey(logicalId, "BYPASS");
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // Deploy-time only: bind the TARGET function's read-back URL and
        // protection-bypass secret onto the host's project env. Both are
        // attribute Outputs, resolved by the engine right before the host
        // reconciles (pre-create attributes in circular topologies). A
        // class target is turned into a `ref` — never yielded — so mutual
        // A↔B invokes stay acyclic at init time.
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          const target = isFunction(fn)
            ? fn
            : yield* FunctionForwardRef(logicalId, undefined);
          yield* host.bind`InvokeFunction(${host}, ${logicalId})`({
            env: {
              [urlKey]: target.url,
              // Redacted attribute ⇒ sensitive project env var; undefined
              // (foreign tenant project without a secret) is skipped by the
              // provider's env sync and the runtime omits the header.
              [bypassKey]: target.protectionBypass,
            },
          });
        }
      }
      // Lazy env reads — the bound vars only exist at the exec phase; the
      // widening to the RuntimeContext-colored interface is safe (R is
      // contravariant) and pins the client to deployed-Function usage.
      const url = Effect.suspend(() => {
        const value = process.env[urlKey];
        return value === undefined || value === ""
          ? Effect.die(
              new Error(
                `Vercel.InvokeFunction(${logicalId}): env ${urlKey} is not set — the target's URL binding did not resolve`,
              ),
            )
          : Effect.succeed(value);
      }) as Effect.Effect<string, never, RuntimeContext>;

      const client = base.pipe(
        HttpClient.mapRequestEffect(
          (request) =>
            Effect.map(url, (targetUrl) => {
              let next = HttpClientRequest.prependUrl(request, targetUrl);
              const bypass = process.env[bypassKey];
              if (bypass !== undefined && bypass !== "") {
                next = HttpClientRequest.setHeader(
                  next,
                  PROTECTION_BYPASS_HEADER,
                  bypass,
                );
              }
              return next;
            }) as Effect.Effect<
              HttpClientRequest.HttpClientRequest,
              never,
              RuntimeContext
            >,
        ),
      );
      return Object.assign(client, { url }) as InvokeFunctionClient;
    });
  }),
);
