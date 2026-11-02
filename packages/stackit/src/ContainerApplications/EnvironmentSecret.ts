import * as sca from "@distilled.cloud/stackit/sca";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScopedProps, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { childrenLeftAfterSettling, waitFor } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  ensureContainerApplicationsEnabled,
  type EnvironmentScope,
  listSecrets,
  removeSecretKeys,
  withSecretLock,
} from "./internal.ts";

export interface EnvironmentSecretProps extends ProjectScopedProps {
  /** Environment that holds the secret. Changing it replaces the secret. */
  environmentId: string;
  /** Key of the secret in the environment. Changing it replaces the secret. */
  key: string;
  /** Value of the secret. Updates in place. */
  value: string | Redacted.Redacted<string>;
  /**
   * Destroy the secret even when something other than this stack still uses it. An
   * application using it may then fail on its next start. Deploy it on its own before a change
   * that replaces the secret: an old secret keeps the props it was deployed with.
   * @default false
   */
  forceDestroy?: boolean;
  /** Project of the environment. Defaults to the profile's project. Changing it replaces the secret. */
  projectId?: string;
  /** Region of the environment. Defaults to the profile's region. Changing it replaces the secret. */
  region?: string;
}

/** Something using a secret or a registry login. */
export interface EnvironmentConsumer {
  /** Id of what uses it. */
  id: string | undefined;
  /** Display name of what uses it. */
  displayName: string | undefined;
  /** The container that uses it. */
  container: string | undefined;
}

export interface EnvironmentSecretAttributes {
  /** Environment that holds the secret. */
  environmentId: string;
  /** Project of the environment. */
  projectId: string;
  /** Region of the environment. */
  region: string;
  /** Key of the secret in the environment. */
  key: string;
  /** What uses the secret, when it was last read. */
  consumers: EnvironmentConsumer[];
  /** When the secret was created, in RFC 3339. */
  createdAt: string | undefined;
  /** When the secret last changed, in RFC 3339. */
  updatedAt: string | undefined;
}

export type EnvironmentSecret = Resource<
  "Stackit.ContainerApplications.EnvironmentSecret",
  EnvironmentSecretProps,
  EnvironmentSecretAttributes,
  never,
  Providers
>;

/**
 * One secret in a STACKIT Container Applications environment. An application reads it
 * through its `secrets` prop, as an environment variable. Its value never appears in
 * attributes, or in the application's own configuration.
 *
 * A key is the secret's only identity, and the API has no labels. A key already in the
 * environment with no state behind it is reported as unowned and only taken over with
 * `--adopt`.
 *
 * :::caution[Removing a secret is unconfirmed]
 * The API has no delete, and its spec doesn't say how to remove a secret from the
 * collection. A destroy sends the other keys and checks the result, and fails with
 * `Stackit.ContainerApplications.EnvironmentSecretNotDeleted` if the key is still there, so
 * a secret can't quietly stay behind. If that happens, remove the key in the STACKIT portal,
 * or decorate the resource with `Alchemy.RemovalPolicy.retain()` to leave it.
 * :::
 *
 * :::caution[Changing `environmentId`, `key`, `projectId` or `region` replaces the Secret]
 * The secret is written at its new place and removed from the old one.
 * :::
 *
 * ### Creating a Secret
 * **Example:** A secret from configuration
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const databaseUrl = Config.Redacted("DATABASE_URL");
 * const secret = yield* Stackit.ContainerApplications.EnvironmentSecret("DatabaseUrl", {
 *   environmentId: environment.environmentId,
 *   key: "database-url",
 *   value: databaseUrl,
 * });
 * ```
 *
 * ### Reading a Secret from an Application
 * **Example:** The secret as an environment variable
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const databaseUrl = Config.Redacted("DATABASE_URL");
 * const secret = yield* Stackit.ContainerApplications.EnvironmentSecret("DatabaseUrl", {
 *   environmentId: environment.environmentId,
 *   key: "database-url",
 *   value: databaseUrl,
 * });
 * const app = yield* Stackit.ContainerApplications.Application("Api", {
 *   environmentId: environment.environmentId,
 *   image: "ghcr.io/my-org/api:v1.0.0",
 *   secrets: { DATABASE_URL: secret.key },
 * });
 * ```
 *
 * ### Scaling on a Secret
 * **Example:** A KEDA rule that reads its connection from a secret
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const environment = yield* Stackit.ContainerApplications.Environment("Apps", {});
 * const amqpUrl = Config.Redacted("AMQP_URL");
 * const secret = yield* Stackit.ContainerApplications.EnvironmentSecret("AmqpUrl", {
 *   environmentId: environment.environmentId,
 *   key: "amqp-url",
 *   value: amqpUrl,
 * });
 * const worker = yield* Stackit.ContainerApplications.Application("Worker", {
 *   environmentId: environment.environmentId,
 *   image: "ghcr.io/my-org/worker:v1.0.0",
 *   scaling: {
 *     type: "auto",
 *     maxInstances: 3,
 *     rules: [
 *       {
 *         name: "jobs",
 *         custom: {
 *           type: "rabbitmq",
 *           parameters: { queueName: "jobs", mode: "QueueLength", value: "10" },
 *           secrets: { host: secret.key },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Auditing Secrets at runtime
 * **Example:** List who uses which secret, with the values kept `Redacted`
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Apps = Stackit.ContainerApplications.Environment("Apps", {});
 *
 * export default class Audit extends Cloudflare.Worker<Audit>()(
 *   "Audit",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const apps = yield* Apps;
 *     const listSecrets = yield* Stackit.ContainerApplications.ListEnvironmentSecrets(apps);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { secrets } = yield* listSecrets();
 *         return yield* HttpServerResponse.json(
 *           secrets.map(({ key, status }) => ({ key, consumers: status?.consumers ?? [] })),
 *         );
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ContainerApplications.ListEnvironmentSecretsHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Container Applications
 * @category Container Applications
 */
export const EnvironmentSecret = Resource<EnvironmentSecret>(
  "Stackit.ContainerApplications.EnvironmentSecret",
);

/** Something other than this stack still uses the secret. */
export class EnvironmentSecretInUse extends Data.TaggedError(
  "Stackit.ContainerApplications.EnvironmentSecretInUse",
)<{
  readonly key: string;
  readonly consumers: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** The key is still in the environment after the update meant to remove it. */
export class EnvironmentSecretNotDeleted extends Data.TaggedError(
  "Stackit.ContainerApplications.EnvironmentSecretNotDeleted",
)<{
  readonly key: string;
  readonly message: string;
}> {}

const find = (scope: EnvironmentScope, key: string) =>
  listSecrets(scope).pipe(Effect.map((secrets) => secrets.find((secret) => secret.key === key)));

const toAttrs = (scope: EnvironmentScope, secret: sca.EnvironmentSecret) =>
  ({
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    region: scope.region,
    key: secret.key,
    consumers: (secret.status?.consumers ?? []).map(({ id, displayName, container }) => ({
      id,
      displayName,
      container,
    })),
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  }) satisfies EnvironmentSecretAttributes;

export const EnvironmentSecretProvider = () =>
  Provider.succeed(EnvironmentSecret, {
    stables: ["environmentId", "projectId", "region", "key"],
    // No `list`: there are no labels, so nuke can't tell ours from anyone else's.

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved identity can resolve to where the secret already is, and a key can't
      // exist twice in one environment, so this generation has to go first. That's before any
      // application of this stack lets go of it, so a plan is where to refuse.
      if (
        hasUnresolvedTrigger<EnvironmentSecretProps>(news, [
          "environmentId",
          "key",
          "projectId",
          "region",
        ])
      ) {
        if (olds?.forceDestroy !== true) {
          const secret = yield* find(
            {
              projectId: output.projectId,
              region: output.region,
              environmentId: output.environmentId,
            },
            output.key,
          );
          const consumers = (secret?.status?.consumers ?? []).map(
            (consumer) => consumer.displayName ?? consumer.id ?? "unknown",
          );
          if (consumers.length > 0) {
            return yield* new EnvironmentSecretInUse({
              key: output.key,
              consumers,
              message: `Secret ${output.key} is still used by: ${consumers.join(", ")}. This change deletes the old secret before they let go of it, so nothing was changed. Stop using it in a deploy of its own, or deploy forceDestroy: true on the secret on its own, then make this change.`,
            });
          }
        }
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<EnvironmentSecretProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.environmentId !== output.environmentId ||
        resolved.key !== output.key ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const { projectId, region } = yield* resolveProjectScope(olds, output);
      const environmentId = output?.environmentId ?? olds?.environmentId;
      const key = output?.key ?? olds?.key;
      if (typeof environmentId !== "string" || typeof key !== "string") return undefined;
      const scope = { projectId, region, environmentId };
      const secret = yield* find(scope, key);
      if (secret === undefined) return undefined;
      const attrs = toAttrs(scope, secret);
      if (output !== undefined) return attrs;
      // A key is only unique per environment.
      return previous?.key === key &&
        previous.environmentId === environmentId &&
        previous.projectId === projectId &&
        previous.region === region
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { projectId, region } = yield* resolveProjectScope(news, output);
      const scope = { projectId, region, environmentId: news.environmentId };
      const key = news.key;

      yield* ensureContainerApplicationsEnabled(projectId, region);

      const secret = yield* Effect.gen(function* () {
        // Observe, and write only what differs. A response that hides the value reads as a
        // difference and resends it, which is safe. The body is "the subset of secrets to
        // merge or replace", so this one key is all it holds.
        const observed = yield* find(scope, key);
        if (observed === undefined || secretsDiffer(observed.value, news.value)) {
          yield* sca.updateEnvironmentSecrets({
            ...scope,
            secrets: [{ key, value: news.value }],
          });
        }
        return yield* waitFor({
          resource: `STACKIT Container Applications secret ${key}`,
          read: find(scope, key),
          ready: (found) => found !== undefined,
          timeout: "1 minute",
        });
      }).pipe(withSecretLock(scope));

      return toAttrs(scope, secret!);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const scope = {
        projectId: output.projectId,
        region: output.region,
        environmentId: output.environmentId,
      };
      const key = output.key;
      if (olds?.forceDestroy !== true && force !== true) {
        // Applications of this stack go first. What is left after they settle is someone else's.
        const left = yield* childrenLeftAfterSettling(
          find(scope, key).pipe(Effect.map((secret) => secret?.status?.consumers ?? [])),
        );
        if (left.length > 0) {
          const consumers = left.map(
            (consumer) => consumer.displayName ?? consumer.id ?? "unknown",
          );
          return yield* new EnvironmentSecretInUse({
            key,
            consumers,
            message: `Secret ${key} is still used by: ${consumers.join(", ")}. Stop using it first, or deploy forceDestroy: true on the secret. A secret already being replaced keeps the props it was deployed with, so only stopping its use finishes that replacement.`,
          });
        }
      }
      const stillThere = yield* removeSecretKeys(scope, [key]);
      if (stillThere.length > 0) {
        return yield* new EnvironmentSecretNotDeleted({
          key,
          message: `Secret ${key} is still in environment ${output.environmentId} after the update meant to remove it, and the STACKIT API has no delete. Remove it in the portal, or retain it with Alchemy.RemovalPolicy.retain().`,
        });
      }
    }),
  });
