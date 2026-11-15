import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { ClickHouseCloudAuth } from "@alchemy.run/clickhouse-cloud/AuthProvider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as roles from "@distilled.cloud/clickhouse-cloud/role_management";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { bindingTags as tags, getJson, noCloudflare } from "../fixtures/bindings.ts";
import { Analytics, NumbersEndpoint, StationsPipe } from "../fixtures/resources.ts";
import ClickHouseServiceWorker from "../fixtures/service-worker.ts";
import ClickHouseSqlWorker from "../fixtures/sql-worker.ts";

// Deploys its own service (minutes to create, billed compute), so it also
// needs CLICKHOUSE_CLOUD_TEST_SLOW=1 and a free service slot.
const skipped = noCloudflare || !process.env.CLICKHOUSE_CLOUD_TEST_SLOW;

/** Roles the bindings created start with the stack name (truncated physical names). */
const ROLE_PREFIX = "ClickHouseCloudServi";

const providers = Layer.mergeAll(ClickHouseCloud.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ClickHouseCloudServiceBindings",
  // Local state: the shared Cloudflare state store of the test account is
  // on an older schema, and upgrading it is the account owner's call.
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const analytics = yield* Analytics;
    const pipe = yield* StationsPipe;
    const endpoint = yield* NumbersEndpoint;
    const worker = yield* ClickHouseServiceWorker;
    const sqlWorker = yield* ClickHouseSqlWorker;
    return {
      url: worker.url.as<string>(),
      sqlUrl: sqlWorker.url.as<string>(),
      serviceId: analytics.serviceId,
      organizationId: analytics.organizationId,
      clickPipeId: pipe.clickPipeId,
      endpointId: endpoint.endpointId,
    };
  }),
);

const stack = beforeAll(
  skipped
    ? Effect.succeed({
        url: "",
        sqlUrl: "",
        serviceId: "",
        organizationId: "",
        clickPipeId: "",
        endpointId: "",
      })
    : deploy(Stack),
  { timeout: 3_600_000 },
);
afterAll.skipIf(skipped || !!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });

const get = getJson(stack);
const getSql = getJson(Effect.map(stack, ({ sqlUrl }) => ({ url: sqlUrl })));

/** Out-of-band reads with the deployer's credentials. */
const outOfBand = Effect.provide(
  ClickHouseCloud.fromAuthProvider().pipe(Layer.provide(ClickHouseCloudAuth)),
);

// The state test stops and restarts the service, so the file runs in order
// with it last.
describe.skipIf(skipped).sequential("ClickHouseCloud service bindings", () => {
  test(
    "GetService reads the bound service, running after the deploy",
    Effect.gen(function* () {
      const { serviceId } = yield* stack;
      expect(yield* get<{ id: string; state: string }>("/service")).toEqual({
        id: serviceId,
        state: "running",
      });
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "ListBackups and GetBackup list only this service's backups and read the newest by ID",
    Effect.gen(function* () {
      const { serviceId } = yield* stack;
      const body = yield* get<{ serviceIds: string[]; firstId: string; fetchedId: string }>(
        "/backups",
      );
      expect(body.serviceIds.filter((id) => id !== serviceId)).toEqual([]);
      expect(body.fetchedId).toEqual(body.firstId);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "GetServicePrometheusMetrics scrapes the Prometheus text format",
    Effect.gen(function* () {
      const { text } = yield* get<{ text: string }>("/metrics");
      expect(text).toContain("# TYPE");
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "DiscoverClickPipeSchema infers the public CSV's columns",
    Effect.gen(function* () {
      const { fields } = yield* get<{
        fields: { name: string; type: string; isVirtual: boolean }[];
      }>("/discover");
      // The CSV's columns, then the metadata ClickPipes adds for object storage.
      expect(fields.filter((f) => !f.isVirtual).map((f) => f.name)).toEqual(["station", "avg"]);
      expect(fields.filter((f) => f.isVirtual).map((f) => f.name)).toEqual([
        "_path",
        "_file",
        "_size",
        "_time",
      ]);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "GetClickPipe reads the bound one-shot pipe, completed",
    Effect.gen(function* () {
      const { clickPipeId } = yield* stack;
      expect(yield* get<{ id: string; state: string }>("/pipe")).toEqual({
        id: clickPipeId,
        state: "Completed",
      });
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "UpdateClickPipeState sends stop and start; a finished one-shot pipe stays completed",
    Effect.gen(function* () {
      const { clickPipeId } = yield* stack;
      // Live: ClickHouse accepts both commands on a one-shot pipe that has
      // finished and leaves it `Completed` (`resync` is for database pipes).
      expect(yield* get<{ id: string; state: string }>("/pipe/state?command=stop")).toEqual({
        id: clickPipeId,
        state: "Completed",
      });
      expect(yield* get<{ id: string; state: string }>("/pipe/state?command=start")).toEqual({
        id: clickPipeId,
        state: "Completed",
      });
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "RunQueryApiEndpoint runs the endpoint with the host's key and query variables",
    Effect.gen(function* () {
      const { rows } = yield* get<{ rows: unknown[] }>("/numbers?n=3");
      expect(rows).toEqual([{ number: 0 }, { number: 1 }, { number: 2 }]);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "Ping reaches the service over the ClickHouse HTTP interface",
    Effect.gen(function* () {
      expect(yield* getSql<{ ok: boolean }>("/ping")).toEqual({ ok: true });
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "each binding's role is scoped to the one service; only the state and ClickPipes bindings may manage",
    Effect.gen(function* () {
      const { organizationId, serviceId } = yield* stack;
      const result = yield* roles.listOrganizationRoles({ organizationId });
      const scoped = (result ?? []).filter(
        (r) => r.type === "custom" && (r.name ?? "").startsWith(ROLE_PREFIX),
      );
      // ClickHouse adds the permissions a declared one implies, so each role
      // is classified by what it may change.
      const kinds = scoped
        .map((r) => {
          // One policy per permission scope (ClickPipes add a database one),
          // all on this service.
          for (const policy of r.policies ?? []) {
            expect(policy.resources).toEqual([`instance/${serviceId}`]);
          }
          const permissions = (r.policies ?? []).flatMap((p) => p.permissions ?? []);
          expect(permissions.filter((p) => p.includes(":delete"))).toEqual([]);
          return permissions.includes("control-plane:service:manage")
            ? "manage"
            : permissions.includes("control-plane:service:manage-clickpipes")
              ? "manage-clickpipes"
              : "view";
        })
        .sort();
      // UpdateServiceState manages the service; DiscoverClickPipeSchema,
      // UpdateClickPipeState and GetClickPipe hold the ClickPipes permission
      // (reading a pipe needs it too); GetService, ListBackups, GetBackup,
      // GetServicePrometheusMetrics and RunQueryApiEndpoint only view.
      expect(kinds).toEqual([
        "manage",
        "manage-clickpipes",
        "manage-clickpipes",
        "manage-clickpipes",
        ...Array.from({ length: 5 }, () => "view"),
      ]);
    }).pipe(outOfBand),
    { tags, timeout: 120_000 },
  );

  test(
    "UpdateServiceState stops the bound service and starts it again",
    Effect.gen(function* () {
      const { serviceId } = yield* stack;
      const until = (state: string) =>
        get<{ id: string; state: string }>("/service").pipe(
          Effect.repeat({
            schedule: Schedule.spaced("15 seconds").pipe(Schedule.upTo({ duration: "10 minutes" })),
            until: (s) => s.state === state,
          }),
        );
      // `awake` is refused unless the service is idle ("Service must be in
      // idle state to awake"), so the binding is proven with stop/start.
      expect((yield* get<{ id: string }>("/state?command=stop")).id).toEqual(serviceId);
      expect((yield* until("stopped")).state).toEqual("stopped");
      expect((yield* get<{ id: string }>("/state?command=start")).id).toEqual(serviceId);
      expect((yield* until("running")).state).toEqual("running");
    }),
    { tags, timeout: 1_500_000 },
  );
});
