import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import WafBindingsWorker, { Firewall, Group, RuleSet } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitWafBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* WafBindingsWorker;
    const firewall = yield* Firewall;
    const group = yield* Group;
    const ruleSet = yield* RuleSet;
    return {
      url: worker.url.as<string>(),
      projectId: firewall.projectId,
      region: firewall.region,
      configurationName: firewall.configurationName,
      ruleGroupName: group.ruleGroupName,
      ruleSetName: ruleSet.ruleSetName,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// The firewall objects are free, and no load balancer is deployed: ungated.
describe.sequential(
  "STACKIT WAF bindings on a Cloudflare Worker",
  { tags: [...stackitTags("waf", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

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

    describe("GetConfiguration", () => {
      test.provider(
        "reads the bound configuration",
        (_stack) =>
          Effect.gen(function* () {
            const { configurationName, ruleSetName } = yield* stack;
            const body = yield* call("/get-configuration");
            expectOk(body);
            expect(body.result.name).toEqual(configurationName);
            expect(body.result.managedRuleSetName).toEqual(ruleSetName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListConfigurations", () => {
      test.provider(
        "lists the project's configurations, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { configurationName } = yield* stack;
            const body = yield* call("/list-configurations");
            expectOk(body);
            const names = (body.result.items as { name: string }[]).map((item) => item.name);
            expect(names).toContain(configurationName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateConfiguration", () => {
      test.provider(
        "changes the references and keeps the labels, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, configurationName, ruleGroupName, ruleSetName } =
              yield* stack;
            const body = yield* call(
              `/update-configuration?group=${ruleGroupName}&ruleSet=${ruleSetName}`,
            );
            expectOk(body);
            expect(body.result.customRuleGroupName).toEqual(ruleGroupName);

            const live = yield* waf.getWAF({
              projectId: projectId!,
              region: region!,
              name: configurationName!,
            });
            expect(live.customRuleGroupName).toEqual(ruleGroupName);
            expect(Stackit.labelRecord(live.labels)).toMatchObject({
              fixture: "waf-bindings",
              "alchemy.id": "WafBindingsFirewall",
            });
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetCustomRuleGroup", () => {
      test.provider(
        "reads the bound rule group, with allocated ids",
        (_stack) =>
          Effect.gen(function* () {
            const { ruleGroupName } = yield* stack;
            const body = yield* call("/get-custom-rule-group");
            expectOk(body);
            expect(body.result.name).toEqual(ruleGroupName);
            expect(body.result.rules[0].id).toBeGreaterThanOrEqual(1);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListCustomRuleGroups", () => {
      test.provider(
        "lists the project's rule groups, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { ruleGroupName } = yield* stack;
            const body = yield* call("/list-custom-rule-groups");
            expectOk(body);
            const names = (body.result.items as { name: string }[]).map((item) => item.name);
            expect(names).toContain(ruleGroupName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateCustomRuleGroup", () => {
      test.provider(
        "replaces the rules, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, ruleGroupName } = yield* stack;
            const body = yield* call("/update-custom-rule-group?path=/debug");
            expectOk(body);

            const live = yield* waf.getCustomRuleGroup({
              projectId: projectId!,
              region: region!,
              name: ruleGroupName!,
            });
            expect(live.rules.map((rule) => rule.conditions[0]?.operator.value)).toEqual([
              "/debug",
            ]);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetManagedRuleSet", () => {
      test.provider(
        "reads the bound rule set and its inventory",
        (_stack) =>
          Effect.gen(function* () {
            const { ruleSetName } = yield* stack;
            const body = yield* call("/get-managed-rule-set");
            expectOk(body);
            expect(body.result.name).toEqual(ruleSetName);
            expect(Object.keys(body.result.groups).length).toBeGreaterThan(0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListManagedRuleSets", () => {
      test.provider(
        "lists the project's rule sets, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { ruleSetName } = yield* stack;
            const body = yield* call("/list-managed-rule-sets");
            expectOk(body);
            const names = (body.result.items as { name: string }[]).map((item) => item.name);
            expect(names).toContain(ruleSetName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("PatchManagedRuleSet", () => {
      test.provider(
        "sets one rule's mode, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, ruleSetName } = yield* stack;
            const before = yield* waf.getManagedRuleSet({
              projectId: projectId!,
              region: region!,
              name: ruleSetName!,
            });
            const [groupId, group] = Object.entries(before.groups ?? {})[0]!;
            const ruleId = Object.keys(group!.rules ?? {})[0]!;

            const body = yield* call(`/patch-managed-rule-set?group=${groupId}&rule=${ruleId}`);
            expectOk(body);

            const after = yield* waf.getManagedRuleSet({
              projectId: projectId!,
              region: region!,
              name: ruleSetName!,
            });
            expect(after.groups?.[groupId]?.rules?.[ruleId]?.mode).toEqual("MODE_LOG_ONLY");
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetQuota", () => {
      test.provider(
        "reads the project's quota, which counts the bound configuration",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const body = yield* call("/get-quota");
            expectOk(body);
            expect(body.result.projectId).toEqual(projectId);
            expect(body.result.quotas.webApplicationFirewall.usage).toBeGreaterThanOrEqual(1);
            expect(body.result.quotas.customRuleGroup.usage).toBeGreaterThanOrEqual(1);
            expect(body.result.quotas.managedRuleSet.usage).toBeGreaterThanOrEqual(1);
          }),
        { timeout: 240_000 },
      );
    });

    describe("grants", () => {
      test.provider(
        "the Worker's account holds only one custom role per permission set",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const scope = { resourceType: "project", resourceId: projectId! };
            const { roles } = yield* authorization.listRoles(scope);
            const permissionsOf = (role: authorization.Role) =>
              role.permissions
                .map((permission) => permission.name)
                .sort()
                .join();
            const get = roles.find(
              (role) => role.id !== undefined && permissionsOf(role) === "alb.waf.mrs.get",
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
              "alb.waf.crg.get",
              "alb.waf.crg.list",
              "alb.waf.crg.update",
              "alb.waf.get",
              "alb.waf.get,alb.waf.update",
              "alb.waf.list",
              "alb.waf.mrs.get",
              "alb.waf.mrs.list",
              "alb.waf.mrs.update",
              "alb.waf.quota.get",
            ]);
          }),
        { timeout: 120_000 },
      );
    });
  },
);
