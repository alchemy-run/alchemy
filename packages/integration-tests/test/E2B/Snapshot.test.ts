import * as E2B from "@alchemy.run/e2b";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as templates from "@distilled.cloud/e2b/templates";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: E2B.providers() });

const expectTemplateGone = (templateId: string) =>
  templates.getTemplate({ templateID: templateId }).pipe(
    Effect.map(() => true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (exists) => !exists,
      times: 15,
    }),
    Effect.map((exists) => expect(exists).toBe(false)),
  );

const program = (run: string[]) =>
  Effect.gen(function* () {
    const base = yield* E2B.Template("SnapshotBase", { fromTemplate: "base" });
    return yield* E2B.Snapshot("Warm", { template: base, run });
  });

test.provider(
  "snapshot a set-up template, skip an unchanged redeploy, re-snapshot on new setup, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(program(["echo one > /home/user/warm.txt"]));
      const observed = yield* templates.getTemplate({ templateID: first.templateId });
      expect(observed.buildStatus).toBe("ready");
      expect(first.names.length).toBeGreaterThan(0);

      const same = yield* stack.deploy(program(["echo one > /home/user/warm.txt"]));
      expect(same.setupHash).toBe(first.setupHash);
      const unchanged = yield* templates.getTemplate({ templateID: first.templateId });
      expect(unchanged.buildID).toBe(observed.buildID);

      const second = yield* stack.deploy(program(["echo two > /home/user/warm.txt"]));
      expect(second.templateId).toBe(first.templateId);
      expect(second.setupHash).not.toBe(first.setupHash);
      const rebuilt = yield* templates.getTemplate({ templateID: first.templateId });
      expect(rebuilt.buildID).not.toBe(observed.buildID);

      yield* stack.destroy();
      yield* expectTemplateGone(first.templateId);
    }),
  { tags: ["provider:e2b", "provider:e2b:snapshot", "live"], timeout: 900_000 },
);

test.provider(
  "a failing setup command fails the deploy with SnapshotSetupFailed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack.deploy(program(["exit 7"])).pipe(Effect.flip);
      expect(String(error)).toContain("exited with 7");
      yield* stack.destroy();
    }),
  { tags: ["provider:e2b", "provider:e2b:snapshot", "live"], timeout: 600_000 },
);
