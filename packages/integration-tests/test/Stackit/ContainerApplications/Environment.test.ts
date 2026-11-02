import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as sca from "@distilled.cloud/stackit/sca";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { ensureTestEnvironment } from "./helpers.ts";

const { test } = makeStackitTest();

// An environment runs no compute, so these run ungated. The API can't delete one: this file
// leaves the environment "Lifecycle" names and "alchemy-test-sca-foreign" in the project,
// each reused on the next run, which is the documented residue.
const options = {
  tags: stackitTags("containerapplications", "environment"),
  timeout: 300_000,
} as const;

test.provider(
  "the API types a missing environment as NotFound",
  (_stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      const error = yield* sca
        .getEnvironment({ projectId, region, environmentId: "alchemy-test-missing" })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
    }).pipe(logLevel),
  options,
);

test.provider(
  "create, redeploy as a no-op, and pick the same environment up after a destroy",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const declared = Stackit.ContainerApplications.Environment("Lifecycle", {});

      const created = yield* stack.deploy(declared);
      expect(created.projectId).toEqual(projectId);
      expect(created.region).toEqual(region);
      expect(created.status).toEqual("CURRENT_STATUS_CREATED");
      expect(created.default).toEqual(false);

      // Out of band: the environment is there, under the generated name.
      const fetched = yield* sca.getEnvironment({
        projectId,
        region,
        environmentId: created.environmentId,
      });
      expect(fetched.displayName).toEqual(created.displayName);
      expect(created.displayName).toContain("lifecycle");

      const plan = yield* stack.plan(declared);
      expect(plan.resources.Lifecycle).toMatchObject({ action: "noop" });

      // The API has no delete, so a destroy leaves it, and the next deploy finds it.
      yield* stack.destroy();
      const left = yield* sca.getEnvironment({
        projectId,
        region,
        environmentId: created.environmentId,
      });
      expect(left.id).toEqual(created.environmentId);

      const again = yield* stack.deploy(declared);
      expect(again.environmentId).toEqual(created.environmentId);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "an environment under a chosen name is only used with adoption",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const displayName = "alchemy-test-sca-foreign";
      const foreign = yield* ensureTestEnvironment(displayName);

      const declared = Stackit.ContainerApplications.Environment("Foreign", { displayName });

      const error = yield* stack.deploy(declared).pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const adopted = yield* stack.deploy(declared.pipe(adopt(true)));
      expect(adopted.environmentId).toEqual(foreign.environmentId);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
