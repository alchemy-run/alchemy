import { createHash } from "node:crypto";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";

export type SecretVersionProps = {
  /**
   * Full name of the secret that receives the version:
   * `projects/{project}/secrets/{secret}` or
   * `projects/{project}/locations/{location}/secrets/{secret}` (pass a
   * `GCP.SecretManager.Secret`'s or `LocationsSecret`'s `name`). Changing
   * it replaces the version.
   */
  secret: string;
  /**
   * Secret payload (UTF-8, at most 64 KiB). A new version is added only
   * when the value differs from the secret's latest enabled version, so
   * redeploying the same value is a no-op.
   */
  value: string | Redacted.Redacted<string>;
  /**
   * What happens to the version on destroy or replace. `"disable"` keeps
   * it recoverable; `"destroy"` deletes its payload irreversibly.
   * @default "disable"
   */
  deletionPolicy?: "disable" | "destroy";
};

export type SecretVersion = Resource<
  "GCP.SecretManager.SecretVersion",
  SecretVersionProps,
  {
    /** Full version name `{secret}/versions/{version}`. */
    name: string;
    /** Full name of the parent secret. */
    secret: string;
    /** Version number. */
    version: string;
    /** SHA-256 of the payload (hex), used to detect a changed value. */
    digest: string;
  },
  never,
  Providers
>;

/**
 * One version of a Secret Manager secret, holding a value Alchemy manages.
 *
 * The version is added only when `value` differs from the payload of the
 * secret's latest enabled version (compared by SHA-256), so repeated
 * deploys do not pile up identical versions. Changing `value` adds a new
 * version and leaves the previous one enabled; readers of `latest` see
 * the new value.
 *
 * ### Storing a Value
 * **Example:** Store a generated password
 * ```typescript
 * const secret = yield* GCP.SecretManager.Secret("DbPassword", {});
 * const password = yield* Alchemy.Random("DbPassword");
 * const version = yield* GCP.SecretManager.SecretVersion("DbPasswordValue", {
 *   secret: secret.name,
 *   value: password.text,
 * });
 * ```
 *
 * ### Destroying the Payload
 * **Example:** Destroy the version's payload when it is removed
 * ```typescript
 * const version = yield* GCP.SecretManager.SecretVersion("ApiKeyValue", {
 *   secret: secret.name,
 *   value: Redacted.make(apiKey),
 *   deletionPolicy: "destroy",
 * });
 * ```
 *
 * @resource
 * @category SecretManager
 */
export const SecretVersion = Resource<SecretVersion>("GCP.SecretManager.SecretVersion");

const isRegional = (secret: string) => secret.includes("/locations/");

const valueOf = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const digestOf = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");

const toAttrs = (secret: string, name: string, digest: string): SecretVersion["Attributes"] => ({
  name,
  secret,
  version: name.split("/").pop() ?? name,
  digest,
});

const getVersion = (name: string) =>
  (isRegional(name)
    ? secretmanager.getProjectsLocationsSecretsVersions({ name })
    : secretmanager.getProjectsSecretsVersions({ name })
  ).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** The latest enabled version's name and payload digest, if any. */
const latestEnabled = (secret: string) =>
  (isRegional(secret)
    ? secretmanager.accessProjectsLocationsSecretsVersions({ name: `${secret}/versions/latest` })
    : secretmanager.accessProjectsSecretsVersions({ name: `${secret}/versions/latest` })
  ).pipe(
    Effect.map((response) => ({
      name: response.name ?? "",
      digest: digestOf(Buffer.from(response.payload?.data ?? "", "base64").toString("utf8")),
    })),
    Effect.catchIf(
      (error) => error._tag === "NotFound" || error._tag === "SecretVersionNotEnabled",
      () => Effect.undefined,
    ),
  );

export const SecretVersionProvider = () =>
  Provider.succeed(SecretVersion, {
    stables: ["secret"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return undefined;
      if (news.secret !== olds.secret) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const current = yield* getVersion(output.name);
      return current?.state === "ENABLED" ? output : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const data = valueOf(news.value);
      const digest = digestOf(data);

      // Observe — the latest enabled version already holds this value.
      const latest = yield* latestEnabled(news.secret);
      if (latest !== undefined && latest.digest === digest && latest.name !== "") {
        return toAttrs(news.secret, latest.name, digest);
      }

      // Ensure — add a version carrying the value.
      const body = { payload: { data: Buffer.from(data, "utf8").toString("base64") } };
      const added = yield* isRegional(news.secret)
        ? secretmanager.addVersionProjectsLocationsSecrets({ parent: news.secret, body })
        : secretmanager.addVersionProjectsSecrets({ parent: news.secret, body });
      return toAttrs(news.secret, added.name ?? "", digest);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const current = yield* getVersion(output.name);
      if (current === undefined || current.state === "DESTROYED") return;
      const name = output.name;
      if (olds.deletionPolicy === "destroy") {
        yield* (
          isRegional(name)
            ? secretmanager.destroyProjectsLocationsSecretsVersions({ name, body: {} })
            : secretmanager.destroyProjectsSecretsVersions({ name, body: {} })
        ).pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      if (current.state === "DISABLED") return;
      yield* (
        isRegional(name)
          ? secretmanager.disableProjectsLocationsSecretsVersions({ name, body: {} })
          : secretmanager.disableProjectsSecretsVersions({ name, body: {} })
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
