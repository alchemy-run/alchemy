import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Binding from "alchemy/Binding";
import { toWireSeconds } from "alchemy/Util/Duration";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { virtualClusterPolicyStatement } from "./BindingHttp.ts";
import type { VirtualCluster } from "./VirtualCluster.ts";

export interface GetManagedEndpointSessionCredentialsRequest extends Omit<
  emrc.GetManagedEndpointSessionCredentialsRequest,
  "virtualClusterIdentifier" | "durationInSeconds"
> {
  /**
   * How long the session token stays valid (wire unit: seconds).
   * @default the endpoint type's default session duration
   */
  duration?: Duration.Input;
}

/**
 * Runtime binding for `emr-containers:GetManagedEndpointSessionCredentials`.
 *
 * Mints a session token for connecting to a managed endpoint (EMR Studio
 * gateway) on the bound {@link VirtualCluster}. The virtual cluster
 * identifier is injected from the binding; pass the `endpointIdentifier`,
 * the `executionRoleArn` to run as, and the `credentialType`
 * (`TOKEN`). The returned `credentials.token` is a
 * `Redacted` value — call `Redacted.value(...)` at the point of use.
 * Provide the implementation with
 * `Effect.provide(AWS.EMRContainers.GetManagedEndpointSessionCredentialsHttp)`.
 * ### Managed Endpoints
 * **Example:** Mint A Session Token
 * ```typescript
 * // init
 * const getSessionCredentials =
 *   yield* AWS.EMRContainers.GetManagedEndpointSessionCredentials(virtualCluster);
 *
 * // runtime
 * const { credentials } = yield* getSessionCredentials({
 *   endpointIdentifier: endpointId,
 *   executionRoleArn: jobRoleArn,
 *   credentialType: "TOKEN",
 *   duration: "15 minutes",
 * });
 * const token = Redacted.value(credentials!.token);
 * ```
 *
 * @binding
 */
export interface GetManagedEndpointSessionCredentials extends Binding.Service<
  GetManagedEndpointSessionCredentials,
  "AWS.EMRContainers.GetManagedEndpointSessionCredentials",
  (
    virtualCluster: VirtualCluster,
  ) => Effect.Effect<
    (
      request: GetManagedEndpointSessionCredentialsRequest,
    ) => Effect.Effect<
      emrc.GetManagedEndpointSessionCredentialsResponse,
      emrc.GetManagedEndpointSessionCredentialsError
    >
  >
> {}
export const GetManagedEndpointSessionCredentials =
  Binding.Service<GetManagedEndpointSessionCredentials>(
    "AWS.EMRContainers.GetManagedEndpointSessionCredentials",
  );

export const GetManagedEndpointSessionCredentialsHttp = Layer.effect(
  GetManagedEndpointSessionCredentials,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(emrc.getManagedEndpointSessionCredentials);

    // Bespoke (not the shared builder): the request addresses the cluster as
    // `virtualClusterIdentifier` (not `virtualClusterId`) and carries a
    // `duration` that converts to the wire's `durationInSeconds`.
    return Effect.fn(function* (virtualCluster: VirtualCluster) {
      const VirtualClusterId = yield* virtualCluster.virtualClusterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.EMRContainers.GetManagedEndpointSessionCredentials(${virtualCluster})`({
          policyStatements: [
            virtualClusterPolicyStatement(virtualCluster, [
              "emr-containers:GetManagedEndpointSessionCredentials",
              "emr-containers:DescribeManagedEndpoint",
            ]),
          ],
        });
      }
      return Effect.fn(
        `AWS.EMRContainers.GetManagedEndpointSessionCredentials(${virtualCluster.LogicalId})`,
      )(function* (request: GetManagedEndpointSessionCredentialsRequest) {
        const { duration, ...rest } = request;
        return yield* op({
          ...rest,
          durationInSeconds: toWireSeconds(duration),
          virtualClusterIdentifier: yield* VirtualClusterId,
        });
      });
    });
  }),
);
