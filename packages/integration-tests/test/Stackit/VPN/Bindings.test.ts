import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as vpn from "@distilled.cloud/stackit/vpn";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import VpnBindingsWorker, {
  Backbone,
  Berlin,
  Inbound,
  PermitAll,
  PLAN,
  PRE_SHARED_KEY,
} from "./fixtures/worker.ts";
import { slow, SUITE_TIMEOUT } from "./vpn.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitVpnBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* VpnBindingsWorker;
    const gateway = yield* Backbone;
    const connection = yield* Berlin;
    const filter = yield* Inbound;
    const rule = yield* PermitAll;
    return {
      url: worker.url.as<string>(),
      projectId: gateway.projectId,
      region: gateway.region,
      gatewayId: gateway.gatewayId,
      connectionId: connection.connectionId,
      connectionName: connection.displayName,
      filterId: filter.filterId,
      filterName: filter.displayName,
      ruleId: rule.ruleId,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// One gateway on the smallest plan, about EUR 0.09 per run, and provisioning takes minutes:
// gated behind STACKIT_TEST_SLOW, like the resources' own suites. See `vpn.ts`.
describe.sequential.skipIf(slow)(
  "STACKIT VPN bindings on a Cloudflare Worker",
  { tags: [...stackitTags("vpn", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: SUITE_TIMEOUT });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_500_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real
    // failure shows its STACKIT error.
    const call = (route: string) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        return yield* HttpClient.get(`${url}${route}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    describe("GetGateway", () => {
      test.provider(
        "reads the bound gateway",
        (_stack) =>
          Effect.gen(function* () {
            const { gatewayId } = yield* stack;
            const body = yield* call("/get-gateway");
            expectOk(body);
            expect(body.result.id).toEqual(gatewayId);
            expect(body.result.state).toEqual("READY");
            expect(body.result.planId).toEqual(PLAN);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetGatewayStatus", () => {
      test.provider(
        "reads the bound gateway's health and tunnels",
        (_stack) =>
          Effect.gen(function* () {
            const { gatewayId } = yield* stack;
            const body = yield* call("/get-gateway-status");
            expectOk(body);
            expect(body.result.id).toEqual(gatewayId);
            expect(body.result.gatewayStatus).toEqual("READY");
            const names = (body.result.tunnels as { name: string }[]).map((item) => item.name);
            expect(names.sort()).toEqual(["tunnel1", "tunnel2"]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListGateways", () => {
      test.provider(
        "lists the project's gateways, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { gatewayId } = yield* stack;
            const body = yield* call("/list-gateways");
            expectOk(body);
            const ids = (body.result.gateways as { id: string }[]).map((item) => item.id);
            expect(ids).toContain(gatewayId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetConnection", () => {
      test.provider(
        "reads the bound connection, without its key",
        (_stack) =>
          Effect.gen(function* () {
            const { connectionName } = yield* stack;
            const body = yield* call("/get-connection");
            expectOk(body);
            expect(body.result.displayName).toEqual(connectionName);
            expect(body.result.tunnel1.remoteAddress).toEqual("203.0.113.50");
            expect(JSON.stringify(body.result)).not.toContain(PRE_SHARED_KEY);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetConnectionStatus", () => {
      test.provider(
        "reads both tunnels of the bound connection",
        (_stack) =>
          Effect.gen(function* () {
            const { connectionId } = yield* stack;
            const body = yield* call("/get-connection-status");
            expectOk(body);
            expect(body.result.id).toEqual(connectionId);
            const names = (body.result.tunnels as { name: string }[]).map((item) => item.name);
            expect(names.sort()).toEqual(["tunnel1", "tunnel2"]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListConnections", () => {
      test.provider(
        "lists the bound gateway's connections",
        (_stack) =>
          Effect.gen(function* () {
            const { connectionId } = yield* stack;
            const body = yield* call("/list-connections");
            expectOk(body);
            const ids = (body.result.connections as { id: string }[]).map((item) => item.id);
            expect(ids).toEqual([connectionId]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateConnection", () => {
      test.provider(
        "switches the connection off and on, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, gatewayId, connectionId } = yield* stack;
            const scope = {
              projectId: projectId!,
              region: region!,
              gatewayId: gatewayId!,
              connectionId: connectionId!,
            };
            const off = yield* call("/update-connection?enabled=false");
            expectOk(off);
            expect(off.result.enabled).toEqual(false);
            const disabled = yield* vpn.getGatewayConnection(scope);
            expect(disabled.enabled).toEqual(false);

            const on = yield* call("/update-connection?enabled=true");
            expectOk(on);
            const enabled = yield* vpn.getGatewayConnection(scope);
            expect(enabled.enabled).toEqual(true);
          }),
        { timeout: 600_000 },
      );
    });

    describe("GetBGPFilter", () => {
      test.provider(
        "reads the bound filter",
        (_stack) =>
          Effect.gen(function* () {
            const { filterId, filterName } = yield* stack;
            const body = yield* call("/get-filter");
            expectOk(body);
            expect(body.result.id).toEqual(filterId);
            expect(body.result.displayName).toEqual(filterName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListBGPFilters", () => {
      test.provider(
        "lists the bound gateway's filters",
        (_stack) =>
          Effect.gen(function* () {
            const { filterId } = yield* stack;
            const body = yield* call("/list-filters");
            expectOk(body);
            const ids = (body.result.bgpFilters as { id: string }[]).map((item) => item.id);
            expect(ids).toEqual([filterId]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetBGPFilterRule", () => {
      test.provider(
        "reads the bound rule",
        (_stack) =>
          Effect.gen(function* () {
            const { ruleId } = yield* stack;
            const body = yield* call("/get-rule");
            expectOk(body);
            expect(body.result.id).toEqual(ruleId);
            expect(body.result.action).toEqual("PERMIT");
            expect(body.result.sequence).toEqual(10);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListBGPFilterRules", () => {
      test.provider(
        "lists the bound filter's rules",
        (_stack) =>
          Effect.gen(function* () {
            const { ruleId } = yield* stack;
            const body = yield* call("/list-rules");
            expectOk(body);
            const ids = (body.result.rules as { id: string }[]).map((item) => item.id);
            expect(ids).toEqual([ruleId]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListPlans", () => {
      test.provider(
        "lists the region's plans, including the one the fixture uses",
        (_stack) =>
          Effect.gen(function* () {
            const { region } = yield* stack;
            const body = yield* call(`/list-plans?region=${region}`);
            expectOk(body);
            const plans = (body.result.plans as { planId: string }[]).map((plan) => plan.planId);
            expect(plans).toContain(PLAN);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListQuotas", () => {
      test.provider(
        "reads the project's quota, which counts the bound gateway",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-quotas");
            expectOk(body);
            expect(body.result.quotas.gateways.usage).toBeGreaterThanOrEqual(1);
            expect(body.result.quotas.gateways.limit).toBeGreaterThanOrEqual(
              body.result.quotas.gateways.usage,
            );
          }),
        { timeout: 240_000 },
      );
    });
  },
);
