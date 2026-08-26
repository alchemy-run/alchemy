import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { UsersSshPublicKey } from "./UsersSshPublicKey.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  Credentials | HttpClient.HttpClient
> &
  ((input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>);

/**
 * Shared HTTP scaffolding for OS Login SSH public key bindings.
 * NOT exported from index.ts.
 */
export const makeUsersSshPublicKeyHttpBinding = <
  I extends { name: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (sshKey: UsersSshPublicKey) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: sshKey,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* sshKey.name;
      return Effect.fn(`${options.tag}(${sshKey.LogicalId})`)(function* (
        request: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });
