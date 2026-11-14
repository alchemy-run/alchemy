import * as secret from "@distilled.cloud/modal/secret";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeModalBinding } from "./BindingHttp.ts";
import { operations } from "./internal.ts";
import type { Secret } from "./Secret.ts";
import { WriteSecret, type WriteSecretClient } from "./WriteSecret.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
const WriteSecretOps = operations({ getInfo: secret.secretGetInfo, update: secret.updateSecret });

export type WriteSecretOps = Effect.Success<typeof WriteSecretOps>;

/** A write client over a secret id. */
export const makeWriteSecretClient = (
  secretId: Effect.Effect<string>,
  ops: WriteSecretOps,
): WriteSecretClient => ({
  secretId,
  put: (env) =>
    Effect.gen(function* () {
      const id = yield* secretId;
      const { metadata } = yield* ops.getInfo({ secretId: id });
      const values = Object.entries(env).map(([key, value]) => ({
        key,
        value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
      }));
      const removed = (metadata?.keys ?? []).filter((key) => !(key in env));
      yield* ops.update({
        secretId: id,
        updates: [...values, ...removed.map((key) => ({ key }))],
      });
    }),
});

/**
 * {@link WriteSecret} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the secret's environment.
 *
 * @layer
 * @product Secret
 * @provides Modal.WriteSecret
 */
export const WriteSecretHttp = Layer.effect(
  WriteSecret,
  makeModalBinding({
    tag: "Modal.WriteSecret",
    operations: WriteSecretOps,
    role: "contributor",
    make: Effect.fn(function* (resource: Secret, ops) {
      const secretId = yield* resource.secretId;
      return makeWriteSecretClient(secretId, ops);
    }),
  }),
);
