import * as secrets from "@distilled.cloud/e2b/secrets";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { E2BUnexpectedResponse } from "./Errors.ts";
import {
  e2bName,
  hasAnyAlchemyMetadata,
  hasOwnershipMetadata,
  ownershipMetadata,
  userMetadata,
} from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface SecretProps {
  /**
   * Secret name, unique within the team. E2B lowercases it. If omitted, a
   * unique name is generated from the stack, stage and logical ID. Changing
   * it replaces the secret.
   */
  name?: string;
  /**
   * The secret value. Write-only: E2B never returns it. Changing it stores a
   * new version, which every sandbox resolves on its next request.
   */
  value: Redacted.Redacted<string>;
  /** Your own metadata (at most 32 entries). */
  metadata?: Record<string, string>;
}

export interface SecretAttributes {
  /** E2B's secret id (`sec_…`). */
  secretId: string;
  /** The secret's canonical (lowercased) name. */
  name: string;
  /** The version sandboxes resolve. */
  version: number;
  /** Your metadata, without Alchemy's ownership stamp. */
  metadata: Record<string, string>;
  /**
   * The placeholder E2B resolves to the secret's value at sandbox egress:
   * `${e2b.secrets.<name>}`. Put it in a sandbox's network header rules; the
   * value itself never enters the sandbox.
   */
  ref: string;
}

export interface Secret extends Resource<
  "E2B.Secret",
  SecretProps,
  SecretAttributes,
  never,
  Providers,
  { name: string }
> {}

/**
 * An E2B secret: a write-only value that E2B injects into a sandbox's
 * outbound requests, so code inside the sandbox never sees it.
 *
 * Reference a secret in a sandbox's network rules with its `ref`
 * placeholder (`${e2b.secrets.<name>}`). E2B resolves the placeholder at
 * egress, on the host, for requests to the domains you list.
 *
 * Alchemy stamps its stack, stage and logical ID into the secret's
 * metadata to recognise the secrets it owns.
 *
 * ### Creating a Secret
 * **Example:** A GitHub token from the stage's config
 * ```typescript
 * export const GitHubToken = E2B.Secret("GitHubToken", {
 *   value: Config.Redacted("GITHUB_TOKEN"),
 * });
 * ```
 *
 * ### Injecting a Secret at egress
 * **Example:** Authenticate GitHub API calls from inside a sandbox
 * ```typescript
 * const github = yield* GitHubToken;
 * const sandbox = yield* sandboxes.create({
 *   network: {
 *     allowOut: ["api.github.com"],
 *     rules: {
 *       "api.github.com": [{ transform: { headers: { Authorization: `Bearer ${github.ref}` } } }],
 *     },
 *   },
 * });
 * ```
 *
 * ### Rotating a Secret
 * Changing `value` stores a new version in place. Sandboxes resolve the new
 * version on their next request.
 *
 * **Example:** Rotate at runtime with `WriteSecret`
 * ```typescript
 * const token = yield* E2B.WriteSecret(GitHubToken);
 * yield* token.put(Redacted.make(freshToken));
 * ```
 *
 * ### Referencing a secret the stack doesn't manage
 * `E2B.Secret.lookup` finds an existing secret by name. Nothing is created,
 * adopted or deleted.
 *
 * **Example:** Look one up by name
 * ```typescript
 * const github = E2B.Secret.lookup({ name: "github-token" });
 * const token = yield* E2B.WriteSecret(github);
 * ```
 *
 * @resource
 * @product Secret
 */
export const Secret = Resource<Secret>("E2B.Secret");

/** E2B's egress placeholder for a secret name. */
export const secretRef = (name: string): string => `\${e2b.secrets.${name}}`;

export const toSecretAttributes = (secret: secrets.Secret): SecretAttributes => ({
  secretId: secret.secretID,
  name: secret.name,
  version: secret.currentVersion,
  metadata: userMetadata(secret.metadata as Record<string, string>),
  ref: secretRef(secret.name),
});

/** A secret by id or canonical name (E2B accepts either). */
export const observeSecret = (idOrName: string) =>
  secrets.getSecret({ secretID: idOrName }).pipe(
    Effect.map((secret): secrets.Secret | undefined => secret),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const sameMetadata = (a: Record<string, string>, b: Record<string, string | undefined>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
};

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      return {
        stables: ["secretId", "name", "ref"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (news.name === undefined && olds?.name === undefined) return undefined;
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          if (news.name?.toLowerCase() !== name) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name }) {
          const secret = yield* observeSecret(name.toLowerCase());
          return secret === undefined ? undefined : toSecretAttributes(secret);
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          const secret = yield* observeSecret(output?.secretId ?? name);
          if (secret === undefined) return undefined;
          const attrs = toSecretAttributes(secret);
          const ours =
            output !== undefined ||
            (yield* hasOwnershipMetadata(id, secret.metadata as Record<string, string>));
          return ours ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const name = output?.name ?? (yield* e2bName(id, news.name)).toLowerCase();
          const metadata = { ...news.metadata, ...(yield* ownershipMetadata(id)) };

          // Observe
          let secret = yield* observeSecret(output?.secretId ?? name);

          // Ensure — a Conflict is a peer creating the same name: read it back
          // and fall through to the sync, which writes our value.
          if (secret === undefined) {
            yield* session.note(`Creating secret ${name}...`);
            const created = yield* secrets.createSecret({ name, value: news.value, metadata }).pipe(
              Effect.map((s): secrets.Secret | undefined => s),
              Effect.catchTag("Conflict", () => Effect.undefined),
            );
            if (created !== undefined) return toSecretAttributes(created);
            secret = yield* observeSecret(name);
            if (secret === undefined) {
              return yield* new E2BUnexpectedResponse({
                message: `E2B secret ${name} vanished after create`,
              });
            }
            // A secret someone else created under this name: write our value.
            olds = undefined;
          }

          // Sync — values are write-only, so `olds` is the only signal that the
          // stored value already matches. Without it (adoption, a lost write),
          // store ours. Metadata is observed.
          const valueChanged =
            olds === undefined || Redacted.value(olds.value) !== Redacted.value(news.value);
          const metadataChanged = !sameMetadata(
            metadata,
            secret.metadata as Record<string, string | undefined>,
          );
          if (valueChanged || metadataChanged) {
            secret = yield* secrets.updateSecret({
              secretID: secret.secretID,
              value: news.value,
              metadata,
            });
          }
          return toSecretAttributes(secret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* secrets
            .deleteSecret({ secretID: output.secretId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const all = Array.from(
            yield* Stream.runCollect(secrets.listSecrets.items({ limit: 100 })),
          );
          return all
            .filter((secret) => hasAnyAlchemyMetadata(secret.metadata as Record<string, string>))
            .map(toSecretAttributes);
        }),
      };
    }),
  );
