import * as Coolify from "@distilled.cloud/coolify";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { hashOf } from "./internal/hash.ts";
import type { Providers } from "./Providers.ts";

export interface EnvVarProps {
  /**
   * UUID of the application that gets the variable, usually
   * `app.applicationUuid`. Set exactly one of `application`, `database` or
   * `service`; changing the target replaces the variable.
   */
  application?: string;
  /** UUID of the database that gets the variable, e.g. `db.databaseUuid`. */
  database?: string;
  /** UUID of the Docker Compose service that gets the variable. */
  service?: string;
  /** Variable name. Changing it replaces the variable. */
  key: string;
  /**
   * Variable value. Wrap secrets in `Redacted.make(...)` so they are never
   * logged; only a hash of the value is stored in state.
   */
  value: string | Redacted.Redacted<string>;
  /**
   * Set the variable on preview deployments instead of the main one.
   * Changing it replaces the variable.
   * @default false
   */
  preview?: boolean;
  /** Use the value as-is, without Coolify's `${VAR}` interpolation. */
  literal?: boolean;
  /** The value spans several lines, e.g. a PEM key. */
  multiline?: boolean;
  /**
   * Hide the value in the dashboard and API after it is saved. Permanent:
   * Coolify never shows the value again, though a new value still replaces it.
   */
  shownOnce?: boolean;
}

export type EnvVar = Resource<
  "Coolify.EnvVar",
  EnvVarProps,
  {
    /** Environment variable UUID. */
    envVarUuid: string;
    /** What the variable is attached to. */
    targetKind: "application" | "database" | "service";
    /** UUID of the application, database or service. */
    targetUuid: string;
    /** Variable name. */
    key: string;
    /** Whether it applies to preview deployments. */
    preview: boolean;
    /** sha256 of the value and flags. Not the value. */
    digest: string;
  },
  never,
  Providers
>;

/**
 * One environment variable on a Coolify application, database or Docker
 * Compose service.
 *
 * Use `EnvVar` for variables managed apart from the resource, such as a
 * secret another team rotates, or variables on a database or service.
 * Variables an application needs on its first deploy belong in the
 * application's `env` prop: an `EnvVar` is written after the application
 * exists, so it takes effect on the next deploy or restart.
 *
 * @see https://coolify.io/docs/knowledge-base/environment-variables
 *
 * ### Creating a Variable
 * **Example:** A secret on an application
 * ```typescript
 * yield* Coolify.EnvVar("stripe-key", {
 *   application: api.applicationUuid,
 *   key: "STRIPE_SECRET_KEY",
 *   value: yield* Config.Redacted("STRIPE_SECRET_KEY"),
 *   shownOnce: true,
 * });
 * ```
 *
 * **Example:** A variable for preview deployments only
 * ```typescript
 * yield* Coolify.EnvVar("preview-api-url", {
 *   application: web.applicationUuid,
 *   key: "API_URL",
 *   value: "https://staging-api.example.com",
 *   preview: true,
 * });
 * ```
 *
 * ### Database and service variables
 * **Example:** A variable on a database container
 * ```typescript
 * yield* Coolify.EnvVar("pg-tz", {
 *   database: db.databaseUuid,
 *   key: "TZ",
 *   value: "Europe/Brussels",
 * });
 * ```
 *
 * @resource
 * @product EnvVar
 */
export const EnvVar = Resource<EnvVar>("Coolify.EnvVar");

/** The props name no target, or more than one. */
export class EnvVarTargetInvalid extends Data.TaggedError("Coolify.EnvVarTargetInvalid")<{
  readonly message: string;
}> {}

/** Coolify accepted the variable but did not return it. */
export class EnvVarNotCreated extends Data.TaggedError("Coolify.EnvVarNotCreated")<{
  readonly message: string;
}> {}

type Kind = EnvVar["Attributes"]["targetKind"];

const targetOf = (props: EnvVarProps) =>
  Effect.gen(function* () {
    const targets = [
      ["application", props.application],
      ["database", props.database],
      ["service", props.service],
    ].filter((entry): entry is [Kind, string] => entry[1] !== undefined);
    if (targets.length !== 1) {
      return yield* new EnvVarTargetInvalid({
        message: "Coolify.EnvVar needs exactly one of `application`, `database` or `service`",
      });
    }
    const [kind, uuid] = targets[0];
    return { kind, uuid };
  });

const unwrap = (value: string | Redacted.Redacted<string> | null | undefined) =>
  value == null ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const digestOf = (props: EnvVarProps) =>
  hashOf({
    value: props.value,
    literal: props.literal ?? false,
    multiline: props.multiline ?? false,
    shownOnce: props.shownOnce ?? false,
  });

export const EnvVarProvider = () =>
  Provider.effect(
    EnvVar,
    Effect.gen(function* () {
      const listApp = yield* Coolify.listEnvsByApplicationUuid;
      const listDb = yield* Coolify.listEnvsByDatabaseUuid;
      const listSvc = yield* Coolify.listEnvsByServiceUuid;
      const createApp = yield* Coolify.createEnvByApplicationUuid;
      const createDb = yield* Coolify.createEnvByDatabaseUuid;
      const createSvc = yield* Coolify.createEnvByServiceUuid;
      const updateApp = yield* Coolify.updateEnvByApplicationUuid;
      const updateDb = yield* Coolify.updateEnvByDatabaseUuid;
      const updateSvc = yield* Coolify.updateEnvByServiceUuid;
      const deleteApp = yield* Coolify.deleteEnvByApplicationUuid;
      const deleteDb = yield* Coolify.deleteEnvByDatabaseUuid;
      const deleteSvc = yield* Coolify.deleteEnvByServiceUuid;

      const none = () => Effect.succeed([] as ReadonlyArray<Coolify.EnvironmentVariable>);
      const list = (kind: Kind, uuid: string) =>
        kind === "application"
          ? listApp({ uuid }).pipe(Effect.catchTag("NotFound", none))
          : kind === "database"
            ? listDb({ uuid }).pipe(Effect.catchTag("NotFound", none))
            : listSvc({ uuid }).pipe(Effect.catchTag("NotFound", none));

      const find = (
        kind: Kind,
        uuid: string,
        match: { uuid?: string; key: string; preview: boolean },
      ) =>
        list(kind, uuid).pipe(
          Effect.map((envs) =>
            envs.find((env) =>
              match.uuid !== undefined
                ? env.uuid === match.uuid
                : env.key === match.key && (env.is_preview ?? false) === match.preview,
            ),
          ),
        );

      type Write = {
        key: string;
        value: string;
        is_preview: boolean;
        is_literal?: boolean;
        is_multiline?: boolean;
        is_shown_once?: boolean;
      };

      // `true` when created, `false` when the key already existed.
      const create = (kind: Kind, uuid: string, input: Write) => {
        const exists = () => Effect.succeed(false);
        const created = () => true;
        return kind === "application"
          ? createApp({ uuid, ...input }).pipe(
              Effect.map(created),
              Effect.catchTag("EnvironmentVariableAlreadyExists", exists),
            )
          : kind === "database"
            ? createDb({ uuid, ...input }).pipe(
                Effect.map(created),
                Effect.catchTag("EnvironmentVariableAlreadyExists", exists),
              )
            : createSvc({ uuid, ...input }).pipe(
                Effect.map(created),
                Effect.catchTag("EnvironmentVariableAlreadyExists", exists),
              );
      };

      const update = (kind: Kind, uuid: string, input: Write) => {
        if (kind === "application") return updateApp({ uuid, ...input }).pipe(Effect.asVoid);
        // Databases have no preview deployments.
        const { is_preview, ...rest } = input;
        if (kind === "database") return updateDb({ uuid, ...rest }).pipe(Effect.asVoid);
        return updateSvc({ uuid, is_preview, ...rest }).pipe(Effect.asVoid);
      };

      const remove = (kind: Kind, uuid: string, envUuid: string) =>
        kind === "application"
          ? deleteApp({ uuid, env_uuid: envUuid }).pipe(
              Effect.asVoid,
              Effect.catchTag("NotFound", () => Effect.void),
            )
          : kind === "database"
            ? deleteDb({ uuid, env_uuid: envUuid }).pipe(
                Effect.asVoid,
                Effect.catchTag("NotFound", () => Effect.void),
              )
            : deleteSvc({ uuid, env_uuid: envUuid }).pipe(
                Effect.asVoid,
                Effect.catchTag("NotFound", () => Effect.void),
              );

      return {
        stables: ["envVarUuid", "targetKind", "targetUuid", "key", "preview"],
        nuke: { dependsOn: ["Coolify.Application", "Coolify.Database.*"] },

        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const target = yield* targetOf(news);
          if (
            target.kind !== output.targetKind ||
            target.uuid !== output.targetUuid ||
            news.key !== output.key ||
            (news.preview ?? false) !== output.preview
          ) {
            return { action: "replace" } as const;
          }
          if ((yield* digestOf(news)) !== output.digest) return { action: "update" } as const;
          return undefined;
        }),

        read: Effect.fn(function* ({ output }) {
          if (output) {
            const env = yield* find(output.targetKind, output.targetUuid, {
              uuid: output.envVarUuid,
              key: output.key,
              preview: output.preview,
            });
            return env ? output : undefined;
          }
          return undefined;
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          const target = yield* targetOf(news);
          const preview = news.preview ?? false;
          const value = unwrap(news.value) ?? "";
          const digest = yield* digestOf(news);
          const flags = {
            is_preview: preview,
            is_literal: news.literal,
            is_multiline: news.multiline,
            is_shown_once: news.shownOnce,
          };

          // Observe — by key: Coolify keys a variable by name per target.
          let env = yield* find(target.kind, target.uuid, { key: news.key, preview });

          // Ensure — create; a 409 means it exists, so fall through to update.
          if (env === undefined) {
            const created = yield* create(target.kind, target.uuid, {
              key: news.key,
              value,
              ...flags,
            });
            env = yield* find(target.kind, target.uuid, { key: news.key, preview });
            if (env === undefined) {
              return yield* new EnvVarNotCreated({
                message: `Coolify did not return variable ${news.key} on ${target.kind} ${target.uuid}`,
              });
            }
            if (created) {
              return {
                envVarUuid: env.uuid!,
                targetKind: target.kind,
                targetUuid: target.uuid,
                key: news.key,
                preview,
                digest,
              };
            }
          }

          // Sync — value and flags. A withheld value (no read:sensitive, or
          // shownOnce) can't be compared, so the stored digest decides.
          const observedValue = unwrap(env.value);
          const differs =
            (observedValue !== undefined ? observedValue !== value : digest !== output?.digest) ||
            (news.literal !== undefined && env.is_literal !== news.literal) ||
            (news.multiline !== undefined && env.is_multiline !== news.multiline);
          if (differs) {
            yield* update(target.kind, target.uuid, { key: news.key, value, ...flags });
          }

          return {
            envVarUuid: env.uuid!,
            targetKind: target.kind,
            targetUuid: target.uuid,
            key: news.key,
            preview,
            digest,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* remove(output.targetKind, output.targetUuid, output.envVarUuid);
        }),
      };
    }),
  );
