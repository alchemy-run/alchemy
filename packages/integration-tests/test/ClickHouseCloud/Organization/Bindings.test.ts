import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { ClickHouseCloudAuth } from "@alchemy.run/clickhouse-cloud/AuthProvider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as roles from "@distilled.cloud/clickhouse-cloud/role_management";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindingTags as tags, getJson, noCloudflare } from "../fixtures/bindings.ts";
import ClickHouseOrgWorker from "../fixtures/organization-worker.ts";
import { Org } from "../fixtures/resources.ts";

/** Roles the bindings created start with the stack name (truncated physical names). */
const ROLE_PREFIX = "ClickHouseCloudOrgBi";

const providers = Layer.mergeAll(ClickHouseCloud.providers(), Cloudflare.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const Stack = Alchemy.Stack(
  "ClickHouseCloudOrgBindings",
  // Local state: the shared Cloudflare state store of the test account is
  // on an older schema, and upgrading it is the account owner's call.
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const org = yield* Org;
    const worker = yield* ClickHouseOrgWorker;
    return { url: worker.url.as<string>(), organizationId: org.organizationId };
  }),
);

const stack = beforeAll(
  noCloudflare ? Effect.succeed({ url: "", organizationId: "" }) : deploy(Stack),
);
afterAll.skipIf(noCloudflare || !!process.env.NO_DESTROY)(destroy(Stack));

const get = getJson(stack);

/** Out-of-band reads with the deployer's credentials. */
const outOfBand = Effect.provide(
  ClickHouseCloud.fromAuthProvider().pipe(Layer.provide(ClickHouseCloudAuth)),
);

describe.skipIf(noCloudflare)("ClickHouseCloud organization bindings", () => {
  test(
    "ListActivities and GetActivity: the last hour of the audit log, and one entry by ID",
    Effect.gen(function* () {
      const body = yield* get<{ count: number; firstId: string; fetchedId: string }>("/activities");
      // Deploying the stack created the Worker's key and roles, so the
      // last hour holds activity.
      expect(body.count).toBeGreaterThan(0);
      expect(body.fetchedId).toEqual(body.firstId);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "ListOrganizationQuotas and GetOrganizationQuota count the Worker's key",
    Effect.gen(function* () {
      const body = yield* get<{
        codes: string[];
        keys: { code: string; value: number; usage: number };
      }>("/quotas");
      expect(body.codes).toContain("api-keys-per-organization");
      expect(body.keys.code).toEqual("api-keys-per-organization");
      expect(body.keys.usage).toBeGreaterThanOrEqual(1);
      expect(body.keys.value).toBeGreaterThanOrEqual(body.keys.usage);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "GetOrganizationPrometheusDiscovery returns target groups of this organization only",
    Effect.gen(function* () {
      const { organizationId } = yield* stack;
      const body = yield* get<{ orgIds: string[] }>("/discovery");
      expect(body.orgIds.filter((id) => id !== organizationId)).toEqual([]);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "GetUsageCost and GetCreditBalances read the last week's cost and the credits left",
    Effect.gen(function* () {
      const body = yield* get<{
        grandTotal: number;
        costEntities: string[];
        remaining: number;
        balances: number;
      }>("/billing");
      // The test organization runs services, so the week has a cost; it
      // is a trial, so it has a credit balance.
      expect(body.grandTotal).toBeGreaterThan(0);
      expect(body.costEntities).toContain("service");
      expect(body.remaining).toBeGreaterThan(0);
      expect(body.balances).toBeGreaterThanOrEqual(1);
    }),
    { tags, timeout: 120_000 },
  );

  test(
    "each binding's role allows only view permissions on the organization",
    Effect.gen(function* () {
      const { organizationId } = yield* stack;
      const { result } = yield* roles.listOrganizationRoles({ organizationId });
      const scoped = (result ?? []).filter(
        (r) => r.type === "custom" && (r.name ?? "").startsWith(ROLE_PREFIX),
      );
      // One role per binding the Worker holds.
      expect(scoped.length).toEqual(7);
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
