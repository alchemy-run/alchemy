import * as secret from "@distilled.cloud/modal/secret";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenModalBinding } from "./BindingHttp.ts";
import { CreateSecret, type SecretsClientOf } from "./CreateSecret.ts";
import type { Environment } from "./Environment.ts";
import { environmentOf, listAll, operations } from "./internal.ts";
import { ownedName, type RuntimeOwner, RuntimeOwnerOf, unownedName } from "./RuntimeOwner.ts";
import { lookupSecret, putSecret } from "./Secret.ts";

/** The operations the client calls, resolved by `ModalBindings.withCredentials`. */
export const SecretsOps = operations({
  getOrCreate: secret.secretGetOrCreate,
  delete: secret.deleteSecret,
  list: secret.listSecret,
});

export type SecretsOps = Effect.Success<typeof SecretsOps>;

/** A secrets client over an environment name resolved per call. */
export const makeSecretsClient = (
  environment: Effect.Effect<string | undefined>,
  ops: SecretsOps,
  owner: Effect.Effect<RuntimeOwner | undefined> = Effect.undefined,
): SecretsClientOf<never> => ({
  put: (name, env) =>
    Effect.flatMap(Effect.all([environment, owner]), ([e, stamp]) =>
      putSecret(ops.getOrCreate, ownedName(stamp, name), e, env),
    ),
  get: (name) =>
    Effect.flatMap(Effect.all([environment, owner]), ([e, stamp]) =>
      lookupSecret(ops.getOrCreate, ownedName(stamp, name), e),
    ),
  delete: (name) =>
    Effect.gen(function* () {
      const env = yield* environment;
      const found = yield* lookupSecret(ops.getOrCreate, ownedName(yield* owner, name), env);
      if (!found) return;
      yield* ops
        .delete({ secretId: found.secretId })
        .pipe(Effect.catchTag("SecretNotFound", () => Effect.void));
    }),
  list: () =>
    Effect.gen(function* () {
      const env = yield* environment;
      const stamp = yield* owner;
      const items = yield* listAll(
        (pagination) =>
          ops
            .list({ environmentName: environmentOf(env), pagination })
            .pipe(Effect.map((response) => response.items ?? [])),
        (item) => item.createdAt,
      );
      return items.flatMap((item) => {
        const name = item.label ?? item.metadata?.name;
        const own = name ? unownedName(stamp, name) : undefined;
        return own ? [own] : [];
      });
    }),
});

/**
 * {@link CreateSecret} over Modal's API. Grants the host's identity (a scoped
 * `Modal.ServiceUser`) the `contributor` role on the environment.
 *
 * @layer
 * @product Secret
 * @provides Modal.CreateSecret
 */
export const CreateSecretHttp = Layer.effect(
  CreateSecret,
  makeOpenModalBinding({
    tag: "Modal.CreateSecret",
    operations: SecretsOps,
    role: "contributor",
    environmentOf: (environment?: Environment) => environment?.name,
    make: Effect.fn(function* (ops, environment?: Environment) {
      const name = environment ? yield* environment.name : Effect.undefined;
      const owner = yield* RuntimeOwnerOf();
      return makeSecretsClient(name, ops, owner);
    }),
  }),
);
