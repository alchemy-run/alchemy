import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import UfwBindingsWorker, { Group, Team } from "./fixtures/worker.ts";
import { deleteOutOfBand, expectRuleGone, securityRuleProduct, waitForActive } from "./rules.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitUfwBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* UfwBindingsWorker;
    const group = yield* Group;
    const team = yield* Team;
    const child = yield* Stackit.ResourceManager.Folder("UfwBindingsChildFolder", {
      parentId: team.containerId,
    });
    return {
      url: worker.url.as<string>(),
      groupId: group.securityGroupId,
      projectId: group.projectId,
      region: group.region,
      teamName: team.name,
      childName: child.name,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// A security group and two folders are free, and a rule has no SKU: EUR 0 per run. Every case that
// makes a rule deletes it. Writes on one group go one after another.
describe.sequential(
  "STACKIT Unified Firewall bindings on a Cloudflare Worker",
  { tags: [...stackitTags("unifiedfirewall", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a while to
    // propagate: retry until the route answers `ok`, then report the last answer so a real failure
    // shows its STACKIT error.
    const call = (route: string, params: Record<string, string> = {}) =>
      Effect.gen(function* () {
        const { url } = yield* stack;
        const query = new URLSearchParams(params).toString();
        return yield* HttpClient.get(`${url}${route}?${query}`).pipe(
          Effect.timeout("20 seconds"),
          Effect.flatMap((response) => response.json),
          Effect.map((body) => body as Body),
          Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
          Effect.catch((body) => Effect.succeed(body as Body)),
        );
      });

    const scope = Effect.gen(function* () {
      const { projectId, region } = yield* stack;
      return { projectId: projectId!, region: region! };
    });

    /** The query a route that makes a rule takes. */
    const newRuleParams = (source: string) =>
      Effect.gen(function* () {
        const { groupId, region } = yield* stack;
        const product = yield* securityRuleProduct(region!);
        return { product, instance: groupId!, source };
      });

    /** Run a test on a rule made out of band, deleting it whatever happens. */
    const withRule = <A, E, R>(source: string, use: (ruleId: string) => Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const { projectId, region } = yield* scope;
        const params = yield* newRuleParams(source);
        const { refId } = yield* ufw.createRule({
          projectId,
          regionId: region,
          product: params.product,
          instanceId: params.instance,
          securityGroupId: params.instance,
          type: "SecurityRule",
          sourceIP: source,
          direction: "ingress",
          etherType: "IPv4",
          protocol: "TCP",
          portRange: "8080-8090",
        });
        const ruleId = refId!;
        return yield* Effect.gen(function* () {
          yield* waitForActive({ projectId, region }, ruleId);
          return yield* use(ruleId);
        }).pipe(Effect.ensuring(deleteOutOfBand({ projectId, region }, ruleId)));
      });

    describe("GetRule", () => {
      test.provider(
        "reads a rule by id",
        (_stack) =>
          withRule("192.0.2.1/32", (ruleId) =>
            Effect.gen(function* () {
              const body = yield* call("/get-rule", { id: ruleId });
              expectOk(body);
              expect(body.result.refId).toBe(ruleId);
              expect(body.result.sourceIP).toBe("192.0.2.1/32");
            }),
          ),
        { timeout: 300_000 },
      );
    });

    describe("ListRules", () => {
      test.provider(
        "lists the rules of an instance",
        (_stack) =>
          withRule("192.0.2.2/32", (ruleId) =>
            Effect.gen(function* () {
              const { groupId } = yield* stack;
              const body = yield* call("/list-rules", { instance: groupId! });
              expectOk(body);
              const ids = body.result.rules.map((rule: { refId: string }) => rule.refId);
              expect(ids).toContain(ruleId);
            }),
          ),
        { timeout: 300_000 },
      );
    });

    describe("CreateRule", () => {
      test.provider(
        "adds a rule that goes active",
        (_stack) =>
          Effect.gen(function* () {
            const target = yield* scope;
            const params = yield* newRuleParams("192.0.2.3/32");
            const body = yield* call("/create-rule", params);
            expectOk(body);
            const ruleId: string = body.result.refId;
            yield* Effect.gen(function* () {
              const rule = yield* waitForActive(target, ruleId);
              expect(rule.status).toBe("Active");
              expect(rule.sourceIP).toBe("192.0.2.3/32");
            }).pipe(Effect.ensuring(deleteOutOfBand(target, ruleId)));
            yield* expectRuleGone(target, ruleId);
          }),
        { timeout: 300_000 },
      );
    });

    describe("UpdateRule", () => {
      test.provider(
        "changes a rule's range and keeps its neighbours",
        (_stack) =>
          withRule("192.0.2.4/32", (ruleId) =>
            Effect.gen(function* () {
              const target = yield* scope;
              const body = yield* call("/update-rule", { id: ruleId, source: "192.0.2.5/32" });
              expectOk(body);
              const rule = yield* ufw
                .getRule({ projectId: target.projectId, regionId: target.region, ruleId })
                .pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("3 seconds"),
                    until: (observed) =>
                      observed.status === "Active" && observed.sourceIP === "192.0.2.5/32",
                    times: 30,
                  }),
                );
              expect(rule.sourceIP).toBe("192.0.2.5/32");
              expect(rule.portRange).toBe("8080-8090");
            }),
          ),
        { timeout: 300_000 },
      );
    });

    describe("DeleteRule", () => {
      test.provider(
        "deletes a rule by id",
        (_stack) =>
          withRule("192.0.2.6/32", (ruleId) =>
            Effect.gen(function* () {
              const target = yield* scope;
              const body = yield* call("/delete-rule", { id: ruleId });
              expectOk(body);
              yield* expectRuleGone(target, ruleId);
            }),
          ),
        { timeout: 300_000 },
      );
    });

    describe("ListProviderOptions", () => {
      test.provider(
        "lists the products of the region, signed with no role granted",
        (_stack) =>
          Effect.gen(function* () {
            const { region } = yield* stack;
            const product = yield* securityRuleProduct(region!);
            const body = yield* call("/list-provider-options");
            expectOk(body);
            expect(body.result.products).toContain(product);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListFolderContainers", () => {
      test.provider(
        "lists what's inside the bound folder",
        (_stack) =>
          Effect.gen(function* () {
            const { childName } = yield* stack;
            const body = yield* call("/list-folder-containers");
            expectOk(body);
            const names = body.result.items.map((item: { name: string }) => item.name);
            expect(names).toContain(childName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListOrganizationContainers", () => {
      test.provider(
        "lists what's inside the bound organization",
        (_stack) =>
          Effect.gen(function* () {
            const { teamName } = yield* stack;
            const body = yield* call("/list-organization-containers");
            expectOk(body);
            const names = body.result.items.map((item: { name: string }) => item.name);
            expect(names).toContain(teamName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ReadRules", () => {
      test.provider(
        "reads a rule and lists the instance's",
        (_stack) =>
          withRule("192.0.2.7/32", (ruleId) =>
            Effect.gen(function* () {
              const { groupId } = yield* stack;
              const body = yield* call("/read-rules", { id: ruleId, instance: groupId! });
              expectOk(body);
              expect(body.result.rule.refId).toBe(ruleId);
              const ids = body.result.listed.rules.map((rule: { refId: string }) => rule.refId);
              expect(ids).toContain(ruleId);
            }),
          ),
        { timeout: 300_000 },
      );
    });

    describe("WriteRules", () => {
      test.provider(
        "adds a rule",
        (_stack) =>
          Effect.gen(function* () {
            const target = yield* scope;
            const params = yield* newRuleParams("192.0.2.8/32");
            const body = yield* call("/write-rules", params);
            expectOk(body);
            const ruleId: string = body.result.refId;
            yield* Effect.gen(function* () {
              const rule = yield* waitForActive(target, ruleId);
              expect(rule.sourceIP).toBe("192.0.2.8/32");
            }).pipe(Effect.ensuring(deleteOutOfBand(target, ruleId)));
            yield* expectRuleGone(target, ruleId);
          }),
        { timeout: 300_000 },
      );
    });

    describe("ReadWriteRules", () => {
      test.provider(
        "changes a rule and reads it back",
        (_stack) =>
          withRule("192.0.2.9/32", (ruleId) =>
            Effect.gen(function* () {
              const target = yield* scope;
              const body = yield* call("/read-write-rules", {
                id: ruleId,
                source: "192.0.2.10/32",
              });
              expectOk(body);
              expect(body.result.refId).toBe(ruleId);
              const rule = yield* ufw
                .getRule({ projectId: target.projectId, regionId: target.region, ruleId })
                .pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("3 seconds"),
                    until: (observed) => observed.sourceIP === "192.0.2.10/32",
                    times: 30,
                  }),
                );
              expect(rule.sourceIP).toBe("192.0.2.10/32");
            }),
          ),
        { timeout: 300_000 },
      );
    });
  },
);
