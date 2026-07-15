import type * as obs from "@distilled.cloud/aws/observabilityadmin";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `observabilityadmin:ListResourceTelemetry` — audits
 * which AWS resources (VPCs, Lambda functions, ...) have telemetry such as
 * flow logs configured, and in what state. The account-level telemetry
 * config data plane; requires the account to be onboarded (see
 * `ObservabilityAdmin.TelemetryConfig`).
 *
 * Provide `AWS.ObservabilityAdmin.ListResourceTelemetryHttp` on the hosting
 * Lambda Function to satisfy the requirement.
 * @binding
 * @section Auditing Resource Telemetry
 * @example Find VPCs without flow logs
 * ```typescript
 * // init — grants observabilityadmin:ListResourceTelemetry
 * const listResourceTelemetry = yield* AWS.ObservabilityAdmin.ListResourceTelemetry();
 *
 * // runtime
 * const { TelemetryConfigurations } = yield* listResourceTelemetry({
 *   ResourceTypes: ["AWS::EC2::VPC"],
 *   TelemetryConfigurationState: { Logs: "NotEnabled" },
 * });
 * ```
 */
export interface ListResourceTelemetry extends Binding.Service<
  ListResourceTelemetry,
  "AWS.ObservabilityAdmin.ListResourceTelemetry",
  () => Effect.Effect<
    (
      request?: obs.ListResourceTelemetryInput,
    ) => Effect.Effect<
      obs.ListResourceTelemetryOutput,
      obs.ListResourceTelemetryError
    >
  >
> {}

export const ListResourceTelemetry = Binding.Service<ListResourceTelemetry>(
  "AWS.ObservabilityAdmin.ListResourceTelemetry",
);
