import { ConfigError } from "@distilled.cloud/core/errors";
import type * as rest from "@distilled.cloud/stackit/workflows_airflow";
import {
  makeWorkflowsAirflowSession,
  withWorkflowsAirflowSession,
  type WorkflowsAirflowSession,
} from "@distilled.cloud/stackit/WorkflowsAirflow";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import type { AirflowClient } from "./AirflowClient.ts";
import type { Instance } from "./Instance.ts";
import { airflowMajorVersion } from "./internal.ts";

/**
 * Shared HTTP scaffolding for STACKIT Workflows bindings.
 * NOT exported from index.ts.
 *
 * Two APIs, two kinds of access:
 *
 * - The management API takes a STACKIT identity, through `StackitBindings`. Roles bind on the
 *   project holding the instance: STACKIT has no role binding on a single instance. The grants
 *   list exactly the permission an operation needs, as the spec's `x-stackit-authorization` names
 *   it.
 * - Airflow's own REST API takes a session from the instance's session endpoint, in exchange for a
 *   token from the instance's identity provider, which grants no STACKIT role and creates no
 *   service account. What the session can do is the role the provider gives the client.
 */

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Workflows.GetInstance`. */
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

/**
 * A value of an `AirflowClient`, or the Output of a resource that holds it. The cast is because
 * `isOutput` narrows to `Output<any, any>`, which has lost both the value's type and that a bound
 * attribute requires nothing.
 */
const accessorOf = <A>(value: A): Effect.Effect<Effect.Effect<A>> =>
  Output.isOutput(value)
    ? (value as unknown as Output.Output<A, never>).asEffect()
    : Effect.succeed(Effect.succeed(value));

/** Where a host reads a client's login once its bundle runs. */
interface AirflowAccess {
  readonly url: Effect.Effect<string>;
  readonly version: Effect.Effect<string>;
  readonly discoveryEndpoint: Effect.Effect<string>;
  readonly clientId: Effect.Effect<string>;
  readonly clientSecret: Effect.Effect<string | Redacted.Redacted<string>>;
  readonly scope: Effect.Effect<string | undefined>;
}

/**
 * The session for one client. It is built on the first call, because the attributes are only
 * readable once the host runs, and it holds nothing but a cookie: no connection outlives a request
 * on a host like workerd, and `refresh-gate.ts` lets requests share the login.
 */
const makeSessionOf = (
  access: AirflowAccess,
): Effect.Effect<WorkflowsAirflowSession, ConfigError> => {
  let session: WorkflowsAirflowSession | undefined;
  return Effect.gen(function* () {
    if (session !== undefined) return session;
    const version = yield* access.version;
    // The module is Airflow's `/api/v2`, which only Airflow 3 serves.
    const major = airflowMajorVersion(version);
    if (major !== undefined && major < 3) {
      return yield* Effect.fail(
        new ConfigError({
          message: `STACKIT Workflows bindings on Airflow call its v2 REST API, which needs Airflow 3, and this instance runs ${version}.`,
        }),
      );
    }
    const instanceUrl = yield* access.url;
    const discoveryEndpoint = yield* access.discoveryEndpoint;
    const clientId = yield* access.clientId;
    const clientSecret = yield* access.clientSecret;
    const scope = yield* access.scope;
    session ??= makeWorkflowsAirflowSession({
      instanceUrl,
      discoveryEndpoint,
      clientId,
      // A host's env can hand a secret back unwrapped, whatever its type says.
      clientSecret: Redacted.isRedacted(clientSecret) ? clientSecret : Redacted.make(clientSecret),
      scope,
    });
    return session;
  });
};

/** Calls `workflows_airflow` operations as a bound client. */
export interface AirflowCaller {
  <I, A, E extends { readonly _tag: string }>(
    operation: (input: I) => Effect.Effect<A, E, rest.WorkflowsAirflowOpContext>,
    request: I,
  ): Effect.Effect<A, E | ConfigError>;
}

/** Build a binding over a client of Airflow's REST API: `<Op>Http.ts` is one call to it. */
export const makeAirflowBinding = <Client>(makeClient: (call: AirflowCaller) => Client) =>
  Effect.fn(function* (instance: Instance, client: AirflowClient) {
    const url = yield* instance.url;
    const version = yield* instance.version;
    const discoveryEndpoint = yield* accessorOf(client.discoveryEndpoint);
    const clientId = yield* accessorOf(client.clientId);
    const clientSecret = yield* accessorOf(client.clientSecret);
    const scope = yield* accessorOf(client.scope);
    const sessionOf = makeSessionOf({
      url,
      version,
      discoveryEndpoint,
      clientId,
      clientSecret,
      scope,
    });
    const call: AirflowCaller = (operation, request) =>
      Effect.flatMap(sessionOf, (session) =>
        operation(request).pipe(
          withWorkflowsAirflowSession(session),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
    return makeClient(call);
  });
