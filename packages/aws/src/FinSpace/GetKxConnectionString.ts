import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxConnectionString` — retrieves a signed connection string a kdb user can use to connect to a cluster in the bound environment. The returned `signedConnectionString` embeds a SigV4 signature and is surfaced as `Redacted`.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxConnectionStringHttp)`.
 * ### Connecting to Clusters
 * **Example:** Connect a User to a Cluster
 * ```typescript
 * const getConnectionString = yield* AWS.FinSpace.GetKxConnectionString(kdb);
 *
 * const { signedConnectionString } = yield* getConnectionString({
 *   userArn: user.userArn,
 *   clusterName: "hdb",
 * });
 * const value = Redacted.value(signedConnectionString!);
 * ```
 *
 * @binding
 */
export interface GetKxConnectionString extends Binding.Service<
  GetKxConnectionString,
  "AWS.FinSpace.GetKxConnectionString",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxConnectionStringRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxConnectionStringResponse, SVC.GetKxConnectionStringError>
  >
> {}
export const GetKxConnectionString = Binding.Service<GetKxConnectionString>(
  "AWS.FinSpace.GetKxConnectionString",
);

export const GetKxConnectionStringHttp = Layer.effect(
  GetKxConnectionString,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxConnectionString",
    operation: finspace.getKxConnectionString,
    actions: ["finspace:GetKxConnectionString", "finspace:ConnectKxCluster"],
  }),
);
