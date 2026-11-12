import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { ClickHouseCloudAuth } from "@alchemy.run/clickhouse-cloud/AuthProvider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as roles from "@distilled.cloud/clickhouse-cloud/role_management";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { Analytics } from "../fixtures/resources.ts";
import ClickHouseServiceWorker from "../fixtures/service-worker.ts";

// Deploys a service: minutes to create and billed compute. Set
// CLICKHOUSE_CLOUD_TEST_SLOW=1 to run it.
const slow = !process.env.CLICKHOUSE_CLOUD_TEST_SLOW;

// The fixture host is a Cloudflare Worker, so these suites need Cloudflare
// credentials: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the
// environment, or CLICKHOUSE_CLOUD_TEST_CLOUDFLARE_PROFILE=1 when the
// selected profile (`--profile`) has Cloudflare configured. A profile can't
// be inspected before tests register, so it is opted into explicitly.
const cloudflare =
  !!process.env.CLOUDFLARE_ACCOUNT_ID || !!process.env.CLICKHOUSE_CLOUD_TEST_CLOUDFLARE_PROFILE;
const skipReason = slow
  ? "CLICKHOUSE_CLOUD_TEST_SLOW is not set"
  : cloudflare
    ? undefined
    : "no Cloudflare credentials for the Worker host";
const skipped = skipReason !== undefined;
/** The test title, with the reason when the suite skips. */
const named = (title: string) => (skipReason ? `${title} [skipped: ${skipReason}]` : title);

/** Roles the bindings created start with the stack name (truncated physical names). */
const ROLE_PREFIX = "ClickHouseCloudServi";

const providers = Layer.mergeAll(ClickHouseCloud.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ClickHouseCloudServiceBindings",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const analytics = yield* Analytics;
    const worker = yield* ClickHouseServiceWorker;
    return {
      url: worker.url.as<string>(),
      serviceId: analytics.serviceId,
      organizationId: analytics.organizationId,
    };
  }),
);

// No `beforeAll.skipIf`: deploy only when enabled, else hand the (skipped)
// tests an empty handle.
const stack = beforeAll(
  skipped ? Effect.succeed({ url: "", serviceId: "", organizationId: "" }) : deploy(Stack),
  { timeout: 3_600_000 },
);
afterAll.skipIf(skipped || !!process.env.NO_DESTROY)(destroy(Stack), { timeout: 3_600_000 });

/** The Worker answered 500: the route ran and failed, so there is nothing to retry. */
class RouteFailed extends Data.TaggedError("RouteFailed")<{ path: string; body: string }> {
  override get message() {
    return `${this.path} failed: ${this.body}`;
  }
}

/** Cloudflare hasn't routed the fresh workers.dev script yet. */
class NotPropagated extends Data.TaggedError("NotPropagated")<{}> {}

const fetchRoute = (url: string, path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(`${url}${path}`).pipe(
      Effect.flatMap((res) =>
        res.status === 500
          ? Effect.flatMap(res.text, (body) =>
              body.includes("Script not found")
                ? Effect.fail(new NotPropagated())
                : Effect.succeed({ res, body }),
            )
          : Effect.map(HttpClientResponse.filterStatusOk(res), (res) => ({ res, body: "" })),
      ),
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
    );
    if (res.res.status === 500) return yield* new RouteFailed({ path, body: res.body });
    return res.res;
  });

const get = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* fetchRoute(url, path);
    return res;
  });

/** Out-of-band reads with the deployer's credentials. */
const outOfBand = Effect.provide(
  ClickHouseCloud.fromAuthProvider().pipe(Layer.provide(ClickHouseCloudAuth)),
);

const tags = [
  "provider:clickhouse-cloud",
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "live",
];

// The state test stops and restarts the shared service, so the file runs in
// order with it last.
describe.sequential("ClickHouseCloud service bindings", () => {
  describe("GetService", () => {
    test.skipIf(skipped)(
      named("reads the bound service"),
      Effect.gen(function* () {
        const { serviceId } = yield* stack;
        const body = (yield* (yield* get("/service")).json) as any;
        expect(body.id).toEqual(serviceId);
        expect(["running", "idle", "awaking", "starting"]).toContain(body.state);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ListBackups and GetBackup", () => {
    test.skipIf(skipped)(
      named("lists the service's backups and reads the newest by ID"),
      Effect.gen(function* () {
        const { serviceId } = yield* stack;
        const body = (yield* (yield* get("/backups")).json) as any;
        // A new service may have no backup yet; every listed one is this service's.
        for (const id of body.serviceIds) expect(id).toEqual(serviceId);
        expect(body.fetchedId).toEqual(body.firstId);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("GetServicePrometheusMetrics", () => {
    test.skipIf(skipped)(
      named("scrapes the service's metrics in the Prometheus text format"),
      Effect.gen(function* () {
        const text = yield* (yield* get("/metrics")).text;
        expect(text).toContain("# TYPE");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("least privilege", () => {
    test.skipIf(skipped)(
      named(
        "view bindings get control-plane:service:view and UpdateServiceState gets manage, all on the one service",
      ),
      Effect.gen(function* () {
        const { organizationId, serviceId } = yield* stack;
        const { result } = yield* roles.listOrganizationRoles({ organizationId });
        const scoped = (result ?? []).filter(
          (r) =>
            r.type === "custom" &&
            (r.name ?? "").startsWith(ROLE_PREFIX) &&
            (r.policies ?? []).some((p) => (p.resources ?? []).includes(`instance/${serviceId}`)),
        );
        // ClickHouse adds the permissions a declared one implies, so each role
        // is classified by its declared permission: one manage (the state
        // binding), four view-only, and none that may delete.
        const kinds = scoped
          .map((r) => {
            expect(r.policies?.length).toEqual(1);
            const permissions = r.policies?.[0]?.permissions ?? [];
            expect(r.policies?.[0]?.resources).toEqual([`instance/${serviceId}`]);
            expect(permissions.filter((p) => p.includes(":delete"))).toEqual([]);
            return permissions.includes("control-plane:service:manage")
              ? "manage"
              : permissions.includes("control-plane:service:view")
                ? "view"
                : "other";
          })
          .sort();
        expect(kinds).toEqual(["manage", "view", "view", "view", "view"]);
      }).pipe(outOfBand),
      { tags, timeout: 120_000 },
    );
  });

  describe("UpdateServiceState", () => {
    test.skipIf(skipped)(
      named("stops the bound service and starts it again"),
      Effect.gen(function* () {
        const { serviceId } = yield* stack;
        const stateOf = Effect.gen(function* () {
          const body = (yield* (yield* get("/service")).json) as any;
          return body.state as string;
        });
        const until = (done: (state: string) => boolean) =>
          stateOf.pipe(
            Effect.repeat({ schedule: Schedule.spaced("15 seconds"), until: done, times: 24 }),
          );

        // `awake` is refused unless the service is idle ("Service must be in
        // idle state to awake"), so the binding is proven with stop/start.
        const stopping = (yield* (yield* get("/state?command=stop")).json) as any;
        expect(stopping.id).toEqual(serviceId);
        expect(yield* until((state) => state === "stopped")).toEqual("stopped");

        const starting = (yield* (yield* get("/state?command=start")).json) as any;
        expect(starting.id).toEqual(serviceId);
        const running = yield* until((state) => state === "running" || state === "idle");
        expect(running === "running" || running === "idle").toBe(true);
      }),
      { tags, timeout: 900_000 },
    );
  });
});
