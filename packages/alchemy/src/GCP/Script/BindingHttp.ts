import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Deployment } from "./Deployment.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Apps Script deployment bindings.
 * NOT exported from index.ts.
 */
export const makeDeploymentHttpBinding = <
  I extends { scriptId: string; deploymentId: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (deployment: Deployment) {
      const scriptId = yield* deployment.scriptId;
      const deploymentId = yield* deployment.deploymentId;
      return Effect.fn(`${options.tag}(${deployment.LogicalId})`)(function* (
        request: Omit<I, "scriptId" | "deploymentId">,
      ) {
        return yield* run({
          ...request,
          scriptId: yield* scriptId,
          deploymentId: yield* deploymentId,
        } as I);
      });
    });
  });

export const makeRunScriptsHttpBinding = <
  I extends { scriptId: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (deployment: Deployment) {
      const deploymentId = yield* deployment.deploymentId;
      return Effect.fn(`${options.tag}(${deployment.LogicalId})`)(function* (
        request: Omit<I, "scriptId">,
      ) {
        return yield* run({
          ...request,
          scriptId: yield* deploymentId,
        } as I);
      });
    });
  });
