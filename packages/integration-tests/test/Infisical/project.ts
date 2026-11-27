import * as infisical from "@distilled.cloud/infisical";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/**
 * The standing test project, found by slug in the testing account, so the
 * suites run without per-machine IDs. Override with
 * `INFISICAL_TEST_PROJECT_SLUG`.
 */
export const testProject = Effect.gen(function* () {
  const slug = yield* Config.String("INFISICAL_TEST_PROJECT_SLUG").pipe(
    Config.withDefault("alchemy-test"),
  );
  const project = yield* infisical.getProjectBySlug({ slug });
  return project.id;
});
