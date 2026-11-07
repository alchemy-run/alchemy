import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as AWSBindings from "../AWSBindings.ts";
import { connectEnvPrefix as makeConnectEnvPrefix } from "../Connection/internal.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Environment variable prefix under which the connect bindings publish the
 * cluster endpoint on the host Function, derived from the cluster's logical
 * ID. A cluster with logical ID `Cache` yields `DAX_CACHE` and the variables
 * `DAX_CACHE_HOST`, `DAX_CACHE_PORT`, `DAX_CACHE_URL`, and `DAX_CACHE_TLS`.
 */
export const connectEnvPrefix = (logicalId: string): string =>
  makeConnectEnvPrefix("DAX", logicalId);

/**
 * Shared scaffolding for the DAX connect bindings.
 *
 * NOT exported from `index.ts` — `ConnectReadHttp.ts` / `ConnectWriteHttp.ts`
 * / `ConnectReadWriteHttp.ts` are thin
 * `Layer.effect(Cap, makeDaxConnectHttpBinding({ … }))` calls over the
 * builder below. Only the IAM action list differs per access level.
 */

/**
 * Protocol actions every DAX client needs regardless of access level — the
 * client discovers cluster nodes and negotiates the item schema before any
 * item operation.
 */
export const DAX_PROTOCOL_ACTIONS = [
  "dax:DefineAttributeList",
  "dax:DefineAttributeListId",
  "dax:DefineKeySchema",
  "dax:Endpoints",
] as const;

/** Read-side DAX data-plane actions. */
export const DAX_READ_ACTIONS = [
  "dax:GetItem",
  "dax:BatchGetItem",
  "dax:Query",
  "dax:Scan",
] as const;

/** Write-side DAX data-plane actions. */
export const DAX_WRITE_ACTIONS = [
  "dax:PutItem",
  "dax:UpdateItem",
  "dax:DeleteItem",
  "dax:BatchWriteItem",
  "dax:ConditionCheckItem",
] as const;

/**
 * Build the impl Effect for a connect binding. At deploy time it grants
 * `actions` on the cluster ARN and publishes the discovery endpoint as
 * `DAX_{LOGICAL_ID}_{HOST,PORT,URL,TLS}` environment variables on the host
 * Function; at runtime it resolves the same values into a typed connection
 * descriptor.
 */
export const makeDaxConnectHttpBinding = (options: {
  /** Fully-qualified binding tag, e.g. `AWS.DAX.ConnectReadWrite`. */
  tag: string;
  /** IAM actions granted on the cluster ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    return Effect.fn(function* (cluster: Cluster) {
      const Host = yield* cluster.discoveryEndpointAddress;
      const Port = yield* cluster.discoveryEndpointPort;
      const Url = yield* cluster.discoveryEndpointUrl;
      const EncryptionType = yield* cluster.clusterEndpointEncryptionType;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const prefix = connectEnvPrefix(cluster.LogicalId);
        yield* bind`${options.tag}(${cluster})`({
          env: {
            [`${prefix}_HOST`]: cluster.discoveryEndpointAddress,
            // Lambda environment variables are strings — stringify the port.
            [`${prefix}_PORT`]: Output.interpolate`${cluster.discoveryEndpointPort}`,
            [`${prefix}_URL`]: cluster.discoveryEndpointUrl,
            [`${prefix}_TLS`]: Output.map(cluster.clusterEndpointEncryptionType, (encryption) =>
              encryption === "TLS" ? "true" : "false",
            ),
          },
          policyStatements: [
            {
              Effect: "Allow",
              Action: [...options.actions],
              Resource: [Output.interpolate`${cluster.clusterArn}`],
            },
          ],
        });
      }

      return Effect.gen(function* () {
        const host = yield* Host;
        const port = yield* Port;
        const url = yield* Url;
        const encryptionType = yield* EncryptionType;
        if (!host || port === undefined || !url) {
          return yield* Effect.die(
            `DAX discovery endpoint for '${cluster.LogicalId}' is not available yet`,
          );
        }
        return {
          host,
          port,
          url,
          tls: encryptionType === "TLS",
        };
      });
    });
  });
