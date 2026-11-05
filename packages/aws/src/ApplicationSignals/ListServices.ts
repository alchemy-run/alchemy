import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `application-signals:ListServices`.
 *
 * Lists the services discovered by Application Signals during a time range.
 * Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListServicesHttp)`.
 * ### Discovering Services
 * **Example:** List Discovered Services
 * ```typescript
 * // init — account-level, no resource argument
 * const listServices = yield* AWS.ApplicationSignals.ListServices();
 *
 * // runtime
 * const page = yield* listServices({
 *   StartTime: new Date(Date.now() - 3600_000),
 *   EndTime: new Date(),
 * });
 * for (const service of page.ServiceSummaries) {
 *   yield* Effect.log(service.KeyAttributes?.Name);
 * }
 * ```
 *
 * @binding
 */
export interface ListServices extends Binding.Service<
  ListServices,
  "AWS.ApplicationSignals.ListServices",
  () => Effect.Effect<
    (
      request: appsignals.ListServicesInput,
    ) => Effect.Effect<appsignals.ListServicesOutput, appsignals.ListServicesError>
  >
> {}

export const ListServices = Binding.Service<ListServices>("AWS.ApplicationSignals.ListServices");

export const ListServicesHttp = Layer.effect(
  ListServices,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListServices",
    operation: appsignals.listServices,
    actions: ["application-signals:ListServices"],
  }),
);
