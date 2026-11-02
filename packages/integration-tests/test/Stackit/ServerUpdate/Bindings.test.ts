import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as serverUpdate from "@distilled.cloud/stackit/server_update";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import { slow } from "../IaaS/compute.ts";
import ServerUpdateBindingsWorker, { Host, Weekly } from "./fixtures/worker.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitServerUpdateBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* ServerUpdateBindingsWorker;
    const server = yield* Host;
    const schedule = yield* Weekly;
    return {
      url: worker.url.as<string>(),
      projectId: server.projectId,
      region: server.region,
      serverId: server.serverId,
      scheduleId: schedule.scheduleId,
      scheduleName: schedule.name,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

// One g1.1 server with its boot volume (about EUR 0.05) and the service (EUR 0.005), billed
// per started hour: under EUR 0.06 per run. It patches a throwaway server. Gated with the
// server. The steps act on one server, so they run in order.
describe.sequential.skipIf(slow)(
  "STACKIT Server Update bindings on a Cloudflare Worker",
  { tags: [...stackitTags("serverupdate", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 1_200_000 });

    // A fresh workers.dev URL, the created key and the account's new memberships take a
    // while to propagate: retry until the route answers `ok`, then report the last answer so
    // a real failure shows its STACKIT error.
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

    const target = Effect.gen(function* () {
      const { projectId, region, serverId } = yield* stack;
      return { projectId: projectId!, region: region!, serverId: serverId! };
    });

    describe("GetService", () => {
      test.provider(
        "reports the service on",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/get-service");
            expectOk(body);
            expect(body.result.enabled).toBe(true);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListSchedules", () => {
      test.provider(
        "lists the deployed schedule",
        (_stack) =>
          Effect.gen(function* () {
            const { scheduleId } = yield* stack;
            const body = yield* call("/list-schedules");
            expectOk(body);
            const ids = body.result.items.map((schedule: { id: number }) => String(schedule.id));
            expect(ids).toContain(scheduleId);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetSchedule", () => {
      test.provider(
        "reads the bound schedule",
        (_stack) =>
          Effect.gen(function* () {
            const { scheduleName } = yield* stack;
            const body = yield* call("/get-schedule");
            expectOk(body);
            expect(body.result.name).toEqual(scheduleName);
          }),
        { timeout: 240_000 },
      );
    });

    describe("UpdateSchedule", () => {
      test.provider(
        "replaces the bound schedule's settings",
        (_stack) =>
          Effect.gen(function* () {
            const { scheduleId, scheduleName } = yield* stack;
            const body = yield* call("/update-schedule", { name: scheduleName! });
            expectOk(body);
            const server = yield* target;
            const live = yield* serverUpdate.getUpdateSchedule({
              ...server,
              scheduleId: scheduleId!,
            });
            expect(live.maintenanceWindow).toEqual(2);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListPolicies", () => {
      test.provider(
        "answers with the project's policies",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const body = yield* call("/list-policies");
            expectOk(body);
            const direct = yield* serverUpdate.listUpdatePolicies({
              projectId: server.projectId,
            });
            expect(body.result.items?.length ?? 0).toEqual(direct.items?.length ?? 0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("CreateUpdate", () => {
      test.provider(
        "starts an update run STACKIT then reports",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const body = yield* call("/create-update");
            expectOk(body);
            const live = yield* serverUpdate.getUpdate({
              ...server,
              updateId: String(body.result.id),
            });
            expect(live.id).toEqual(body.result.id);
          }),
        { timeout: 240_000 },
      );
    });

    describe("ListUpdates", () => {
      test.provider(
        "lists the update run",
        (_stack) =>
          Effect.gen(function* () {
            const body = yield* call("/list-updates");
            expectOk(body);
            expect(body.result.items.length).toBeGreaterThan(0);
          }),
        { timeout: 240_000 },
      );
    });

    describe("GetUpdate", () => {
      test.provider(
        "reads an update run by id",
        (_stack) =>
          Effect.gen(function* () {
            const server = yield* target;
            const { items } = yield* serverUpdate.listUpdates(server);
            const first = items?.[0];
            expect(first?.id).toEqual(expect.any(Number));
            const body = yield* call("/get-update", { id: String(first!.id) });
            expectOk(body);
            expect(body.result.id).toEqual(first!.id);
          }),
        { timeout: 240_000 },
      );
    });
  },
);
