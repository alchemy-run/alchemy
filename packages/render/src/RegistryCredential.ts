import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Client from "./internal/Client.ts";
import { toRedacted, unwrapSecret } from "./internal/Redacted.ts";
import type { Providers } from "./Providers.ts";
import type { RegistryType, SecretString } from "./Types.ts";

export interface RegistryCredentialProps {
  /** Descriptive credential name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Container registry type (`AWS_ECR`, `DOCKER`, `GITHUB`, `GITLAB`, or `GOOGLE_ARTIFACT`). */
  registry: RegistryType;
  /** Username or account identifier for the registry. */
  username: string;
  /** Password, access token, or JSON credential string used to authenticate with the registry. */
  authToken: SecretString;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
}

export interface RegistryCredentialAttributes {
  /** Registry credential ID (`rgc-...`). */
  id: string;
  /** Credential name. */
  name: string;
  /** Container registry type. */
  registry: RegistryType | (string & {});
  /** Registry username. */
  username: string;
  /** Redacted registry auth token retained in state. */
  authToken?: Redacted.Redacted<string>;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
}

export interface RegistryCredentialLookup {
  /** Look up an existing registry credential by ID. */
  id?: string;
  /** Look up an existing registry credential by name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

/**
 * Container registry credentials used by Render services to pull private images
 * from Docker Hub, GitHub Container Registry, GitLab, AWS ECR, or Google Artifact Registry.
 *
 * **Example:** GitHub Container Registry credential
 * ```typescript
 * const ghcr = yield* Render.RegistryCredential("GhcrAuth", {
 *   name: "ghcr-prod",
 *   registry: "GITHUB",
 *   username: "alchemy-bot",
 *   authToken: yield* Config.Redacted("GHCR_TOKEN"),
 * });
 * ```
 *
 * @resource
 * @product Security
 * @category Config & Access
 */
export interface RegistryCredential extends Resource<
  "Render.RegistryCredential",
  RegistryCredentialProps,
  RegistryCredentialAttributes,
  never,
  Providers,
  RegistryCredentialLookup
> {}

export const RegistryCredential = Resource<RegistryCredential>("Render.RegistryCredential");

const mapCredential = (
  cred: { id: string; name: string; registry: string; username: string; updatedAt: string },
  authToken?: SecretString,
): RegistryCredentialAttributes => ({
  id: cred.id,
  name: cred.name,
  registry: cred.registry,
  username: cred.username,
  ...(authToken !== undefined ? { authToken: toRedacted(authToken) } : {}),
  updatedAt: cred.updatedAt,
});

export const RegistryCredentialProvider = () =>
  Provider.effect(
    RegistryCredential,
    Effect.succeed({
      stables: ["id"],
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const cred = yield* Client.ignoreNotFound(Client.getRegistryCredential(output.id));
          return cred ? mapCredential(cred, output.authToken) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Client.resolveOwnerId(explicitOwnerId);
        const list = yield* Client.listRegistryCredentials({ ownerId: [ownerId] });
        const matched = list.find((c) => c.name === desiredName);
        if (!matched) return undefined;
        const attrs = mapCredential(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const cred = yield* Client.ignoreNotFound(Client.getRegistryCredential(props.id));
          return cred ? mapCredential(cred) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Client.resolveOwnerId(props.ownerId);
          const list = yield* Client.listRegistryCredentials({ ownerId: [ownerId] });
          const matched = list.find((c) => c.name === props.name);
          return matched ? mapCredential(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Client.resolveOwnerId();
        const list = yield* Client.listRegistryCredentials({ ownerId: [ownerId] });
        return list.map((c) => mapCredential(c));
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const authToken = unwrapSecret(news.authToken);
        const existing = output?.id
          ? yield* Client.ignoreNotFound(Client.getRegistryCredential(output.id))
          : undefined;

        if (!existing) {
          const ownerId = yield* Client.resolveOwnerId(news.ownerId);
          const created = yield* Client.createRegistryCredential({
            name,
            ownerId,
            registry: news.registry,
            username: news.username,
            authToken,
          });
          return mapCredential(created, news.authToken);
        }

        const updated = yield* Client.updateRegistryCredential(existing.id, {
          name,
          registry: news.registry,
          username: news.username,
          authToken,
        });
        return mapCredential(updated, news.authToken);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Client.deleteRegistryCredential(output.id);
      }),
    }),
  );
