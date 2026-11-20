import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import type { Ruleset } from "./Ruleset.ts";

export interface TestRulesetRequest extends Omit<firebaserules.TestProjectsRequest, "name"> {}

/**
 * Runtime binding for Firebase Rules `projects.test` against a
 * {@link Ruleset}.
 *
 * Bind this operation to a ruleset in a Function/Action init phase.
 * Provide {@link TestRulesetHttp}. `source` must be omitted when the
 * name refers to an existing ruleset.
 *
 * ### Testing a Ruleset
 * **Example:** Run a test suite
 * ```typescript
 * const testRuleset = yield* GCP.FirebaseRules.TestRuleset(ruleset);
 * const result = yield* testRuleset({
 *   body: {
 *     testSuite: {
 *       testCases: [{ expectation: "DENY" }],
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category FirebaseRules
 */
export interface TestRuleset extends Binding.Service<
  TestRuleset,
  "GCP.FirebaseRules.TestRuleset",
  (
    ruleset: Ruleset,
  ) => Effect.Effect<
    (
      request?: TestRulesetRequest,
    ) => Effect.Effect<
      firebaserules.TestRulesetResponse,
      firebaserules.TestProjectsError,
      RuntimeContext
    >
  >
> {}

export const TestRuleset = Binding.Service<TestRuleset>("GCP.FirebaseRules.TestRuleset");

/**
 * HTTP implementation of {@link TestRuleset}.
 *
 * Grants `roles/firebaserules.admin` on the project because it is the
 * narrowest predefined role containing `firebaserules.rulesets.test`, and Firebase
 * Rules has no resource-level IAM.
 *
 * @layer
 * @provides GCP.FirebaseRules.TestRuleset
 */
export const TestRulesetHttp = Layer.effect(
  TestRuleset,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const testProjects = yield* GCPBindings.withCredentials(firebaserules.testProjects);
    return Effect.fn(function* (ruleset: Ruleset) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.FirebaseRules.TestRuleset(${ruleset})`({
          iam: [{ role: "roles/firebaserules.admin" }],
        });
      }
      const name = yield* ruleset.name;
      return Effect.fn(`GCP.FirebaseRules.TestRuleset(${ruleset.LogicalId})`)(function* (
        request: TestRulesetRequest = {},
      ) {
        return yield* testProjects({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
