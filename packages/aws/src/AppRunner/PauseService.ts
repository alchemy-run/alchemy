import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

/**
 * Pause an App Runner {@link Service} from a Lambda (or other AWS runtime).
 * App Runner releases the service's compute capacity (the endpoint stops
 * serving) while keeping its configuration — e.g. a nightly scheduler that
 * pauses non-production services to stop compute billing. The call is
 * asynchronous; pair with {@link ListOperations} or {@link ResumeService}.
 *
 * Provide `AppRunner.PauseServiceHttp` on the hosting function's Effect to
 * implement the binding.
 *
 * ### Pausing and Resuming
 * **Example:** Pause a service overnight
 * ```typescript
 * const pauseService = yield* AppRunner.PauseService(service);
 * const { Service: paused } = yield* pauseService();
 * // paused.Status -> "OPERATION_IN_PROGRESS" (settles to "PAUSED")
 * ```
 *
 * @binding
 */
export interface PauseService extends Binding.Service<
  PauseService,
  "AWS.AppRunner.PauseService",
  (
    service: Service,
  ) => Effect.Effect<
    () => Effect.Effect<apprunner.PauseServiceResponse, apprunner.PauseServiceError>
  >
> {}
export const PauseService = Binding.Service<PauseService>("AWS.AppRunner.PauseService");

/**
 * HTTP implementation of the {@link PauseService} binding. Calls
 * `apprunner:PauseService` with the Lambda's IAM role, scoped to the bound
 * service.
 */
export const PauseServiceHttp = makeAppRunnerHttpBinding(PauseService, {
  operation: apprunner.pauseService,
  spec: (service: Service) => ({
    identifiers: { ServiceArn: service.serviceArn },
    iam: () => ({
      actions: ["apprunner:PauseService"],
      resources: [service.serviceArn],
    }),
  }),
});
