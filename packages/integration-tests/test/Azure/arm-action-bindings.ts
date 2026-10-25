import * as Azure from "@alchemy.run/azure";
import {
  parseArmResourceId,
  type ArmResourceId,
} from "@alchemy.run/azure/internal/ArmActionBinding";
import * as authorization from "@distilled.cloud/azure/authorization";
import { expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Shared test helpers for the ARM runtime-action binding suites (start,
 * stop, restart, pause, failover, …): deployer credentials, HTTP calls to
 * the Function fixture, out-of-band grant checks, and the ungated request
 * probe.
 */

/** Deployer credentials and environment for out-of-band checks and hooks. */
export const azure = Layer.mergeAll(
  Azure.environmentFromAuthProvider(),
  Azure.fromAuthProvider(),
).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

export type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route on `url` until it answers `ok`, through the Flex
 * Consumption cold start and role propagation, then return the last answer
 * so a real failure shows its Azure error.
 */
export const call = (url: Effect.Effect<string>, route: string) =>
  Effect.gen(function* () {
    const base = yield* url;
    return yield* HttpClient.get(`${base}${route}`).pipe(
      Effect.timeout("90 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

export const expectOk = (body: Body) =>
  expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Role assignments of a Function's identity, without its own host-storage grants. */
export const assignmentsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    return Array.from(assignments).filter(
      (a) => !(a.properties?.scope?.toLowerCase() ?? "").endsWith(host),
    );
  });

/** Every role on a Function's identity as `<actions> <scope>`, sorted. */
export const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId, hostStorageAccount)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

/** Poll a Function identity's grants until at least `count` are listed (lists trail writes). */
export const awaitGrants = (
  principalId: string,
  hostStorageAccount: string | undefined,
  count: number,
) =>
  grantsOf(principalId, hostStorageAccount).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (listed) => listed.length >= count,
      times: 18,
    }),
    Effect.provide(azure),
  );

/** Poll until a Function identity has no grants left (lists trail deletes by minutes). */
export const awaitNoGrants = (principalId: string, hostStorageAccount: string | undefined) =>
  assignmentsOf(principalId, hostStorageAccount).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (assignments) => assignments.length === 0,
      times: 24,
    }),
    Effect.map((assignments) => assignments.map((a) => a.properties?.scope)),
    Effect.provide(azure),
  );

/** A resource group no test creates: the ungated request probes address it. */
export const MISSING_GROUP = "alchemy-arm-action-probe-missing";

/**
 * The ARM ID of `path` (e.g. `Microsoft.DBforPostgreSQL/flexibleServers/pg`)
 * in {@link MISSING_GROUP}, parsed the way the bindings parse their bound
 * resource's ID.
 */
export const missingResourceId = (path: string) =>
  Effect.map(Azure.AzureEnvironment.current, ({ subscriptionId }) =>
    parseArmResourceId(
      `/subscriptions/${subscriptionId}/resourceGroups/${MISSING_GROUP}/providers/${path}`,
    ),
  );

/**
 * Ungated request probe: send a binding's distilled operation, with the
 * identifiers the binding derives, for a resource in a missing resource
 * group, and return the error tag ARM answers.
 */
export const probe = <E extends { readonly _tag: string }>(
  path: string,
  send: (id: ArmResourceId) => Effect.Effect<unknown, E, any>,
) =>
  Effect.gen(function* () {
    const id = yield* missingResourceId(path);
    return yield* send(id).pipe(
      Effect.as("accepted"),
      Effect.catch((e) => Effect.succeed(e._tag)),
    );
  }).pipe(
    Effect.provide(azure),
    // `send` carries `any` requirements (each service's op has its own
    // context type); `azure` provides what every distilled ARM op needs.
  ) as Effect.Effect<string>;
