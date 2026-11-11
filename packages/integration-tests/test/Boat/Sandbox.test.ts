import * as Boat from "@alchemy.run/boat";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as boat from "@distilled.cloud/boat-dev/boat";
import * as Alchemy from "alchemy";
import { localState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { TEST_ORG } from "./fixtures/org.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: Boat.providers() });
const team = Test.make({ providers: Boat.providers({ org: TEST_ORG }) });

const tags = ["provider:boat", "provider:boat:sandbox", "live"];

/** A sandbox, or `undefined` once Boat no longer has it. */
const observe = (sandboxId: string) =>
  boat.getSandbox({ sandboxId }).pipe(
    Effect.map((got): boat.Sandbox | undefined => got.sandbox),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const expectGone = (sandboxId: string) =>
  observe(sandboxId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (sandbox) => sandbox === undefined,
      times: 15,
    }),
    Effect.map((sandbox) => expect(sandbox).toBeUndefined()),
  );

test.provider(
  "create, rename and change auto-stop in place, replace on env, and delete a sandbox",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (props: { minutes: number; greeting: string; name?: string }) =>
        Effect.gen(function* () {
          return yield* Boat.Sandbox("Box", {
            type: "small",
            noEnv: true,
            autoStop: `${props.minutes} minutes`,
            env: { GREETING: props.greeting },
            labels: { purpose: "lifecycle" },
            ...(props.name === undefined ? {} : { name: props.name }),
          });
        });

      const box = yield* stack.deploy(program({ minutes: 10, greeting: "hello" }));
      const created = yield* observe(box.sandboxId);
      expect(created?.labels?.["alchemy.id"]).toBe("Box");
      expect(created?.labels?.["alchemy.stage"]).toBe(stack.stage);
      expect(created?.labels?.purpose).toBe("lifecycle");
      expect(created?.name).toBe(box.name);
      expect(created?.ttlSeconds).toBe(600);
      expect(box.labels).toEqual({ purpose: "lifecycle" });
      expect(box.type).toBe("small");

      // Name and auto-stop change in place: same sandbox.
      const renamed = yield* stack.deploy(
        program({ minutes: 15, greeting: "hello", name: `box-${stack.stage}` }),
      );
      expect(renamed.sandboxId).toBe(box.sandboxId);
      const updated = yield* observe(box.sandboxId);
      expect(updated?.name).toBe(`box-${stack.stage}`);
      expect(updated?.ttlSeconds).toBe(900);

      // An unchanged redeploy plans nothing.
      const plan = yield* stack.plan(
        program({ minutes: 15, greeting: "hello", name: `box-${stack.stage}` }),
      );
      expect(plan.resources.Box.action).toBe("noop");

      // Env can't change on a live sandbox: a new one replaces it.
      const replaced = yield* stack.deploy(
        program({ minutes: 15, greeting: "bonjour", name: `box-${stack.stage}` }),
      );
      expect(replaced.sandboxId).not.toBe(box.sandboxId);
      yield* expectGone(box.sandboxId);
      const fresh = yield* boat.executeSandboxCommand({
        sandboxId: replaced.sandboxId,
        command: "echo $GREETING",
      });
      expect("stdout" in fresh ? fresh.stdout.trim() : undefined).toBe("bonjour");

      yield* stack.destroy();
      yield* expectGone(replaced.sandboxId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a sandbox Boat no longer has is recreated on the next update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (minutes: number) =>
        Effect.gen(function* () {
          return yield* Boat.Sandbox("Recreated", {
            type: "small",
            noEnv: true,
            autoStop: `${minutes} minutes`,
          });
        });
      const box = yield* stack.deploy(program(10));

      yield* boat.deleteSandbox({ sandboxId: box.sandboxId, xAsciiConfirmDelete: box.sandboxId });
      yield* expectGone(box.sandboxId);
      const recreated = yield* stack.deploy(program(15));
      expect(recreated.sandboxId).not.toBe(box.sandboxId);
      expect((yield* observe(recreated.sandboxId))?.ttlSeconds).toBe(900);

      yield* stack.destroy();
      yield* expectGone(recreated.sandboxId);
    }),
  { tags, timeout: 180_000 },
);

// The lookup target belongs to another stack, as a lookup's target should.
const TargetStack = Alchemy.Stack(
  "BoatLookupTarget",
  { providers: Boat.providers(), state: localState() },
  Effect.gen(function* () {
    const box = yield* Boat.Sandbox("LookupBox", {
      type: "small",
      noEnv: true,
      autoStop: "10 minutes",
    });
    return { sandboxId: box.sandboxId, name: box.name };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "lookup references a sandbox another stack manages",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { sandboxId, name } = yield* target;

      const found = yield* stack.deploy(
        Effect.gen(function* () {
          const box = Boat.Sandbox.lookup({ sandboxId });
          return { sandboxId: box.sandboxId, name: box.name };
        }),
      );
      expect(found).toEqual({ sandboxId, name });

      // A lookup is never owned: destroying this stack leaves the sandbox in place.
      yield* stack.destroy();
      expect((yield* observe(sandboxId))?.id).toBe(sandboxId);
    }),
  { tags, timeout: 180_000 },
);

team.test.provider(
  "an org's sandbox bills the org, and is shared and made private again in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (visibility: "shared" | "private") =>
        Boat.Sandbox("TeamBox", {
          type: "small",
          noEnv: true,
          autoStop: "10 minutes",
          visibility,
        });

      const shared = yield* stack.deploy(program("shared"));
      expect(shared.org?.name.toLowerCase()).toBe(TEST_ORG.toLowerCase());
      expect(shared.visibility).toBe("shared");
      expect((yield* observe(shared.sandboxId))?.visibility).toBe("shared");

      const plan = yield* stack.plan(program("shared"));
      expect(plan.resources.TeamBox.action).toBe("noop");

      const made = yield* stack.deploy(program("private"));
      expect(made.sandboxId).toBe(shared.sandboxId);
      expect((yield* observe(shared.sandboxId))?.visibility).toBe("private");

      yield* stack.destroy();
      yield* expectGone(shared.sandboxId);
    }),
  { tags, timeout: 180_000 },
);
