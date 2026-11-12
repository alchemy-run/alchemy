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
import ClickHouseOrgWorker from "../fixtures/organization-worker.ts";
import { Org } from "../fixtures/resources.ts";

// The fixture host is a Cloudflare Worker, so these suites need Cloudflare
// credentials: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the
// environment, or CLICKHOUSE_CLOUD_TEST_CLOUDFLARE_PROFILE=1 when the
// selected profile (`--profile`) has Cloudflare configured. A profile can't
// be inspected before tests register, so it is opted into explicitly.
const cloudflare =
  !!process.env.CLOUDFLARE_ACCOUNT_ID || !!process.env.CLICKHOUSE_CLOUD_TEST_CLOUDFLARE_PROFILE;
const skipReason = cloudflare ? undefined : "no Cloudflare credentials for the Worker host";
const skipped = skipReason !== undefined;
/** The test title, with the reason when the suite skips. */
const named = (title: string) => (skipReason ? `${title} [skipped: ${skipReason}]` : title);

/** Roles the bindings created start with the stack name (truncated physical names). */
const ROLE_PREFIX = "ClickHouseCloudOrgBi";

const providers = Layer.mergeAll(ClickHouseCloud.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ClickHouseCloudOrgBindings",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const org = yield* Org;
    const worker = yield* ClickHouseOrgWorker;
    return { url: worker.url.as<string>(), organizationId: org.organizationId };
  }),
);

// No `beforeAll.skipIf`: deploy only when enabled, else hand the (skipped)
// tests an empty handle.
const stack = beforeAll(skipped ? Effect.succeed({ url: "", organizationId: "" }) : deploy(Stack));
afterAll.skipIf(skipped || !!process.env.NO_DESTROY)(destroy(Stack));

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
    return (yield* res.json) as any;
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

describe("ListActivities and GetActivity", () => {
  test.skipIf(skipped)(
    named("lists the last hour of the audit log and reads one entry by ID"),
    Effect.gen(function* () {
      const body = yield* get("/activities");
      // Deploying the stack created the Worker's key and roles, so the
      // last hour holds activity.
      expect(body.count).toBeGreaterThan(0);
      expect(body.fetchedId).toEqual(body.firstId);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("ListOrganizationQuotas and GetOrganizationQuota", () => {
  test.skipIf(skipped)(
    named("lists the quotas and reads the API key quota, which counts the Worker's key"),
    Effect.gen(function* () {
      const body = yield* get("/quotas");
      expect(body.codes).toContain("api-keys-per-organization");
      expect(body.keys.code).toEqual("api-keys-per-organization");
      expect(body.keys.usage).toBeGreaterThanOrEqual(1);
      expect(body.keys.value).toBeGreaterThanOrEqual(body.keys.usage);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("GetOrganizationPrometheusDiscovery", () => {
  test.skipIf(skipped)(
    named("returns http_sd target groups, all in this organization"),
    Effect.gen(function* () {
      const { organizationId } = yield* stack;
      const body = yield* get("/discovery");
      for (const id of body.orgIds) expect(id).toEqual(organizationId);
    }),
    { tags, timeout: 120_000 },
  );
});

describe("least privilege", () => {
  test.skipIf(skipped)(
    named("each binding's role allows only control-plane:organization:view on the organization"),
    Effect.gen(function* () {
      const { organizationId } = yield* stack;
      const { result } = yield* roles.listOrganizationRoles({ organizationId });
      const scoped = (result ?? []).filter(
        (r) =>
          r.type === "custom" &&
          (r.name ?? "").startsWith(ROLE_PREFIX) &&
          (r.policies ?? []).some((p) =>
            (p.resources ?? []).includes(`organization/${organizationId}`),
          ),
      );
      // One role per binding: activities, activity, quotas, quota, discovery.
      expect(scoped.length).toBeGreaterThanOrEqual(5);
      // ClickHouse adds the permissions `view` implies (`view-udfs`); none
      // of them may write.
      for (const role of scoped) {
        expect(role.policies?.length).toEqual(1);
        const [policy] = role.policies ?? [];
        expect(policy?.allowDeny).toEqual("ALLOW");
        expect(policy?.resources).toEqual([`organization/${organizationId}`]);
        expect(policy?.permissions).toContain("control-plane:organization:view");
        expect(
          (policy?.permissions ?? []).filter((p) => /:(manage|delete|create)/.test(p)),
        ).toEqual([]);
      }
    }).pipe(outOfBand),
    { tags, timeout: 120_000 },
  );
});
