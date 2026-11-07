import * as apprunner from "@distilled.cloud/aws/apprunner";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import { makeAppRunnerHttpBinding } from "./BindingHttp.ts";
import type { Service } from "./Service.ts";

export interface ListOperationsRequest extends Omit<
  apprunner.ListOperationsRequest,
  "ServiceArn"
> {}

/**
 * List the operations that occurred on an App Runner {@link Service} (most
 * recent first) from a Lambda (or other AWS runtime) — the tracking
 * counterpart to the asynchronous {@link StartDeployment},
 * {@link PauseService}, and {@link ResumeService} calls, whose returned
 * `OperationId`s appear here with `Status` transitions
 * (`IN_PROGRESS` -> `SUCCEEDED` / `FAILED` / `ROLLBACK_*`).
 *
 * Provide `AppRunner.ListOperationsHttp` on the hosting function's Effect
 * to implement the binding.
 *
 * ### Tracking Operations
 * **Example:** Track a deployment to completion
 * ```typescript
 * const listOperations = yield* AppRunner.ListOperations(service);
 * const { OperationSummaryList } = yield* listOperations({ MaxResults: 5 });
 * const deployment = OperationSummaryList?.find((op) => op.Id === operationId);
 * // deployment?.Status -> "IN_PROGRESS" | "SUCCEEDED" | ...
 * ```
 *
 * @binding
 */
export interface ListOperations extends Binding.Service<
  ListOperations,
  "AWS.AppRunner.ListOperations",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request?: ListOperationsRequest,
    ) => Effect.Effect<apprunner.ListOperationsResponse, apprunner.ListOperationsError>
  >
> {}
export const ListOperations = Binding.Service<ListOperations>("AWS.AppRunner.ListOperations");

/**
 * HTTP implementation of the {@link ListOperations} binding. Calls
 * `apprunner:ListOperations` with the Lambda's IAM role, scoped to the
 * bound service.
 */
export const ListOperationsHttp = makeAppRunnerHttpBinding(ListOperations, {
  operation: apprunner.listOperations,
  spec: (service: Service) => ({
    identifiers: { ServiceArn: service.serviceArn },
    iam: () => ({
      actions: ["apprunner:ListOperations"],
      resources: [service.serviceArn],
    }),
  }),
});
