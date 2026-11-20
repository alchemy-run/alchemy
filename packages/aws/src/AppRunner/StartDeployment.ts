import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

/**
 * Start a manual deployment of an App Runner {@link Service} from a Lambda
 * (or other AWS runtime) — App Runner re-pulls the latest image (or commit)
 * and rolls a new container fleet. The call is asynchronous; pair with
 * {@link ListOperations} to track the returned `OperationId` to completion.
 *
 * Provide `AppRunner.StartDeploymentHttp` on the hosting function's Effect
 * to implement the binding.
 *
 * ### Deploying at Runtime
 * **Example:** Trigger a deployment and return its operation id
 * ```typescript
 * const startDeployment = yield* AppRunner.StartDeployment(service);
 * const { OperationId } = yield* startDeployment();
 * ```
 *
 * @binding
 */
export interface StartDeployment extends Binding.Service<
  StartDeployment,
  "AWS.AppRunner.StartDeployment",
  (
    service: Service,
  ) => Effect.Effect<
    () => Effect.Effect<apprunner.StartDeploymentResponse, apprunner.StartDeploymentError>
  >
> {}
export const StartDeployment = Binding.Service<StartDeployment>("AWS.AppRunner.StartDeployment");

/**
 * HTTP implementation of the {@link StartDeployment} binding. Calls
 * `apprunner:StartDeployment` with the Lambda's IAM role, scoped to the
 * bound service.
 */
export const StartDeploymentHttp = makeAppRunnerHttpBinding(StartDeployment, {
  operation: apprunner.startDeployment,
  spec: (service: Service) => ({
    identifiers: { ServiceArn: service.serviceArn },
    iam: () => ({
      actions: ["apprunner:StartDeployment"],
      resources: [service.serviceArn],
    }),
  }),
});
