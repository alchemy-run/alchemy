import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as lb from "@distilled.cloud/stackit/load_balancer";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import LoadBalancerBindingsWorker, { Balancer, Credential, Nic, POOL } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitLoadBalancerBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* LoadBalancerBindingsWorker;
    const balancer = yield* Balancer;
    const credential = yield* Credential;
    const nic = yield* Nic;
    return {
      url: worker.url.as<string>(),
      projectId: balancer.projectId,
      region: balancer.region,
      name: balancer.loadBalancerName,
      credentialsRef: credential.credentialsRef,
      targetIp: nic.ipv4,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// The fixture deploys one p10 load balancer with an ephemeral IP, billed for a
// started hour (about EUR 0.02 per run), and provisioning takes minutes: gated
// behind STACKIT_TEST_SLOW, like the resource's own suite.
const slow = !process.env.STACKIT_TEST_SLOW;

describe.sequential.skipIf(slow)(
  "STACKIT Load Balancer bindings on a Cloudflare Worker",
  { tags: [...stackitTags("loadbalancer", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 3_000_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_200_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take
    // a while to propagate: retry until the route answers `ok`, then report the
    // last answer so a real failure shows its STACKIT error.
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

    describe("GetLoadBalancer", () => {
      test.provider(
        "reads the bound load balancer",
        (_stack) =>
          Effect.gen(function* () {
            const { name } = yield* stack;
            const body = yield* call("/get-load-balancer");
            expectOk(body);
            expect(body.result.name).toEqual(name);
            expect(body.result.status).toEqual("STATUS_READY");
            expect(body.result.planId).toEqual("p10");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListLoadBalancers", () => {
      test.provider(
        "lists the project's load balancers, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { name } = yield* stack;
            const body = yield* call("/list-load-balancers");
            expectOk(body);
            const names = (body.result.loadBalancers as { name: string }[]).map(
              (item) => item.name,
            );
            expect(names).toContain(name);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateTargetPool", () => {
      test.provider(
        "replaces the pool's targets, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, name, targetIp } = yield* stack;
            const added = "10.231.65.250";
            const body = yield* call(`/update-target-pool?ips=${targetIp},${added}`);
            expectOk(body);
            expect(body.result.name).toEqual(POOL);

            const live = yield* lb
              .getLoadBalancer({ projectId: projectId!, region: region!, name: name! })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("10 seconds"),
                  until: (loadBalancer) =>
                    loadBalancer.status === "STATUS_READY" &&
                    loadBalancer.targetPools?.[0]?.targets?.length === 2,
                  times: 30,
                }),
              );
            const ips = live.targetPools?.[0]?.targets?.map((target) => target.ip);
            expect([...(ips ?? [])].sort()).toEqual([targetIp, added].sort());
          }),
        { timeout: 600_000 },
      );
    });

    describe("GetCredentials", () => {
      test.provider(
        "reads the bound credential, without its password",
        (_stack) =>
          Effect.gen(function* () {
            const { credentialsRef } = yield* stack;
            const body = yield* call("/get-credentials");
            expectOk(body);
            expect(body.result.credential.credentialsRef).toEqual(credentialsRef);
            expect(body.result.credential.username).toEqual("metrics-writer");
            expect(JSON.stringify(body.result)).not.toContain("alchemy-test-password");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListCredentials", () => {
      test.provider(
        "lists the project's credentials, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { credentialsRef } = yield* stack;
            const body = yield* call("/list-credentials");
            expectOk(body);
            const refs = (body.result.credentials as { credentialsRef: string }[]).map(
              (credential) => credential.credentialsRef,
            );
            expect(refs).toContain(credentialsRef);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetQuota", () => {
      test.provider(
        "reads the project's quota, which counts the bound load balancer",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const body = yield* call("/get-quota");
            expectOk(body);
            expect(body.result.projectId).toEqual(projectId);
            expect(body.result.usedLoadBalancers).toBeGreaterThanOrEqual(1);
            expect(body.result.maxLoadBalancers).toBeGreaterThanOrEqual(1);
            expect(body.result.usedCredentials).toBeGreaterThanOrEqual(1);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListPlans", () => {
      test.provider(
        "lists the region's plans, including the one deployed",
        (_stack) =>
          Effect.gen(function* () {
            const { region } = yield* stack;
            const body = yield* call(`/list-plans?region=${region}`);
            expectOk(body);
            const plans = (body.result.validPlans as { planId: string }[]).map(
              (plan) => plan.planId,
            );
            expect(plans).toContain("p10");
          }),
        { timeout: 240_000 },
      );
    });

    describe("grants", () => {
      test.provider(
        "the Worker's account holds only one single-permission role per granted binding",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const scope = { resourceType: "project", resourceId: projectId! };
            const { roles } = yield* authorization.listRoles(scope);
            const permissionsOf = (role: authorization.Role) =>
              role.permissions.map((permission) => permission.name).join();
            const get = roles.find(
              (role) => role.id !== undefined && permissionsOf(role) === "nlb.loadbalancer.get",
            );
            expect(get?.name).toBeTruthy();

            const { members } = yield* authorization.listMembers(scope);
            const self = members.find((member) => member.role === get!.name)?.subject;
            expect(self).toMatch(/@sa\.stackit\.cloud$/);

            const held = members
              .filter((member) => member.subject === self)
              .map((member) => roles.find((role) => role.name === member.role))
              .map((role) => (role === undefined ? "unknown" : permissionsOf(role)))
              .sort();
            expect(held).toEqual([
              "nlb.credentials.get",
              "nlb.credentials.list",
              "nlb.loadbalancer.get",
              "nlb.loadbalancer.list",
              "nlb.quota.get",
              "nlb.targetpool.replace",
            ]);
          }),
        { timeout: 120_000 },
      );
    });
  },
);
