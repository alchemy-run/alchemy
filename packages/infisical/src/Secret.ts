import * as InfisicalApi from "@distilled.cloud/infisical";
import type { Credentials } from "@distilled.cloud/infisical/Credentials";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Record from "effect/Record";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { Providers } from "./Providers.ts";

/** Properties for one shared row at its reader-visible Infisical key. */
export interface SecretProps {
  /** Project UUID. Changing it replaces the secret. */
  project: string;
  /** Environment slug. Changing it replaces the secret. */
  environment: string;
  /** Folder path. Changing it replaces the secret. @default "/" */
  path?: string;
  /** Exact secret key, without an instance suffix. Changing it replaces the secret. */
  name: string;
  /** Secret value. Updates in place and is never included in output attributes. */
  value: string | Redacted.Redacted<string>;
  /** Secret comment. Updates in place. @default "" */
  comment?: string;
}

/** Output attributes of a shared secret. The value is deliberately omitted. */
export interface SecretAttributes {
  /** Infisical secret ID. */
  id: string;
  /** Project UUID. */
  project: string;
  /** Environment slug. */
  environment: string;
  /** Folder path. */
  path: string;
  /** Exact reader-visible secret key. */
  name: string;
  /** Current secret comment. */
  comment: string;
  /** Current secret version. */
  version: number;
}

export type Secret = Resource<"Infisical.Secret", SecretProps, SecretAttributes, never, Providers>;

/**
 * Writes a shared secret at its exact key in an Infisical environment and
 * folder, so tools reading Infisical can consume values produced by a stack.
 * Creating and updating the shared row never touches personal overrides.
 * Deleting it also deletes every personal override of the same key in that
 * folder and environment, as Infisical's shared-secret deletion does.
 * The deployment identity needs permission to read values and metadata and
 * to create, update, and delete shared secrets in the target folder.
 *
 * Changing project, environment, path, or name replaces the row. Value and
 * comment changes update it in place. Values stay in props and are never
 * returned in attributes. Existing rows without this stack's ownership
 * metadata require adoption; adoption preserves unrelated metadata.
 *
 * ### Publishing a Stack Value
 * **Example:** Write an ingest token for tools that read Infisical
 * ```typescript
 * import * as Infisical from "@alchemy.run/infisical";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 *
 * const secret = Effect.gen(function* () {
 *   return yield* Infisical.Secret("IngestToken", {
 *     project: "00000000-0000-4000-8000-000000000000",
 *     environment: "dev",
 *     path: "/observability",
 *     name: "INGEST_TOKEN",
 *     value: Redacted.make("token-produced-by-the-stack"),
 *   });
 * });
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Infisical.Secret");

/** The secret declaration is invalid, requires approval, or cannot be reconciled. */
export class SecretError extends Data.TaggedError("SecretError")<{
  readonly message: string;
}> {}

const SecretPropsSchema = Schema.Struct({
  project: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  path: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("/"))),
  name: Schema.NonEmptyString,
  value: Schema.Union([Schema.Redacted(Schema.String), Schema.RedactedFromValue(Schema.String)]),
  comment: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});

const identity = (
  props: Pick<typeof SecretPropsSchema.Type, "project" | "environment" | "path" | "name">,
) => ({
  projectId: props.project,
  environment: props.environment,
  secretPath: props.path,
  secretName: props.name,
  type: "shared",
});

const metadataRecord = (secret: InfisicalApi.GetSecretByNameV4ResponseSecret) =>
  Record.fromIterableWith(secret.secretMetadata ?? [], ({ key, value }) => [key, value]);

const instanceTag = "alchemy::instance";

const attributes = (secret: InfisicalApi.GetSecretByNameV4ResponseSecret): SecretAttributes => ({
  id: secret.id,
  project: secret.workspace,
  environment: secret.environment,
  path: secret.secretPath,
  name: Redacted.isRedacted(secret.secretKey) ? Redacted.value(secret.secretKey) : secret.secretKey,
  comment: secret.secretComment,
  version: secret.version,
});

export const SecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      const api = Effect.provideContext(
        yield* Effect.context<Credentials | HttpClient.HttpClient>(),
      );
      const error = (name: string, action: string) =>
        new SecretError({ message: `Infisical secret ${name}: ${action}` });
      const operation = <A, E>(effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
        effect.pipe(InfisicalApi.Retry.none, api);
      const applied =
        (name: string, action: string) =>
        (
          response:
            | InfisicalApi.CreateSecretV4Response
            | InfisicalApi.UpdateSecretV4Response
            | InfisicalApi.DeleteSecretV4Response,
        ) =>
          "approval" in response
            ? Effect.fail(
                error(
                  name,
                  `${action} requires approval ${response.approval.id}; approve it in Infisical and deploy again`,
                ),
              )
            : Effect.void;
      const decode = (props: SecretProps) =>
        Schema.decodeEffect(SecretPropsSchema)(props).pipe(
          Effect.mapError(() => error(props.name, "invalid declaration")),
        );
      const get = (props: Parameters<typeof identity>[0]) =>
        InfisicalApi.getSecretByNameV4({
          ...identity(props),
          viewSecretValue: true,
          expandSecretReferences: false,
          includeImports: false,
        }).pipe(
          Effect.map(({ secret }) => secret),
          Effect.catchTag("NotFound", () => Effect.undefined),
          operation,
        );
      const checkOwnership = Effect.fnUntraced(function* (
        id: string,
        live: InfisicalApi.GetSecretByNameV4ResponseSecret,
        output: SecretAttributes | undefined,
      ) {
        const owned = yield* hasAlchemyTags(id, metadataRecord(live));
        if (output && live.id !== output.id && !owned) {
          return yield* error(
            output.name,
            `shared row ${live.id} is not owned by this stack; ` +
              "delete it, or remove this resource with alchemy state rm " +
              "and deploy with --adopt to adopt it",
          );
        }
        return owned;
      });

      return {
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const live = yield* get(output ?? (yield* decode(olds)));
          if (!live) return undefined;
          const owned = yield* checkOwnership(id, live, output);
          const attrs = attributes(live);
          return owned ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, instanceId, news, output }) {
          if (!output) return undefined;
          const path = "path" in news ? news.path : "/";
          if (
            !("project" in news) ||
            !isResolved(news.project) ||
            news.project !== output.project ||
            !("environment" in news) ||
            !isResolved(news.environment) ||
            news.environment !== output.environment ||
            !isResolved(path) ||
            (path ?? "/") !== output.path ||
            !("name" in news) ||
            !isResolved(news.name) ||
            news.name !== output.name
          ) {
            return { action: "replace" } as const;
          }
          if (!isResolved<SecretProps>(news)) return { action: "update" } as const;
          const props = yield* decode(news);
          const live = yield* get(props);
          return !live ||
            live.secretValueHidden ||
            live.secretValue !== Redacted.value(props.value) ||
            live.secretComment !== props.comment ||
            metadataRecord(live)[instanceTag] !== instanceId ||
            !(yield* hasAlchemyTags(id, metadataRecord(live)))
            ? ({ action: "update" } as const)
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const props = yield* decode(news);
          const live = yield* get(props);
          const ownedByStack = live ? yield* checkOwnership(id, live, output) : false;
          const value = Redacted.value(props.value);
          const tags = {
            ...(yield* createInternalTags(id)),
            [instanceTag]: instanceId,
          };
          const secretMetadata = Object.entries(tags).map(([key, value]) => ({ key, value }));
          if (!live) {
            yield* InfisicalApi.createSecretV4({
              ...identity(props),
              secretValue: value,
              secretComment: props.comment,
              secretMetadata,
            }).pipe(Effect.flatMap(applied(props.name, "create")), operation);
          } else {
            const valueChanged = live.secretValueHidden || live.secretValue !== value;
            const commentChanged = live.secretComment !== props.comment;
            const owned = ownedByStack && metadataRecord(live)[instanceTag] === instanceId;
            if (valueChanged || commentChanged || !owned) {
              yield* InfisicalApi.updateSecretV4({
                ...identity(props),
                ...(valueChanged ? { secretValue: value } : {}),
                ...(commentChanged ? { secretComment: props.comment } : {}),
                ...(!owned
                  ? {
                      secretMetadata: [
                        ...(live.secretMetadata ?? []).filter(({ key }) => !(key in tags)),
                        ...secretMetadata,
                      ],
                    }
                  : {}),
              }).pipe(Effect.flatMap(applied(props.name, "update")), operation);
            }
          }
          const updated = yield* get(props);
          if (
            !updated ||
            updated.secretValueHidden ||
            updated.secretValue !== value ||
            updated.secretComment !== props.comment ||
            metadataRecord(updated)[instanceTag] !== instanceId ||
            !(yield* hasAlchemyTags(id, metadataRecord(updated)))
          ) {
            return yield* error(
              props.name,
              "did not converge to its declared value, comment and ownership tags",
            );
          }
          return attributes(updated);
        }),
        delete: Effect.fn(function* ({ instanceId, output }) {
          const live = yield* get(output);
          if (!live || metadataRecord(live)[instanceTag] !== instanceId) return;
          yield* InfisicalApi.deleteSecretV4(identity(output)).pipe(
            Effect.flatMap(applied(output.name, "delete")),
            Effect.catchTag("NotFound", () => Effect.void),
            operation,
          );
        }),
      };
    }),
  );
