import * as Effect from "effect/Effect";
import type { UsersSshPublicKey } from "./UsersSshPublicKey.ts";
import { bindGcpHost } from "../Host.ts";
import { grantFor, type BindingIam, type GcpHttpOp } from "../HttpBinding.ts";

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
  /**
   * OS Login key APIs are not IAM-gated: a caller can only reach its own
   * account's keys, so bindings pass `[]`.
   */
  iam: readonly BindingIam[];
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (sshKey: UsersSshPublicKey) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: sshKey,
        iam: options.iam.map((iam) => grantFor(iam, sshKey.name)),
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
