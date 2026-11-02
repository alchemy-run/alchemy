import { LokiCredentials, lokiCredentialsOf } from "@distilled.cloud/stackit/Credentials";
import * as loki from "@distilled.cloud/stackit/logs_loki";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import type { AccessToken } from "./AccessToken.ts";
import type { Instance } from "./Instance.ts";
import { toRedacted } from "./internal.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { ReadWriteInstanceClient } from "./ReadWriteInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/**
 * Shared HTTP scaffolding for STACKIT Logs bindings.
 * NOT exported from index.ts.
 *
 * Management bindings grant on the project holding the instance: STACKIT has no role
 * binding on a single instance (see `StackitBindings`). The grants list exactly the
 * permission an operation needs, the `x-stackit-authorization` action in the service's
 * API spec.
 *
 * Data bindings call Grafana Loki on the instance with one of its access tokens, so they
 * grant no STACKIT role and create no service account.
 */

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Logs.GetInstance`. */
  tag: string;
  /** The permission the operation needs on the project holding the instance. */
  permission: string;
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
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/** Build a binding over one operation on the bound instance's project and region. */
export const makeProjectHttpBinding = <
  I extends { projectId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Logs.ListInstances`. */
  tag: string;
  /** The permission the operation needs on the project. */
  permission: string;
  /** The distilled operation; the project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/**
 * Where a host reads a token's connection details, once its bundle runs. A value can reach
 * the host unwrapped, whatever its type says.
 */
export interface LokiAccess {
  readonly datasourceUrl: Effect.Effect<string | undefined>;
  readonly token: Effect.Effect<string | Redacted.Redacted<string> | undefined>;
}

/** Calls `logs_loki` operations with a bound access token. */
export interface LokiCaller {
  <I, A, E>(
    operation: (input: I) => Effect.Effect<A, E, loki.LokiOpContext>,
    request: I,
  ): Effect.Effect<A, E>;
}

/**
 * The caller for one token. Each request acquires what it needs, so nothing outlives a
 * request on a host like workerd. The token travels through the host's environment,
 * kept `Redacted`.
 */
export const makeLokiCaller =
  (access: LokiAccess): LokiCaller =>
  (operation, request) =>
    Effect.gen(function* () {
      const datasourceUrl = yield* access.datasourceUrl;
      const token = yield* access.token;
      return yield* operation(request).pipe(
        Effect.provideService(
          LokiCredentials,
          lokiCredentialsOf({
            datasourceUrl: datasourceUrl ?? "",
            token: token === undefined ? undefined : toRedacted(token),
          }),
        ),
        Effect.provide(FetchHttpClient.layer),
      );
    });

/** Build a binding over a client of Loki's API: `<Op>Http.ts` is one call to it. */
export const makeLokiBinding = <Client>(makeClient: (call: LokiCaller) => Client) =>
  Effect.fn(function* (accessToken: AccessToken) {
    const datasourceUrl = yield* accessToken.datasourceUrl;
    const token = yield* accessToken.accessToken;
    return makeClient(makeLokiCaller({ datasourceUrl, token }));
  });

/** Build the read client for a token. */
export const makeReadInstanceClient = (call: LokiCaller): ReadInstanceClient => ({
  query: (request) => call(loki.query, request),
  queryRange: (request) => call(loki.queryRange, request),
});

/** Build the write client for a token. */
export const makeWriteInstanceClient = (call: LokiCaller): WriteInstanceClient => ({
  push: (request) => call(loki.push, request),
  pushOtlp: (request) => call(loki.pushOtlp, request),
});

/** Build the client with every read and write operation. */
export const makeReadWriteInstanceClient = (call: LokiCaller): ReadWriteInstanceClient => ({
  ...makeReadInstanceClient(call),
  ...makeWriteInstanceClient(call),
});
