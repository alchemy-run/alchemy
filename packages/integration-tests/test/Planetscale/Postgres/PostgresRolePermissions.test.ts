import { fromToken } from "@alchemy.run/planetscale/Credentials";
import {
  PostgresDefaultRole,
  PostgresDefaultRoleProvider,
} from "@alchemy.run/planetscale/Postgres/PostgresDefaultRole";
import {
  PostgresRole,
  PostgresRoleProvider,
  type PostgresRoleAttributes,
} from "@alchemy.run/planetscale/Postgres/PostgresRole";
import { expect, it } from "@alchemy.run/test";
import { PlanetScaleProtocol, Retry } from "@distilled.cloud/planetscale";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";

const password = Redacted.make("fixture-password");

const attributes: PostgresRoleAttributes = {
  id: "role_123",
  name: "reader",
  expiresAt: null,
  host: "db.planetscale.test",
  username: "reader",
  password,
  database: "app-db",
  databaseName: "postgres",
  origin: {
    scheme: "postgres",
    host: "db.planetscale.test",
    port: 5432,
    database: "postgres",
    user: "reader",
    password,
  },
  pooledOrigin: {
    scheme: "postgres",
    host: "db.planetscale.test",
    port: 6432,
    database: "postgres",
    user: "reader",
    password,
  },
  privateHost: "private.planetscale.test",
  privateConnectionServiceName: "service",
  connectionUrl: Redacted.make("postgres://reader:fixture-password@db.planetscale.test/postgres"),
  connectionUrlPooled: Redacted.make(
    "postgres://reader:fixture-password@db.planetscale.test:6432/postgres",
  ),
  inheritedRoles: ["pg_read_all_data"],
  withReplication: false,
  successor: "postgres",
  organization: "example-org",
  branch: "main",
  ttl: null,
};

const readInput = {
  id: "Reader",
  fqn: "Reader",
  instanceId: "instance",
  olds: { database: "app-db", inheritedRoles: ["pg_read_all_data"] },
  output: attributes,
};

const providerLayer = (respond: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  Layer.mergeAll(PostgresRoleProvider(), PostgresDefaultRoleProvider()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        fromToken({
          organization: "example-org",
          tokenId: "fixture-id",
          token: "fixture-secret",
          apiBaseUrl: "https://api.planetscale.test/v1",
        }),
        PlanetScaleProtocol,
        Layer.succeed(Retry.Retry, { while: () => false }),
        Layer.succeed(Stage, "test"),
        Layer.succeed(Stack, {
          name: "planetscale-permissions",
          stage: "test",
          resources: {},
          bindings: {},
          actions: {},
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => HttpClientResponse.fromWeb(request, respond(request))),
          ),
        ),
      ),
    ),
  );

it.effect(
  "does not report an existing PostgreSQL role as missing when PlanetScale denies the read",
  () =>
    Effect.gen(function* () {
      const provider = yield* PostgresRole.Provider;
      const result = yield* Effect.result(provider.read!(readInput));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ _tag: "Forbidden", code: 403 });
      }
    }).pipe(
      Effect.provide(
        providerLayer(() =>
          Response.json({ code: 403, message: "Role access denied" }, { status: 403 }),
        ),
      ),
    ),
  { tags: ["unit", "local", "provider:planetscale"] },
);

it.effect(
  "a missing PostgreSQL role still reads as absent",
  () =>
    Effect.gen(function* () {
      const provider = yield* PostgresRole.Provider;
      expect(yield* provider.read!(readInput)).toBeUndefined();
    }).pipe(
      Effect.provide(
        providerLayer(() =>
          Response.json({ code: 404, message: "Role not found" }, { status: 404 }),
        ),
      ),
    ),
  { tags: ["unit", "local", "provider:planetscale"] },
);

const observedRole = {
  id: "role_123",
  name: "reader",
  access_host_url: "observed.planetscale.test",
  private_access_host_url: "observed-private.planetscale.test",
  private_connection_service_name: "observed-service",
  username: "reader",
  base_username: "reader",
  password: null,
  database_name: "postgres",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  expires_at: null,
  dropped_at: null,
  disabled_at: null,
  drop_failed: null,
  ready: true,
  expired: false,
  default: false,
  ttl: null,
  inherited_roles: ["pg_read_all_data"],
  with_replication: false,
  branch: {
    id: "branch_1",
    name: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
  },
  actor: { id: "actor_1", display_name: "Example", avatar_url: "" },
  query_safety_settings: { require_where_on_delete: "off", require_where_on_update: "off" },
};

it.effect(
  "an authorized role read refreshes cloud attributes without rotating its cached password",
  () =>
    Effect.gen(function* () {
      const provider = yield* PostgresRole.Provider;
      const observed = yield* provider.read!(readInput);
      expect(observed).toMatchObject({
        id: "role_123",
        name: "reader",
        host: "observed.planetscale.test",
        privateHost: "observed-private.planetscale.test",
      });
      expect(Redacted.value(observed!.password)).toBe("fixture-password");
    }).pipe(Effect.provide(providerLayer(() => Response.json(observedRole)))),
  { tags: ["unit", "local", "provider:planetscale"] },
);

const region = {
  id: "region_1",
  provider: "AWS",
  enabled: true,
  public_ip_addresses: [],
  display_name: "US East",
  location: "US East",
  slug: "us-east",
  current_default: true,
  mysql_supported: true,
  postgresql_supported: true,
  neki_supported: false,
};

const page = (data: ReadonlyArray<unknown>) =>
  Response.json({
    type: "list",
    current_page: 1,
    per_page: 100,
    next_page: null,
    next_page_url: null,
    prev_page: null,
    prev_page_url: null,
    total_count: data.length,
    total_pages: 1,
    data,
  });

const database = {
  id: "database_1",
  name: "app-db",
  kind: "postgresql",
  state: "ready",
  ready: true,
  default_branch: "main",
  region,
  url: "https://api.planetscale.test/v1/organizations/example-org/databases/app-db",
  branches_url:
    "https://api.planetscale.test/v1/organizations/example-org/databases/app-db/branches",
  html_url: "https://app.planetscale.test/example-org/app-db",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const branch = {
  id: "branch_1",
  name: "main",
  kind: "postgresql",
  state: "ready",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  deleted_at: null,
  restore_checklist_completed_at: null,
  schema_last_updated_at: null,
  cluster_name: "PS_10",
  cluster_iops: null,
  ready: true,
  metal: false,
  production: true,
  safe_migrations: true,
  stale_schema: false,
  actor: null,
  restored_from_branch: null,
  private_edge_connectivity: false,
  has_replicas: false,
  has_read_only_replicas: false,
  html_url: "https://app.planetscale.test/example-org/app-db/main",
  url: "https://api.planetscale.test/v1/organizations/example-org/databases/app-db/branches/main",
  region,
  parent_branch: null,
};

const roleListResponse = (status: 403 | 404) => (request: HttpClientRequest.HttpClientRequest) => {
  if (request.url.includes("/roles")) {
    return Response.json(
      { code: status, message: status === 403 ? "Role list access denied" : "Branch not found" },
      { status },
    );
  }
  if (request.url.includes("/branches")) return page([branch]);
  if (request.url.includes("/databases")) return page([database]);
  throw new Error(`Unexpected PlanetScale request: ${request.url}`);
};

for (const role of [PostgresRole, PostgresDefaultRole] as const) {
  it.effect(
    `${role.Type} enumeration fails when PlanetScale denies listing roles`,
    () =>
      Effect.gen(function* () {
        const provider = yield* role.Provider;
        const result = yield* Effect.result(provider.list());
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ _tag: "Forbidden", code: 403 });
        }
      }).pipe(Effect.provide(providerLayer(roleListResponse(403)))),
    { tags: ["unit", "local", "provider:planetscale"] },
  );

  it.effect(
    `${role.Type} enumeration treats a missing branch as empty`,
    () =>
      Effect.gen(function* () {
        const provider = yield* role.Provider;
        expect(yield* provider.list()).toEqual([]);
      }).pipe(Effect.provide(providerLayer(roleListResponse(404)))),
    { tags: ["unit", "local", "provider:planetscale"] },
  );

  it.effect(
    `${role.Type} enumeration returns authorized roles of its own type`,
    () =>
      Effect.gen(function* () {
        const provider = yield* role.Provider;
        const rows = yield* provider.list();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: "role_123", organization: "example-org" });
      }).pipe(
        Effect.provide(
          providerLayer((request) =>
            request.url.includes("/roles")
              ? page([{ ...observedRole, default: role === PostgresDefaultRole }])
              : request.url.includes("/branches")
                ? page([branch])
                : page([database]),
          ),
        ),
      ),
    { tags: ["unit", "local", "provider:planetscale"] },
  );
}
