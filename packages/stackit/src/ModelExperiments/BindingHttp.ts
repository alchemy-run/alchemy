import { MlflowCredentials, mlflowCredentialsOf } from "@distilled.cloud/stackit/Credentials";
import type * as mlflow from "@distilled.cloud/stackit/model_experiments_mlflow";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { redactedValue } from "../internal/aiTokens.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { Instance } from "./Instance.ts";
import type { Token } from "./Token.ts";

/**
 * Shared HTTP scaffolding for STACKIT AI Model Experiments bindings.
 * NOT exported from index.ts.
 *
 * Management bindings grant on the project holding the instance: STACKIT has no role binding on a
 * single instance (see `StackitBindings`). The grants list exactly the permission an operation
 * needs, the `x-stackit-authorization` action in the service's API spec.
 *
 * Tracking bindings call MLflow on the instance with one of its tracking tokens, so they grant no
 * STACKIT role and create no service account.
 */

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ModelExperiments.GetInstance`. */
  tag: string;
  /** The permission the operation needs on the project holding the instance. */
  permission: string;
  /** The distilled operation; the instance's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/** Build a binding over one operation on the bound instance's project and region. */
export const makeProjectHttpBinding = <
  I extends { projectId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ModelExperiments.ListInstances`. */
  tag: string;
  /** The permission the operation needs on the project. */
  permission: string;
  /** The distilled operation; the project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/** Build a binding over one operation on a token. */
export const makeTokenHttpBinding = <
  I extends { projectId: string; regionId: string; instanceId: string; tokenId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ModelExperiments.GetToken`. */
  tag: string;
  /** The permission the operation needs on the project holding the token's instance. */
  permission: string;
  /** The distilled operation; the token's project, region, instance and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (token: Token) => ({
      projectId: token.projectId,
      regionId: token.region,
      instanceId: token.instanceId,
      tokenId: token.tokenId,
    }),
    grants: (token) => [StackitBindings.grantOn(token, { permissions: [options.permission] })],
  });

/**
 * Build a binding over one operation of an instance's MLflow: `<Op>Http.ts` is one call to it.
 * Reading the token's attributes here binds them into the host's env, kept `Redacted`. Each request
 * acquires what it needs, so nothing outlives a request on a host like workerd.
 */
export const makeMlflowBinding = <I, A, E>(
  operation: (input: I) => Effect.Effect<A, E, mlflow.MlflowOpContext>,
) =>
  Effect.fn(function* (token: Token) {
    const instanceUrl = yield* token.instanceUrl;
    const value = yield* token.token;
    return (request: I) =>
      Effect.gen(function* () {
        const url = yield* instanceUrl;
        const tracking = yield* value;
        return yield* operation(request).pipe(
          Effect.provideService(
            MlflowCredentials,
            mlflowCredentialsOf({
              instanceUrl: url,
              token: tracking === undefined ? undefined : redactedValue(tracking),
            }),
          ),
          Effect.provide(FetchHttpClient.layer),
        );
      });
  });
