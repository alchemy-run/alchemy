import * as Effect from "effect/Effect";
import type { Server } from "../IaaS/Server.ts";
import * as StackitBindings from "../StackitBindings.ts";

/**
 * Shared HTTP scaffolding for Run Command bindings.
 * NOT exported from index.ts.
 *
 * Each binding grants a custom role holding exactly the operation's action, on the
 * project holding the server: STACKIT has no role binding on a single server (see
 * `StackitBindings`). The action names come from the `x-stackit-authorization` of
 * each operation in STACKIT's Run Command API spec.
 */

export const makeServerCommandHttpBinding = <
  I extends { projectId: string; region: string; serverId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.RunCommand.GetCommand`. */
  tag: string;
  /** The action the operation needs on the project holding the server. */
  permission: string;
  /** The distilled operation; the server's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (server: Server) => ({
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
    }),
    grants: (server) => [StackitBindings.grantOn(server, { permissions: [options.permission] })],
  });

/**
 * Build a binding over an operation with no project in its path: nothing is bound
 * and no role is granted. The host still gets a service account and key, to sign
 * with.
 */
export const makeGlobalCommandHttpBinding = <I, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.RunCommand.ListCommandTemplates`. */
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
      return Effect.fn(options.tag)(function* (request?: I) {
        // The operation's only input is optional.
        return yield* run(request ?? ({} as I));
      });
    });
  });
