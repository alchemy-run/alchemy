import { createHash } from "node:crypto";
import * as secrets from "@distilled.cloud/daytona/secret";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import type { Providers } from "./Providers.ts";

export interface SecretProps {
  /**
   * Secret name, unique in the organization (letters, digits, `-`, `_`).
   * If omitted, a unique name is generated from the stack, stage and
   * logical ID. Changing it replaces the secret.
   */
  name?: string;
  /** The secret value. Changing it updates the secret in place. */
  value: string | Redacted.Redacted<string>;
  /** What the secret is for. */
  description?: string;
  /**
   * The only hosts Daytona will send the real value to. A sandbox sees a
   * placeholder in its environment; Daytona's egress proxy swaps in the
   * value on requests to these hosts. Omit to allow any host.
   */
  hosts?: string[];
}

export interface SecretAttributes {
  /** Secret ID. */
  secretId: string;
  /** Secret name. */
  name: string;
  /**
   * The placeholder a sandbox sees instead of the value. Put it in a
   * sandbox's env (`env: { NPM_TOKEN: secret.placeholder }`) or pass the
   * secret in `secrets`.
   */
  placeholder: string;
  /** Hosts the value may be sent to. */
  hosts: string[];
  /** Description, if any. */
  description: string | undefined;
  /**
   * SHA-256 of the value last written. Daytona never returns a secret's
   * value, so this is how reconcile knows whether to write it again.
   */
  valueHash: string;
}

export type Secret = Resource<"Daytona.Secret", SecretProps, SecretAttributes, never, Providers>;

/**
 * A secret stored in Daytona. A sandbox gets a placeholder in place of
 * the value, and Daytona's egress proxy substitutes the real value only on
 * requests to the secret's `hosts`, so code in the sandbox (or an agent
 * running there) can use a credential without being able to read it.
 *
 * Declare a secret here for credentials the whole app shares. For a secret
 * per user, create it at runtime with {@link CreateSecret}.
 * @see https://www.daytona.io/docs/en/secrets/
 *
 * ### Creating a Secret
 * **Example:** An npm token only sent to the registry
 * ```typescript
 * export const NpmToken = Daytona.Secret("NpmToken", {
 *   value: Config.Redacted("NPM_TOKEN"),
 *   hosts: ["registry.npmjs.org"],
 * });
 * ```
 *
 * ### Using a Secret in a Sandbox
 * **Example:** Expose it to a sandbox as an environment variable
 * ```typescript
 * export const DevBox = Daytona.Sandbox("DevBox", {
 *   snapshot: Base,
 *   secrets: { NPM_TOKEN: NpmToken },
 * });
 * ```
 *
 * @resource
 * @product Secret
 */
export const Secret = Resource<Secret>("Daytona.Secret");

export const hashSecretValue = (value: string | Redacted.Redacted<string>) =>
  Effect.sync(() =>
    createHash("sha256")
      .update(Redacted.isRedacted(value) ? Redacted.value(value) : value)
      .digest("hex"),
  );

export const toSecretAttributes = (s: secrets.Secret2, valueHash: string): SecretAttributes => ({
  secretId: s.id,
  name: s.name,
  placeholder: s.placeholder,
  hosts: s.hosts,
  description: s.description,
  valueHash,
});

export const getSecretById = (secretId: string) =>
  secrets.getSecret({ secretId }).pipe(Effect.catchTag("SecretNotFound", () => Effect.undefined));

/** Exact-name lookup over the paginated list (its `name` filter is a substring match). */
export const findSecretByName = (name: string) =>
  secrets.listSecretsPaginated.items({ name }).pipe(
    Stream.filter((s) => s.name === name),
    Stream.runHead,
    Effect.map((found) => (found._tag === "Some" ? found.value : undefined)),
  );

export const ensureSecret = Effect.fn(function* (input: {
  readonly name: string;
  readonly value: string | Redacted.Redacted<string>;
  readonly description?: string | undefined;
  readonly hosts?: string[] | undefined;
  readonly existing?: secrets.Secret2 | undefined;
  readonly knownHash?: string | undefined;
}) {
  const valueHash = yield* hashSecretValue(input.value);
  const existing = input.existing ?? (yield* findSecretByName(input.name));
  if (existing === undefined) {
    const created = yield* secrets
      .createSecret({
        name: input.name,
        value: input.value,
        description: input.description,
        hosts: input.hosts,
      })
      .pipe(Effect.catchTag("SecretAlreadyExists", () => Effect.undefined));
    if (created !== undefined) return toSecretAttributes(created, valueHash);
  }
  const current = existing ?? (yield* findSecretByName(input.name));
  if (current === undefined)
    return yield* Effect.die(`Daytona secret ${input.name} vanished during create`);
  // Sync — the value can't be observed, so it is rewritten unless the
  // hash we last wrote matches. Description and hosts diff against cloud.
  const hostsChanged =
    input.hosts !== undefined && !deepEqual([...input.hosts].sort(), [...current.hosts].sort());
  const descriptionChanged =
    input.description !== undefined && input.description !== current.description;
  const valueChanged = input.knownHash !== valueHash;
  if (!hostsChanged && !descriptionChanged && !valueChanged)
    return toSecretAttributes(current, valueHash);
  const updated = yield* secrets.updateSecret({
    secretId: current.id,
    value: valueChanged ? input.value : undefined,
    description: descriptionChanged ? input.description : undefined,
    hosts: hostsChanged ? input.hosts : undefined,
  });
  return toSecretAttributes(updated, valueHash);
});

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.succeed({
      stables: ["secretId", "placeholder"],
      list: Effect.fn(function* () {
        const all = yield* secrets.listSecretsPaginated.items({}).pipe(Stream.runCollect);
        return Array.from(all).map((s) => toSecretAttributes(s, ""));
      }),
      diff: Effect.fn(function* ({ id, news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const name = yield* resolveName(
          id,
          news.name,
          news.name === undefined ? output.name : undefined,
        );
        if (name !== output.name) return { action: "replace", deleteFirst: true } as const;
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const name = yield* resolveName(id, olds?.name, output?.name);
        const found =
          (output ? yield* getSecretById(output.secretId) : undefined) ??
          (yield* findSecretByName(name));
        if (found === undefined) return undefined;
        const attrs = toSecretAttributes(found, output?.valueHash ?? "");
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = yield* resolveName(id, news.name, output?.name);
        const byId = output ? yield* getSecretById(output.secretId) : undefined;
        return yield* ensureSecret({
          name,
          value: news.value,
          description: news.description,
          hosts: news.hosts,
          existing: byId?.name === name ? byId : undefined,
          knownHash: byId?.name === name ? output?.valueHash : undefined,
        });
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* secrets
          .deleteSecret({ secretId: output.secretId })
          .pipe(Effect.catchTag("SecretNotFound", () => Effect.void));
      }),
    }),
  );
