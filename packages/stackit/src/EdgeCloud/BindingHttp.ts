import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { Instance } from "./Instance.ts";

/**
 * Shared HTTP scaffolding for Edge Cloud bindings.
 * NOT exported from index.ts.
 *
 * Each binding grants a custom role holding exactly the operation's action, on the
 * project holding the instance: STACKIT has no role binding on a single instance
 * (see `StackitBindings`). The action names come from the `x-stackit-authorization`
 * of each operation in STACKIT's Edge Cloud API spec, which names
 * `edge.instances.create` for reading a kubeconfig or token.
 */
export const EDGE_ACCESS = {
  getInstance: { permissions: ["edge.instances.get"] },
  listInstances: { permissions: ["edge.instances.list"] },
  mintCredential: { permissions: ["edge.instances.create"] },
} as const satisfies Record<string, StackitBindings.Access>;

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.EdgeCloud.GetInstance`. */
  tag: string;
  /** What the operation needs on the project holding the instance. */
  access: StackitBindings.Access;
  /** The distilled operation; the instance's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [StackitBindings.grantOn(instance, options.access)],
  });

/** Build a binding over an operation on the project and region holding an instance. */
export const makeInstanceScopeHttpBinding = <
  I extends { projectId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.EdgeCloud.ListInstances`. */
  tag: string;
  /** What the operation needs on the project holding the instance. */
  access: StackitBindings.Access;
  /** The distilled operation; the instance's project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
    }),
    grants: (instance) => [StackitBindings.grantOn(instance, options.access)],
  });

/**
 * Build a binding over an operation whose spec turns authorization off: nothing is
 * bound and no role is granted. The host still gets a service account and key, to
 * sign with.
 */
export const makeDiscoveryHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.EdgeCloud.ListPlans`. */
  tag: string;
  /** The distilled operation. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const run = yield* StackitBindings.withCredentials(options.operation);
    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}`({});
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* run(request);
      });
    });
  });
