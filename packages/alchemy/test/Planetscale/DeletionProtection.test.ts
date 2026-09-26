import * as Planetscale from "@/Planetscale";
import * as Provider from "@/Provider";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Credentials } from "@distilled.cloud/planetscale/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

const ORG = "test-org";
const DB = "protected-db";
const API = "https://api.planetscale.com/v1";
const DB_PATH = `/organizations/${ORG}/databases/${DB}`;

const region = {
  id: "region_1",
  provider: "AWS",
  enabled: true,
  public_ip_addresses: [],
  display_name: "AWS us-east-1",
  location: "Ashburn, Virginia",
  slug: "us-east",
  current_default: true,
  mysql_supported: true,
  postgresql_supported: true,
};

/**
 * In-memory stand-in for one PlanetScale database. Serves the database,
 * settings and default-branch endpoints the database providers call and
 * records every request so tests can assert on the wire traffic.
 */
const fakePlanetscale = (initial: {
  kind: "mysql" | "postgresql";
  deletionProtected: boolean;
  exists?: boolean;
}) => {
  const db = { ...initial, exists: initial.exists ?? true };
  const requests: { method: string; path: string; body: any }[] = [];

  const database = () => ({
    id: "db_1",
    url: `${API}${DB_PATH}`,
    branches_url: `${API}${DB_PATH}/branches`,
    ready: true,
    region,
    html_url: `https://app.planetscale.com/${ORG}/${DB}`,
    name: DB,
    state: "ready",
    default_branch: "main",
    plan: "scaler",
    deletion_protected: db.deletionProtected,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    kind: db.kind,
  });

  const branch = () => ({
    id: "branch_1",
    name: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    restore_checklist_completed_at: null,
    schema_last_updated_at: null,
    kind: db.kind,
    state: "ready",
    cluster_name: "PS_10_AWS_X86",
    cluster_architecture: "x86_64",
    cluster_iops: null,
    ready: true,
    metal: false,
    production: true,
    safe_migrations: false,
    stale_schema: false,
    actor: null,
    restored_from_branch: null,
    private_edge_connectivity: false,
    has_replicas: false,
    has_read_only_replicas: false,
    html_url: `https://app.planetscale.com/${ORG}/${DB}/main`,
    url: `${API}${DB_PATH}/branches/main`,
    region,
    parent_branch: null,
  });

  const respond = (method: string, path: string, body: any) => {
    if (!db.exists) {
      return Response.json(
        { code: "not_found", message: "Not Found" },
        { status: 404 },
      );
    }
    if (path === DB_PATH && method === "GET") return Response.json(database());
    if (path === DB_PATH && method === "PATCH") {
      if (body?.deletion_protected !== undefined) {
        db.deletionProtected = body.deletion_protected;
      }
      return Response.json(database());
    }
    if (path === DB_PATH && method === "DELETE") {
      db.exists = false;
      return Response.json({});
    }
    if (path === `${DB_PATH}/branches/main` && method === "GET") {
      return Response.json(branch());
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  };

  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname.replace(/^\/v1/, "");
      const httpBody = request.body as HttpBody.HttpBody;
      const body =
        httpBody._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(httpBody.body))
          : undefined;
      requests.push({ method: request.method, path, body });
      return HttpClientResponse.fromWeb(
        request,
        respond(request.method, path, body),
      );
    }),
  );

  const layer = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Stage, "test"),
    Layer.succeed(Stack, {
      name: "test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(
      Credentials,
      Effect.succeed({
        tokenId: Redacted.make("test-id"),
        token: Redacted.make("test-token"),
        organization: ORG,
        apiBaseUrl: API,
      }),
    ),
  );

  return { db, requests, layer };
};

const session = { note: () => Effect.void, emit: () => Effect.void } as any;

const attrs = (deletionProtection: boolean) =>
  ({
    id: "db_1",
    name: DB,
    organization: ORG,
    deletionProtection,
  }) as any;

const deleteInput = (output: any) => ({
  id: "Db",
  fqn: "Db",
  instanceId: "instance",
  olds: {} as any,
  output,
  session,
  bindings: [] as any,
});

const engines = [
  {
    kind: "postgresql" as const,
    provider: Provider.findProvider(Planetscale.PostgresDatabase).pipe(
      Effect.provide(Planetscale.PostgresDatabaseProvider()),
    ),
  },
  {
    kind: "mysql" as const,
    provider: Provider.findProvider(Planetscale.MySQLDatabase).pipe(
      Effect.provide(Planetscale.MySQLDatabaseProvider()),
    ),
  },
];

describe(
  "Planetscale database deletion protection",
  { tags: ["unit", "provider:planetscale", "local"] },
  () => {
    for (const { kind, provider: findProvider } of engines) {
      it.live(`${kind}: delete refuses a protected database`, () => {
        const fake = fakePlanetscale({ kind, deletionProtected: true });
        return Effect.gen(function* () {
          const provider = yield* findProvider;

          const exit = yield* Effect.exit(
            provider.delete(deleteInput(attrs(true))),
          );

          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons.find((r) => r._tag === "Fail");
            expect(error?._tag === "Fail" && error.error).toMatchObject({
              _tag: "Planetscale::DeletionProtected",
              organization: ORG,
              database: DB,
            });
          }
          // Protection is never turned off to force the delete.
          expect(fake.requests.map((r) => r.method)).toEqual(["GET"]);
          expect(fake.db.exists).toBe(true);
        }).pipe(Effect.provide(fake.layer));
      });

      it.live(`${kind}: delete removes an unprotected database`, () => {
        const fake = fakePlanetscale({ kind, deletionProtected: false });
        return Effect.gen(function* () {
          const provider = yield* findProvider;

          yield* provider.delete(deleteInput(attrs(false)));

          expect(fake.requests.map((r) => r.method)).toEqual(["GET", "DELETE"]);
          expect(fake.db.exists).toBe(false);
        }).pipe(Effect.provide(fake.layer));
      });

      it.live(`${kind}: delete of a missing database succeeds`, () => {
        const fake = fakePlanetscale({
          kind,
          deletionProtected: false,
          exists: false,
        });
        return Effect.gen(function* () {
          const provider = yield* findProvider;

          yield* provider.delete(deleteInput(attrs(false)));

          expect(fake.requests.map((r) => r.method)).toEqual(["GET"]);
        }).pipe(Effect.provide(fake.layer));
      });
    }

    const reconcile = (
      news: Planetscale.PostgresDatabaseProps,
      fake: ReturnType<typeof fakePlanetscale>,
    ) =>
      Effect.gen(function* () {
        const provider = yield* engines[0]!.provider;
        return yield* provider.reconcile({
          id: "Db",
          fqn: "Db",
          instanceId: "instance",
          news,
          olds: news,
          output: undefined,
          session,
          bindings: [] as any,
        });
      }).pipe(Effect.provide(fake.layer));

    const settingsPatch = (fake: ReturnType<typeof fakePlanetscale>) =>
      fake.requests.find((r) => r.method === "PATCH" && r.path === DB_PATH)
        ?.body;

    it.live("reconcile applies deletionProtection to the database", () =>
      Effect.gen(function* () {
        const fake = fakePlanetscale({
          kind: "postgresql",
          deletionProtected: false,
        });

        const output = yield* reconcile(
          { name: DB, clusterSize: "PS_10", deletionProtection: true },
          fake,
        );

        expect(settingsPatch(fake)).toMatchObject({
          deletion_protected: true,
        });
        expect(output.deletionProtection).toBe(true);
        expect(fake.db.deletionProtected).toBe(true);
      }),
    );

    it.live("reconcile turns deletionProtection off when set to false", () =>
      Effect.gen(function* () {
        const fake = fakePlanetscale({
          kind: "postgresql",
          deletionProtected: true,
        });

        const output = yield* reconcile(
          { name: DB, clusterSize: "PS_10", deletionProtection: false },
          fake,
        );

        expect(settingsPatch(fake)).toMatchObject({
          deletion_protected: false,
        });
        expect(output.deletionProtection).toBe(false);
      }),
    );

    it.live("reconcile leaves the live setting alone when unset", () =>
      Effect.gen(function* () {
        const fake = fakePlanetscale({
          kind: "postgresql",
          deletionProtected: true,
        });

        const output = yield* reconcile(
          { name: DB, clusterSize: "PS_10" },
          fake,
        );

        expect(settingsPatch(fake)).not.toHaveProperty("deletion_protected");
        expect(output.deletionProtection).toBe(true);
      }),
    );
  },
);
