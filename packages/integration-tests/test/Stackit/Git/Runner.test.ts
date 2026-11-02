import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as git from "@distilled.cloud/stackit/git";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./git.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("git", "runner"), timeout: 1_800_000 } as const;

const app = (labels: string[]) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Git.Instance("RunnerInstance", {
      featureToggle: { pipelines: { enabled: true } },
      forceDestroy: true,
    });
    const runner = yield* Stackit.Git.Runner("RunnerUnderTest", {
      instanceId: instance.instanceId,
      labels,
    });
    return { instance, runner };
  });

test.provider.skipIf(slow)(
  "create, replace and delete a runner",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { instance, runner: created } = yield* stack.deploy(app(["stackit-docker"]));
      expect(created.instanceId).toEqual(instance.instanceId);
      expect(created.labels).toEqual(["stackit-docker"]);

      // Out of band.
      const scope = { projectId, instanceId: instance.instanceId };
      const fetched = yield* git.getRunner(scope);
      expect(fetched.id).toEqual(created.runnerId);
      expect(fetched.labels).toEqual(["stackit-docker"]);

      // Redeploying unchanged is a no-op, whatever the runner's status did meanwhile.
      const plan = yield* stack.plan(app(["stackit-docker"]));
      expect(plan.resources.RunnerUnderTest).toMatchObject({ action: "noop" });

      // There is no update call, and an instance has one runner: the old one goes first.
      const { runner: replaced } = yield* stack.deploy(app(["stackit-ubuntu-22"]));
      expect(replaced.runnerId).not.toEqual(created.runnerId);
      const changed = yield* git.getRunner(scope);
      expect(changed.id).toEqual(replaced.runnerId);
      expect(changed.labels).toEqual(["stackit-ubuntu-22"]);

      yield* stack.destroy();
      yield* expectGone(observeInstance(projectId, instance.instanceId));
    }).pipe(logLevel),
  options,
);
