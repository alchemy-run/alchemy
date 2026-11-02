import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as ipLists from "@distilled.cloud/stackit/lb_ip_lists";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import IPListsBindingsWorker, { Blocked } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitIpListsBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* IPListsBindingsWorker;
    const blocked = yield* Blocked;
    return {
      url: worker.url.as<string>(),
      projectId: blocked.projectId,
      region: blocked.region,
      listName: blocked.listName,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// A list is free, so this suite is ungated.
describe.sequential(
  "STACKIT IP list bindings on a Cloudflare Worker",
  { tags: [...stackitTags("iplists", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 600_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take
    // a while to propagate, and an upload waits out the one-a-minute limit: retry
    // until the route answers `ok`, then report the last answer so a real failure
    // shows its STACKIT error.
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

    describe("UploadIPList", () => {
      test.provider(
        "replaces the content and keeps the labels, verified out of band",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, listName } = yield* stack;
            const body = yield* call("/upload-ip-list?cidrs=198.51.100.0/24,203.0.113.0/24");
            expectOk(body);
            expect(body.result.numberOfIps).toEqual(2);

            const live = yield* ipLists.getIPList({
              projectId: projectId!,
              region: region!,
              name: listName!,
            });
            expect(live.numberOfIps).toEqual(2);
            expect(Stackit.labelRecord(live.labels)).toMatchObject({
              fixture: "ip-lists-bindings",
              "alchemy.id": "IpListBindingsBlocked",
            });
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetIPList", () => {
      test.provider(
        "reads the bound list",
        (_stack) =>
          Effect.gen(function* () {
            const { listName } = yield* stack;
            const body = yield* call("/get-ip-list");
            expectOk(body);
            expect(body.result.name).toEqual(listName);
            expect(body.result.contentHash).toMatch(/^[a-f0-9]{64}$/);
            expect(JSON.stringify(body.result)).not.toContain("198.51.100.0");
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListIPLists", () => {
      test.provider(
        "lists the project's lists, including the bound one",
        (_stack) =>
          Effect.gen(function* () {
            const { listName } = yield* stack;
            const body = yield* call("/list-ip-lists");
            expectOk(body);
            const names = (body.result.items as { name: string }[]).map((item) => item.name);
            expect(names).toContain(listName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetQuota", () => {
      test.provider(
        "reads the project's quota, which counts the bound list",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId } = yield* stack;
            const body = yield* call("/get-quota");
            expectOk(body);
            expect(body.result.projectId).toEqual(projectId);
            expect(body.result.quotas.ipLists.usage).toBeGreaterThanOrEqual(1);
            expect(body.result.quotas.ipLists.limit).not.toEqual(0);
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
            const quota = roles.find(
              (role) => role.id !== undefined && permissionsOf(role) === "lb-ip-lists.quota.get",
            );
            expect(quota?.name).toBeTruthy();

            const { members } = yield* authorization.listMembers(scope);
            const self = members.find((member) => member.role === quota!.name)?.subject;
            expect(self).toMatch(/@sa\.stackit\.cloud$/);

            const held = members
              .filter((member) => member.subject === self)
              .map((member) => roles.find((role) => role.name === member.role))
              .map((role) => (role === undefined ? "unknown" : permissionsOf(role)))
              .sort();
            expect(held).toEqual([
              "lb-ip-lists.loadbalancer.get",
              "lb-ip-lists.loadbalancer.get,lb-ip-lists.loadbalancer.upload",
              "lb-ip-lists.loadbalancer.list",
              "lb-ip-lists.quota.get",
            ]);
          }),
        { timeout: 120_000 },
      );
    });
  },
);
