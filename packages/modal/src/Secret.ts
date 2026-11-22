import * as secret from "@distilled.cloud/modal/secret";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  type EnvironmentInput,
  envNameOf,
  environmentNames,
  environmentOf,
  isGeneratedName,
  listAll,
  objectName,
} from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";
import { isRuntimeName } from "./RuntimeOwner.ts";

export class SecretUnexpectedResponse extends Data.TaggedError("Modal.SecretUnexpectedResponse")<{
  readonly message: string;
}> {}

export interface SecretProps {
  /**
   * Secret name, unique per environment. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces the
   * secret.
   */
  name?: string;
  /**
   * Environment the secret lives in. Changing it replaces the secret.
   * @default the workspace's default environment
   */
  environment?: EnvironmentInput;
  /**
   * The secret's environment variables. Containers that attach the secret
   * see each entry as an environment variable; an outbound header
   * replacement can inject one into requests instead, so the container never
   * sees it. Every deploy writes the full set.
   */
  env: Record<string, string | Redacted.Redacted<string>>;
}

export interface SecretAttributes {
  /** Secret ID (`st-…`). */
  secretId: string;
  /** Secret name. */
  name: string;
  /** Environment name, or `undefined` for the workspace default. */
  environment: string | undefined;
  /** The secret's variable names (values are never returned by Modal). */
  keys: string[];
}

/**
 * A Modal Secret: a named set of environment variables stored by Modal and
 * attached to Sandboxes and Functions by reference.
 *
 * A Sandbox can see a secret two ways: as environment variables
 * (`secrets: [OpenAI]`), or through an outbound header replacement
 * (`outboundPolicy`), where Modal adds the value to matching HTTPS requests
 * on their way out and the sandbox never holds it. Prefer the second for
 * credentials an agent's code shouldn't be able to read.
 *
 * Modal never returns secret values, so every deploy overwrites the full
 * `env` map. Modal secrets have no tags; ownership is inferred from Alchemy
 * state.
 *
 * ### Creating a Secret
 * **Example:** An API key from your Alchemy secrets
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const OpenAI = Modal.Secret("OpenAI", {
 *   env: { OPENAI_API_KEY: Alchemy.Secret("OPENAI_API_KEY") },
 * });
 * ```
 *
 * ### Using a Secret in a Sandbox
 * **Example:** As environment variables
 * ```typescript
 * // construction phase: read the Secret's id
 * const openaiId = yield* (yield* OpenAI).secretId;
 * // in a handler
 * const openai = { secretId: yield* openaiId };
 * const sandbox = yield* sandboxes.create({ secrets: [openai] });
 * ```
 *
 * **Example:** Injected into outbound requests only
 * ```typescript
 * // construction phase: read the Secret's id
 * const openaiId = yield* (yield* OpenAI).secretId;
 * // in a handler
 * const openai = { secretId: yield* openaiId };
 * const sandbox = yield* sandboxes.create({
 *   outboundPolicy: {
 *     routes: [
 *       {
 *         https: {
 *           domains: ["api.openai.com"],
 *           headerReplacements: [{ secret: openai, headers: { Authorization: "Bearer $OPENAI_API_KEY" } }],
 *         },
 *       },
 *       { any: {} },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Rotating a Secret at runtime
 * **Example:** Bind write access
 * ```typescript
 * const openai = yield* Modal.WriteSecret(OpenAI);
 * yield* openai.put({ OPENAI_API_KEY: newKey });
 * ```
 *
 * ### Looking up an existing secret
 * `Secret.lookup` references a secret Alchemy doesn't manage (created with
 * the Modal CLI or by another stack). It is read during plan/deploy, never
 * created, updated or deleted. Its values are never read; `keys` lists their
 * names.
 *
 * **Example:** Reference an existing secret
 * ```typescript
 * const openai = Modal.Secret.lookup({ name: "openai" });
 * ```
 *
 * @resource
 * @product Secret
 */
export const Secret = declarable<Secret>()(Resource<Secret>("Modal.Secret"));

export type Secret = Resource<
  "Modal.Secret",
  SecretProps,
  SecretAttributes,
  never,
  Providers,
  SecretLookup
>;

/**
 * Props for {@link Secret.lookup}: find a secret this stack
 * doesn't manage by its name.
 */
export interface SecretLookup {
  /** Secret name. */
  name: string;
  /**
   * Modal environment the object lives in.
   * @default the workspace's default environment
   */
  environment?: string;
}

const plainEnv = (env: Record<string, string | Redacted.Redacted<string>>) =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      Redacted.isRedacted(value) ? Redacted.value(value) : value,
    ]),
  );

/** A secret by name, or `undefined` when missing. */
export const lookupSecret = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof secret.secretGetOrCreate>,
  name: string,
  env: string | undefined,
) {
  const found = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_UNSPECIFIED",
  }).pipe(Effect.catchTag("SecretNotFound", () => Effect.undefined));
  if (!found?.secretId) return undefined;
  return {
    secretId: found.secretId,
    name,
    environment: env,
    keys: found.metadata?.keys ?? [],
  } satisfies SecretAttributes;
});

/**
 * Create or overwrite a secret by name: the one implementation behind
 * {@link Secret}'s reconcile and the runtime {@link CreateSecret} and
 * {@link WriteSecret} clients.
 */
export const putSecret = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof secret.secretGetOrCreate>,
  name: string,
  env: string | undefined,
  values: Record<string, string | Redacted.Redacted<string>>,
) {
  const written = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_CREATE_OVERWRITE_IF_EXISTS",
    envDict: plainEnv(values),
  });
  if (!written.secretId) {
    return yield* new SecretUnexpectedResponse({
      message: `Modal returned no id for secret ${name}`,
    });
  }
  return {
    secretId: written.secretId,
    name,
    environment: env,
    keys: written.metadata?.keys ?? Object.keys(values).sort(),
  } satisfies SecretAttributes;
});

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      return {
        // An overwrite gives the secret a new id, so only its name is stable.
        stables: ["name", "environment"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (envNameOf(news.environment) !== envNameOf(olds?.environment))
            return { action: "replace" } as const;
          const name = yield* objectName(id, news.name);
          if (output !== undefined && name !== output.name) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name, environment }) {
          return yield* lookupSecret(yield* secret.secretGetOrCreate, name, environment);
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const observed = yield* lookupSecret(
            yield* secret.secretGetOrCreate,
            name,
            output?.environment ?? envNameOf(olds?.environment),
          );
          if (!observed) return undefined;
          return output !== undefined || olds?.name === undefined ? observed : Unowned(observed);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* objectName(id, news.name));
          // Values can't be observed, so overwriting is the sync: Modal
          // replaces the secret atomically, under a new secret id.
          yield* session.note(`Writing secret ${name}...`);
          return yield* putSecret(
            yield* secret.secretGetOrCreate,
            name,
            envNameOf(news.environment),
            news.env,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* secret
            .deleteSecret({ secretId: output.secretId })
            .pipe(Effect.catchTag("SecretNotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const envs = yield* environmentNames;
          const all: SecretAttributes[] = [];
          for (const env of envs) {
            const items = yield* listAll(
              (pagination) =>
                secret
                  .listSecret({ environmentName: env, pagination })
                  .pipe(Effect.map((response) => response.items ?? [])),
              (item) => item.createdAt,
            );
            for (const item of items) {
              if (
                !item.secretId ||
                !(
                  isGeneratedName(item.label ?? item.metadata?.name) ||
                  isRuntimeName(item.label ?? item.metadata?.name)
                )
              )
                continue;
              all.push({
                secretId: item.secretId,
                name: item.label ?? item.metadata?.name ?? "",
                environment: env,
                keys: item.metadata?.keys ?? [],
              });
            }
          }
          return all;
        }),
      };
    }),
  );
