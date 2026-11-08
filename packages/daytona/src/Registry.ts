import * as registries from "@distilled.cloud/daytona/docker_registry";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import type { Providers } from "./Providers.ts";

export interface RegistryProps {
  /**
   * Registry name in Daytona. If omitted, a unique name is generated from
   * the stack, stage and logical ID.
   */
  name?: string;
  /** Registry host, e.g. `ghcr.io`, `docker.io` or an ECR host. */
  url: string;
  /** User name for the registry. */
  username: string;
  /** Password or access token for the registry. Updated in place. */
  password: string | Redacted.Redacted<string>;
  /** Project or namespace within the registry, if it has them. */
  project?: string;
  /** IAM role Daytona assumes for mTLS to the registry (ECR). */
  mtlsRoleArn?: string;
  /** Secrets Manager ARN holding the mTLS client certificate. */
  mtlsSecretArn?: string;
}

export interface RegistryAttributes {
  /** Registry ID. */
  registryId: string;
  /** Registry name. */
  name: string;
  /** Registry host. */
  url: string;
  /** User name. */
  username: string;
  /** Project or namespace. */
  project: string;
  /** `organization`, `internal`, … */
  registryType: string;
}

export type Registry = Resource<
  "Daytona.Registry",
  RegistryProps,
  RegistryAttributes,
  never,
  Providers,
  RegistryLookup
>;

/**
 * Props for {@link Registry.lookup}: find a container registry this
 * stack doesn't manage by its name.
 */
export interface RegistryLookup {
  /** Registry name. */
  name: string;
}

/**
 * Credentials for a private container registry, so Daytona can pull
 * private images into a {@link Snapshot}. Daytona picks the registry whose
 * `url` matches the image's host.
 * @see https://www.daytona.io/docs/en/snapshots/#images-from-private-registries
 *
 * ### Pulling a Private Image
 * **Example:** GitHub Container Registry
 * ```typescript
 * export const Ghcr = Daytona.Registry("Ghcr", {
 *   url: "ghcr.io",
 *   username: "alchemy-run",
 *   password: Config.Redacted("GHCR_TOKEN"),
 * });
 *
 * export const Base = Daytona.Snapshot("Base", {
 *   image: "ghcr.io/alchemy-run/base:1.0.0",
 *   registry: Ghcr,
 * });
 * ```
 *
 * ### Looking up an existing registry
 * `Registry.lookup` references a registry Alchemy doesn't manage (created in
 * the Daytona dashboard or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 *
 * **Example:** Reference an existing registry
 * ```typescript
 * const ghcr = Daytona.Registry.lookup({ name: "ghcr" });
 * ```
 *
 * @resource
 * @product Registry
 */
export const Registry = Resource<Registry>("Daytona.Registry");

const toAttributes = (r: registries.DockerRegistry2): RegistryAttributes => ({
  registryId: r.id,
  name: r.name,
  url: r.url,
  username: r.username,
  project: r.project,
  registryType: r.registryType,
});

const getById = (id: string) =>
  registries.getRegistry({ id }).pipe(Effect.catchTag("RegistryNotFound", () => Effect.undefined));

const findByName = (name: string) =>
  registries.listRegistries({}).pipe(Effect.map((all) => all.find((r) => r.name === name)));

export const RegistryProvider = () =>
  Provider.effect(
    Registry,
    Effect.succeed({
      stables: ["registryId"],
      list: Effect.fn(function* () {
        const all = yield* registries.listRegistries({});
        return all.filter((r) => r.registryType === "organization").map(toAttributes);
      }),
      lookup: Effect.fn(function* ({ name }) {
        const found = yield* findByName(name);
        return found === undefined ? undefined : toAttributes(found);
      }),

      read: Effect.fn(function* ({ id, olds, output }) {
        const name = yield* resolveName(id, olds?.name, output?.name);
        const found =
          (output ? yield* getById(output.registryId) : undefined) ?? (yield* findByName(name));
        if (found === undefined) return undefined;
        const attrs = toAttributes(found);
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = yield* resolveName(id, news.name, output?.name);
        // Observe
        const current =
          (output ? yield* getById(output.registryId) : undefined) ?? (yield* findByName(name));
        const desired = {
          name,
          url: news.url,
          username: news.username,
          password: news.password,
          project: news.project,
          mtlsRoleArn: news.mtlsRoleArn ?? null,
          mtlsSecretArn: news.mtlsSecretArn ?? null,
        };
        // Ensure
        if (current === undefined) {
          return toAttributes(yield* registries.createRegistry(desired));
        }
        // Sync — the password can't be read back, so every reconcile
        // writes the full registry (updateRegistry is a PATCH of all fields).
        return toAttributes(yield* registries.updateRegistry({ id: current.id, ...desired }));
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* registries
          .deleteRegistry({ id: output.registryId })
          .pipe(Effect.catchTag("RegistryNotFound", () => Effect.void));
      }),
    }),
  );
