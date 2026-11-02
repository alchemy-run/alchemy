import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as intake from "@distilled.cloud/stackit/intake";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { stackitTags } from "../helpers.ts";
import IntakeBindingsWorker, { Events, Ingest, Producer } from "./fixtures/worker.ts";
import { slow } from "./intake.ts";

const providers = Layer.mergeAll(Stackit.providers(), Cloudflare.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitIntakeBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* IntakeBindingsWorker;
    const runner = yield* Ingest;
    const pipeline = yield* Events;
    const user = yield* Producer;
    return {
      url: worker.url.as<string>(),
      projectId: runner.projectId,
      region: runner.region,
      runnerId: runner.runnerId,
      runnerUri: runner.uri,
      intakeId: pipeline.intakeId,
      topic: pipeline.topic,
      userId: user.userId,
      user: user.user,
    };
  }),
);

type Body = { ok: boolean; result?: any; error?: string };

const options = { timeout: 180_000 } as const;

// A runner is billed per started hour: gated behind STACKIT_TEST_SLOW (see intake.ts).
describe.sequential.skipIf(slow)(
  "STACKIT Intake bindings on a Cloudflare Worker",
  { tags: [...stackitTags("intake", "bindings"), "provider:cloudflare"] },
  () => {
    const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    // A fresh workers.dev URL, the created key and the account's memberships take a while
    // to propagate: retry until the route answers `ok`, then report the last answer so a
    // real failure shows its STACKIT error.
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

    const expectOk = (body: Body) =>
      expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

    describe("GetRunner", () => {
      test(
        "reads the bound runner",
        Effect.gen(function* () {
          const { runnerId, runnerUri } = yield* stack;
          const body = yield* call("/get-runner");
          expectOk(body);
          expect(body.result).toEqual({ id: runnerId, uri: runnerUri });
        }),
        options,
      );
    });

    describe("ListRunners", () => {
      test(
        "lists the runners of the bound project and region",
        Effect.gen(function* () {
          const { runnerId } = yield* stack;
          const body = yield* call("/list-runners");
          expectOk(body);
          expect(body.result).toContain(runnerId);
        }),
        options,
      );
    });

    describe("UpdateRunner", () => {
      test.provider(
        "changes the bound runner",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, runnerId } = yield* stack;
            const body = yield* call("/update-runner?description=set-by-binding");
            expectOk(body);
            expect(body.result).toEqual({ id: runnerId });
            // Out of band.
            const live = yield* intake.getIntakeRunner({
              projectId,
              regionId: region,
              intakeRunnerId: runnerId,
            });
            expect(live.description).toEqual("set-by-binding");
          }),
        options,
      );
    });

    describe("GetIntake", () => {
      test(
        "reads the bound intake",
        Effect.gen(function* () {
          const { intakeId, topic } = yield* stack;
          const body = yield* call("/get-intake");
          expectOk(body);
          expect(body.result).toEqual({ id: intakeId, topic });
        }),
        options,
      );
    });

    describe("ListIntakes", () => {
      test(
        "lists the intakes of the bound project and region",
        Effect.gen(function* () {
          const { intakeId } = yield* stack;
          const body = yield* call("/list-intakes");
          expectOk(body);
          expect(body.result).toContain(intakeId);
        }),
        options,
      );
    });

    describe("GetUser", () => {
      test(
        "reads the bound user",
        Effect.gen(function* () {
          const { userId, user } = yield* stack;
          const body = yield* call("/get-user");
          expectOk(body);
          expect(body.result).toEqual({ id: userId, user });
        }),
        options,
      );
    });

    describe("ListUsers", () => {
      test(
        "lists the users of the bound intake",
        Effect.gen(function* () {
          const { userId } = yield* stack;
          const body = yield* call("/list-users");
          expectOk(body);
          expect(body.result).toEqual([userId]);
        }),
        options,
      );
    });

    describe("UpdateUser", () => {
      test.provider(
        "changes the bound user",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, intakeId, userId } = yield* stack;
            const body = yield* call("/update-user?description=set-by-binding");
            expectOk(body);
            expect(body.result).toEqual({ id: userId });
            // Out of band.
            const live = yield* intake.getIntakeUser({
              projectId,
              regionId: region,
              intakeId,
              intakeUserId: userId,
            });
            expect(live.description).toEqual("set-by-binding");
          }),
        options,
      );
    });
  },
);
