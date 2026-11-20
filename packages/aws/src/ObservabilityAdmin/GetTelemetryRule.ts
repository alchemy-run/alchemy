import * as obs from "@distilled.cloud/aws/observabilityadmin";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { TelemetryRule } from "./TelemetryRule.ts";

/**
 * Runtime binding for `observabilityadmin:GetTelemetryRule` — reads the full
 * configuration and per-region status of the bound
 * {@link TelemetryRule}. The rule's name is injected automatically and the
 * IAM grant is scoped to the rule's ARN.
 *
 * Provide `AWS.ObservabilityAdmin.GetTelemetryRuleHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * ### Reading a Telemetry Rule
 * **Example:** Read the bound rule's configuration
 * ```typescript
 * // init — grants observabilityadmin:GetTelemetryRule on the rule
 * const getTelemetryRule = yield* AWS.ObservabilityAdmin.GetTelemetryRule(rule);
 *
 * // runtime
 * const { TelemetryRule: config, RegionStatuses } = yield* getTelemetryRule();
 * ```
 *
 * @binding
 */
export interface GetTelemetryRule extends Binding.Service<
  GetTelemetryRule,
  "AWS.ObservabilityAdmin.GetTelemetryRule",
  (
    rule: TelemetryRule,
  ) => Effect.Effect<() => Effect.Effect<obs.GetTelemetryRuleOutput, obs.GetTelemetryRuleError>>
> {}

export const GetTelemetryRule = Binding.Service<GetTelemetryRule>(
  "AWS.ObservabilityAdmin.GetTelemetryRule",
);

/**
 * HTTP implementation of {@link GetTelemetryRule}: grants
 * `observabilityadmin:GetTelemetryRule` on the bound rule's ARN and calls
 * the Observability Admin HTTP API with the function's IAM credentials,
 * injecting the rule's name as the `RuleIdentifier`.
 */
export const GetTelemetryRuleHttp = Layer.effect(
  GetTelemetryRule,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getTelemetryRule = yield* AWSBindings.withCredentials(obs.getTelemetryRule);

    return Effect.fn(function* (rule: TelemetryRule) {
      const RuleIdentifier = yield* rule.ruleName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.ObservabilityAdmin.GetTelemetryRule(${rule})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["observabilityadmin:GetTelemetryRule"],
              Resource: [rule.ruleArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.ObservabilityAdmin.GetTelemetryRule(${rule.LogicalId})`)(function* () {
        return yield* getTelemetryRule({
          RuleIdentifier: yield* RuleIdentifier,
        });
      });
    });
  }),
);
