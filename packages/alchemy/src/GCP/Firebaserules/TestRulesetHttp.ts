import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Ruleset } from "./Ruleset.ts";
import { TestRuleset, type TestRulesetRequest } from "./TestRuleset.ts";
import { bindGcpHost } from "../Host.ts";

/**
 * HTTP implementation of {@link TestRuleset}.
 *
 * @layer
 * @provides GCP.Firebaserules.TestRuleset
 */
export const TestRulesetHttp = Layer.effect(
  TestRuleset,
  Effect.gen(function* () {
    const testProjects = yield* firebaserules.testProjects;
    return Effect.fn(function* (ruleset: Ruleset) {
      yield* bindGcpHost({
        tag: "GCP.Firebaserules.TestRuleset",
        resource: ruleset,
        // firebaserules.rulesets.test is only in firebaserules.admin; no
        // narrower predefined role exists. No resource-level IAM.
        iam: [{ role: "roles/firebaserules.admin" }],
      });
      const name = yield* ruleset.name;
      return Effect.fn(`GCP.Firebaserules.TestRuleset(${ruleset.LogicalId})`)(
        function* (request: TestRulesetRequest = {}) {
          return yield* testProjects({
            ...request,
            name: yield* name,
          });
        },
      );
    });
  }),
);
