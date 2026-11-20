import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { InstrumentationConfiguration } from "./InstrumentationConfiguration.ts";

/**
 * `GetInstrumentationConfigurationStatus` request with the configuration's
 * identity (`InstrumentationType`/`Service`/`Environment`/`SignalType`/
 * `LocationIdentifier`) injected from the bound
 * {@link InstrumentationConfiguration}.
 */
export interface GetInstrumentationConfigurationStatusRequest extends Omit<
  appsignals.GetInstrumentationConfigurationStatusRequest,
  "InstrumentationType" | "Service" | "Environment" | "SignalType" | "LocationIdentifier"
> {}

/**
 * Runtime binding for
 * `application-signals:GetInstrumentationConfigurationStatus`, scoped to
 * one {@link InstrumentationConfiguration}.
 *
 * Returns the status history (`READY`/`ERROR`/`ACTIVE`/`DISABLED`) that
 * instrumented SDK agents reported for the bound configuration during a
 * time range. Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.GetInstrumentationConfigurationStatusHttp)`.
 * ### Monitoring Instrumentation
 * **Example:** Check Whether the Probe Applied
 * ```typescript
 * // init — bind the operation to the configuration
 * const getStatus =
 *   yield* AWS.ApplicationSignals.GetInstrumentationConfigurationStatus(probe);
 *
 * // runtime — the configuration's identity is injected automatically
 * const result = yield* getStatus({ Status: "ACTIVE" });
 * yield* Effect.log(`${result.Events.length} ACTIVE events`);
 * ```
 *
 * @binding
 */
export interface GetInstrumentationConfigurationStatus extends Binding.Service<
  GetInstrumentationConfigurationStatus,
  "AWS.ApplicationSignals.GetInstrumentationConfigurationStatus",
  (
    configuration: InstrumentationConfiguration,
  ) => Effect.Effect<
    (
      request?: GetInstrumentationConfigurationStatusRequest,
    ) => Effect.Effect<
      appsignals.GetInstrumentationConfigurationStatusResponse,
      appsignals.GetInstrumentationConfigurationStatusError
    >
  >
> {}

export const GetInstrumentationConfigurationStatus =
  Binding.Service<GetInstrumentationConfigurationStatus>(
    "AWS.ApplicationSignals.GetInstrumentationConfigurationStatus",
  );

/**
 * Bespoke implementation (not built on the shared scaffolding): the runtime
 * callable injects the bound configuration's full identity — the
 * type/service/environment/signal quadruple plus the location hash —
 * rather than a single identifier field.
 */
export const GetInstrumentationConfigurationStatusHttp = Layer.effect(
  GetInstrumentationConfigurationStatus,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(appsignals.getInstrumentationConfigurationStatus);
    const tag = "AWS.ApplicationSignals.GetInstrumentationConfigurationStatus";

    return Effect.fn(function* (configuration: InstrumentationConfiguration) {
      const InstrumentationType = yield* configuration.instrumentationType;
      const Service = yield* configuration.service;
      const Environment = yield* configuration.environment;
      const SignalType = yield* configuration.signalType;
      const LocationHash = yield* configuration.locationHash;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${tag}(${configuration})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["application-signals:GetInstrumentationConfigurationStatus"],
              // The dynamic-instrumentation actions do not document
              // resource-level permission support.
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`${tag}(${configuration.LogicalId})`)(function* (
        request?: Omit<
          appsignals.GetInstrumentationConfigurationStatusRequest,
          "InstrumentationType" | "Service" | "Environment" | "SignalType" | "LocationIdentifier"
        >,
      ) {
        return yield* op({
          ...request,
          InstrumentationType: yield* InstrumentationType,
          Service: yield* Service,
          Environment: yield* Environment,
          SignalType: yield* SignalType,
          LocationIdentifier: { LocationHash: yield* LocationHash },
        });
      });
    });
  }),
);
