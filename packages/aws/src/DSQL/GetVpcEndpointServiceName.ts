import * as dsql from "@distilled.cloud/aws/dsql";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Retrieves the VPC endpoint service name of an Aurora DSQL cluster — the
 * `com.amazonaws.{region}.dsql-{suffix}` PrivateLink service name used to
 * create a VPC interface endpoint that reaches the cluster privately.
 *
 * Bind a {@link Cluster} inside a function runtime to look the name up on
 * demand (e.g. from an operations function that provisions VPC endpoints).
 * Provide `DSQL.GetVpcEndpointServiceNameHttp` on the Function effect to
 * implement the binding.
 *
 * ### Resolving the VPC Endpoint Service Name
 * **Example:** Look Up the PrivateLink Service Name
 * ```typescript
 * // init
 * const getVpcEndpointServiceName =
 *   yield* DSQL.GetVpcEndpointServiceName(cluster);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     const { serviceName } = yield* getVpcEndpointServiceName();
 *     return HttpServerResponse.json({ serviceName });
 *   }),
 * };
 * ```
 *
 * @binding
 */
export interface GetVpcEndpointServiceName extends Binding.Service<
  GetVpcEndpointServiceName,
  "AWS.DSQL.GetVpcEndpointServiceName",
  <R extends Cluster>(
    cluster: R,
  ) => Effect.Effect<
    () => Effect.Effect<dsql.GetVpcEndpointServiceNameOutput, dsql.GetVpcEndpointServiceNameError>
  >
> {}
export const GetVpcEndpointServiceName = Binding.Service<GetVpcEndpointServiceName>(
  "AWS.DSQL.GetVpcEndpointServiceName",
);

/**
 * HTTP implementation of {@link GetVpcEndpointServiceName}. At deploy time
 * it grants `dsql:GetVpcEndpointServiceName` on the cluster to the host
 * Function; at runtime it calls the DSQL control plane with the Function's
 * own credentials.
 */
export const GetVpcEndpointServiceNameHttp = Layer.effect(
  GetVpcEndpointServiceName,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(dsql.getVpcEndpointServiceName);

    return Effect.fn(function* <R extends Cluster>(cluster: R) {
      const Identifier = yield* cluster.clusterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.DSQL.GetVpcEndpointServiceName(${cluster})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["dsql:GetVpcEndpointServiceName"],
              Resource: [cluster.clusterArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.DSQL.GetVpcEndpointServiceName(${cluster.LogicalId})`)(function* () {
        return yield* op({ identifier: yield* Identifier });
      });
    });
  }),
);
