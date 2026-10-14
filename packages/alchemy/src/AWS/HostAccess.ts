import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Input } from "../Input.ts";
import { externalAwsAccess, externalHost, externalServices } from "./ExternalHost.ts";
import type { PolicyStatement } from "./IAM/Policy.ts";
import { isNativeHost, type NativeHost } from "./NativeHost.ts";

/**
 * How a binding's host reaches AWS:
 *
 * - **native host** (see `isNativeHost`): statements go on the host's own role and
 *   calls use its ambient credentials;
 * - **external host** (a Cloudflare Worker, Cloud Run, …): statements go on a
 *   role minted for the host (see `ExternalHost.ts`) and calls use that
 *   role's assumed credentials;
 * - **no host** (a script or deploy-time Action): nothing is bound and
 *   calls use the deployer's credentials.
 *
 * Import it as a namespace. A binding resolves its operation with
 * {@link withCredentials} when its layer is built, and binds to the host with
 * {@link bind} behind its own `__ALCHEMY_RUNTIME__` guard:
 *
 * ```ts
 * Effect.gen(function* () {
 *   const sendMessage = yield* HostAccess.withCredentials(sqs.sendMessage);
 *   return Effect.fn(function* (queue: Queue) {
 *     if (!globalThis.__ALCHEMY_RUNTIME__) {
 *       yield* HostAccess.bind`AWS.SQS.SendMessage(${queue})`({
 *         policyStatements: [
 *           { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: [queue.queueArn] },
 *         ],
 *       });
 *     }
 *     return (request) => sendMessage({ ...request, QueueUrl: … });
 *   });
 * })
 * ```
 */

/**
 * Resolve a distilled operation (or several, with `Effect.all`) with the
 * host's AWS credentials: as-is on a native host and for the deployer, with
 * the minted role's assumed credentials on an external host.
 *
 * A bundle built for an AWS host folds `__ALCHEMY_NATIVE_HOST__` to `"AWS"`,
 * which drops the external path, and `ExternalHost.ts` with it.
 *
 * @param region the region an external host signs in, e.g. a bucket's own.
 *   Evaluated only on an external host: the outer Effect when the operation
 *   is resolved (it may read resource attributes onto the host), the inner
 *   one per call.
 *   @default the stack's region
 */
export const withCredentials = <Op>(
  operation: Effect.Effect<Op, never, any>,
  region?: Effect.Effect<Effect.Effect<string>, never, any>,
): Effect.Effect<Op> =>
  // The operation's requirements are the host's: ambient on a native host
  // (and for the deployer, with no host), provided here otherwise.
  globalThis.__ALCHEMY_NATIVE_HOST__ === "AWS"
    ? (operation as Effect.Effect<Op>)
    : Effect.gen(function* () {
        const host = yield* Binding.Host;
        if (host === undefined || isNativeHost(host)) {
          return yield* operation as Effect.Effect<Op>;
        }
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- only reached with a host, whose init provides RuntimeContext
        const access = yield* externalAwsAccess(host) as Effect.Effect<
          Effect.Success<ReturnType<typeof externalAwsAccess>>
        >;
        return yield* (operation as Effect.Effect<Op>).pipe(
          Effect.provide(
            externalServices(
              access,
              region ? yield* region as Effect.Effect<Effect.Effect<string>> : access.region,
            ),
          ),
        );
      });

/** The VPC a native host must attach to, e.g. to reach a VPC-only database. */
export interface HostVpc {
  readonly subnetIds: Input<string[]>;
  readonly securityGroupIds: Input<string[]>;
}

/** What a binding attaches to its host. */
export interface HostBinding {
  /** The IAM statements the binding needs. */
  readonly policyStatements?: Input<PolicyStatement>[];
  /** Env vars the binding reads at runtime. */
  readonly env?: Record<string, unknown>;
  /**
   * The VPC the host must attach to. Applies to native hosts only: an
   * external host reaches AWS over the public internet.
   */
  readonly vpc?: HostVpc;
}

/**
 * `host.bind` for AWS bindings, on whatever host the binding runs on: a
 * native host takes the statements on its own role and the env as its own;
 * an external host's minted role takes the statements and its env takes the
 * env; without a host nothing is bound. The label names the binding like
 * `host.bind`, and is recorded as `Allow(<host>, <label>)`.
 *
 * Deploy-only: call it behind `if (!globalThis.__ALCHEMY_RUNTIME__)` so the
 * bundler drops it from the host.
 */
export const bind =
  (label: TemplateStringsArray, ...args: unknown[]) =>
  (data: HostBinding): Effect.Effect<void> =>
    Effect.gen(function* () {
      const host = yield* Binding.Host;
      if (host === undefined) return;
      const target = isNativeHost(host)
        ? host
        : // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- only reached with a host, whose init provides RuntimeContext
          externalHost(host, yield* externalAwsAccess(host) as Effect.Effect<any>);
      const strings = ["Allow(", `, ${label[0]}`, ...label.slice(1)];
      strings[strings.length - 1] += ")";
      const template = Object.assign(strings, { raw: strings }) as unknown as TemplateStringsArray;
      yield* (
        target.bind as unknown as (...args: unknown[]) => (data: HostBinding) => Effect.Effect<void>
      )(
        template,
        target satisfies NativeHost,
        ...args,
      )(data);
    });
