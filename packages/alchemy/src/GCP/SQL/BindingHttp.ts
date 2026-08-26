import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { Instance } from "./Instance.ts";
import type { User } from "./User.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for Cloud SQL instance and user bindings.
 * Distilled ops are OperationMethods: yield them once at Layer
 * construction (after providing Credentials + HttpClient) so the inner
 * runtime Effect is `Effect<A, E>` and does not leak `GcpOpContext`.
 * NOT exported from index.ts.
 */
export const makeSqlInstanceHttpBinding = <
  I extends { instance?: string; project?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* options.operation.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (instance: Instance) {
      const instanceName = yield* instance.instanceName;
      const project = yield* instance.project;
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "instance" | "project">,
      ) {
        return yield* run({
          ...(request ?? {}),
          instance: yield* instanceName,
          project: yield* project,
        } as I);
      });
    });
  });

export const makeSqlUserHttpBinding = <
  I extends {
    name?: string;
    instance?: string;
    project?: string;
    host?: string;
  },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    const run = yield* options.operation.pipe(
      Effect.provideService(Credentials, credentials),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return Effect.fn(function* (user: User) {
      const userName = yield* user.userName;
      const instance = yield* user.instance;
      const project = yield* user.project;
      const host = yield* user.host;
      return Effect.fn(`${options.tag}(${user.LogicalId})`)(function* (
        request?: Omit<I, "name" | "instance" | "project">,
      ) {
        const resolvedHost = request?.host ?? (yield* host);
        return yield* run({
          ...(request ?? {}),
          name: yield* userName,
          instance: yield* instance,
          project: yield* project,
          ...(resolvedHost ? { host: resolvedHost } : {}),
        } as I);
      });
    });
  });
