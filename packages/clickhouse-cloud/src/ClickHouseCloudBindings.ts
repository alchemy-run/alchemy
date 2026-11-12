/**
 * How ClickHouse Cloud bindings reach the Cloud API from any host.
 *
 * The ClickHouse Cloud API authenticates only with organization API keys:
 * it trusts no OIDC issuer or workload identity, so no host can federate
 * into it. Each binding therefore creates, per host, a `RoleManagement.Role`
 * whose one policy allows exactly the binding's permissions on the bound
 * service (`instance/<serviceId>`) or organization
 * (`organization/<organizationId>`), and an `ApiKeys.ApiKey` holding only
 * that role. The role comes first: organizations on custom roles (V2)
 * refuse a key created without one, and a key can't take its permissions
 * from roles declared later without the two resources referring to each
 * other. A host with several bindings holds one key per binding, each
 * counted against the organization's `api-keys-per-organization` quota.
 * The key travels to the host as a
 * `Redacted` value through `RuntimeContext`, so it works on any runtime
 * (Cloudflare Workers, Lambda, containers). The deployer's own key never
 * leaves the deploying machine.
 */
import { Credentials } from "@distilled.cloud/clickhouse-cloud/Credentials";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { ApiKey } from "./ApiKeys/ApiKey.ts";
import type { Organization } from "./Organization/Organization.ts";
import { Role } from "./RoleManagement/Role.ts";

/**
 * Group permissions by the scope they act in (`control-plane:service`,
 * `sql-console:database`, …): a policy may hold permissions of one scope
 * only ("All permissions in a policy must target the same resource scope").
 */
const byScope = (permissions: readonly string[]) => {
  const groups = new Map<string, string[]>();
  for (const permission of permissions) {
    const scope = permission.split(":").slice(0, 2).join(":");
    groups.set(scope, [...(groups.get(scope) ?? []), permission]);
  }
  return [...groups.values()];
};

/** A resource that lives in one service: a service, a ClickPipe, a saved query, …. */
export interface ServiceScoped {
  readonly LogicalId: string;
  readonly serviceId: Output.Output<string, never>;
  readonly organizationId: Output.Output<string, never>;
}

/** Runs ClickHouse Cloud SDK effects with the host's own API key. */
export type Run<Ids> = <A, E>(
  call: (ids: Ids) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) => Effect.Effect<A, E, RuntimeContext>;

/** What a binding gets from {@link Bind}: a way to run SDK calls as the host's key. */
export interface ClickHouseCloudAccess {
  readonly authorize: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, Credentials | HttpClient.HttpClient> | RuntimeContext>;
}

/**
 * Resolve once, when a binding's layer is built: returns a function that
 * creates (at deploy) a role allowing `permissions` on `scope` and a key
 * holding only that role, both named after the host, `binding` and the
 * bound resource. It returns the key resource (whose `id` other resources
 * can allow, as a Query API endpoint does) and accessors that read the key
 * back at runtime.
 */
export const BindKey = Effect.gen(function* () {
  const Key = yield* ApiKey;
  const Grant = yield* Role;
  return Effect.fn(function* (
    binding: string,
    target: { readonly LogicalId: string },
    scope: Output.Output<string>,
    permissions: readonly string[],
  ) {
    const host = yield* Binding.Host;
    const hostId = host?.LogicalId ?? "";
    const prefix = `${hostId}${binding}${target.LogicalId}`;
    const role = yield* Grant(`${prefix}Role`, {
      policies: byScope(permissions).map((group) => ({
        allowDeny: "ALLOW" as const,
        permissions: group,
        resources: [scope],
      })),
    });
    const key = yield* Key(`${prefix}Key`, { assignedRoleIds: [role.roleId] });
    return {
      key,
      keyId: yield* key.keyId,
      keySecret: yield* key.keySecret,
      apiBaseUrl: yield* key.apiBaseUrl,
    };
  });
});

/**
 * Resolve once, when a binding's layer is built: returns a function that
 * creates the binding's role and key ({@link BindKey}) and returns the
 * {@link ClickHouseCloudAccess} that calls the API with that key, at the
 * API origin the key was created against.
 */
export const Bind = Effect.gen(function* () {
  const bindKey = yield* BindKey;
  return Effect.fn(function* (
    binding: string,
    target: { readonly LogicalId: string },
    scope: Output.Output<string>,
    permissions: readonly string[],
  ) {
    const { keyId, keySecret, apiBaseUrl } = yield* bindKey(binding, target, scope, permissions);
    const credentials = Effect.gen(function* () {
      return {
        keyId: yield* keyId,
        keySecret: yield* keySecret,
        apiBaseUrl: yield* apiBaseUrl,
      };
    });
    return {
      authorize: (effect) =>
        Effect.flatMap(credentials, (config) =>
          effect.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(Credentials, Effect.succeed(config)),
                FetchHttpClient.layer,
              ),
            ),
          ),
        ),
    } satisfies ClickHouseCloudAccess;
  });
});

/**
 * Bind to one service: grants `permissions` on `instance/<serviceId>` and
 * returns a runner that receives the service's IDs.
 */
export const BindService = Effect.gen(function* () {
  const bind = yield* Bind;
  return Effect.fn(function* (
    binding: string,
    target: ServiceScoped,
    permissions: readonly string[],
  ) {
    const { authorize } = yield* bind(
      binding,
      target,
      Output.interpolate`instance/${target.serviceId}`,
      permissions,
    );
    const serviceId = yield* target.serviceId;
    const organizationId = yield* target.organizationId;
    const run: Run<{ organizationId: string; serviceId: string }> = (call) =>
      Effect.gen(function* () {
        const ids = { organizationId: yield* organizationId, serviceId: yield* serviceId };
        return yield* authorize(call(ids));
      });
    return run;
  });
});

/**
 * Bind to the organization: grants `permissions` on
 * `organization/<organizationId>` and returns a runner that receives the
 * organization ID.
 */
export const BindOrganization = Effect.gen(function* () {
  const bind = yield* Bind;
  return Effect.fn(function* (
    binding: string,
    target: Organization,
    permissions: readonly string[],
  ) {
    const { authorize } = yield* bind(
      binding,
      target,
      Output.interpolate`organization/${target.organizationId}`,
      permissions,
    );
    const organizationId = yield* target.organizationId;
    const run: Run<{ organizationId: string }> = (call) =>
      Effect.gen(function* () {
        const ids = { organizationId: yield* organizationId };
        return yield* authorize(call(ids));
      });
    return run;
  });
});
