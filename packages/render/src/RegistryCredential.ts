import * as RenderSdk from "@distilled.cloud/render";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Api from "./internal/Api.ts";
import { toRedacted } from "./internal/Redacted.ts";
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
  cred: RenderSdk.RegistryCredential,
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
          const cred = yield* Api.ignoreNotFound(
            RenderSdk.getRegistryCredential({ registryCredentialId: output.id }),
          );
          return cred ? mapCredential(cred, output.authToken) : undefined;
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
        const list = yield* RenderSdk.listRegistryCredentials({
          ownerId: [ownerId],
          limit: 100,
        });
        const matched = list.find((c) => c.name === desiredName);
        if (!matched) return undefined;
        const attrs = mapCredential(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const cred = yield* Api.ignoreNotFound(
            RenderSdk.getRegistryCredential({ registryCredentialId: props.id }),
          );
          return cred ? mapCredential(cred) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Api.resolveOwnerId(props.ownerId);
          const list = yield* RenderSdk.listRegistryCredentials({
            ownerId: [ownerId],
            limit: 100,
          });
          const matched = list.find((c) => c.name === props.name);
          return matched ? mapCredential(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Api.resolveOwnerId();
        const list = yield* RenderSdk.listRegistryCredentials({
          ownerId: [ownerId],
          limit: 100,
        });
        return list.map((c) => mapCredential(c));
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const authToken = toRedacted(news.authToken);
        const existing = output?.id
          ? yield* Api.ignoreNotFound(
              RenderSdk.getRegistryCredential({ registryCredentialId: output.id }),
            )
          : undefined;

        if (!existing) {
          const ownerId = yield* Api.resolveOwnerId(news.ownerId);
          const created = yield* RenderSdk.createRegistryCredential({
            name,
            ownerId,
            registry: news.registry,
            username: news.username,
            authToken,
          });
          return mapCredential(created, news.authToken);
        }

        const updated = yield* RenderSdk.updateRegistryCredential({
          registryCredentialId: existing.id,
          name,
          registry: news.registry,
          username: news.username,
          authToken,
        });
        return mapCredential(updated, news.authToken);
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Api.deleteIdempotent(
          RenderSdk.deleteRegistryCredential({ registryCredentialId: output.id }),
        );
      }),
    }),
  );
