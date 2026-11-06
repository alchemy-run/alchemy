import * as infisical from "@distilled.cloud/infisical";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "./Providers.ts";

export interface SecretProps {
  /** Project UUID. Changing it replaces the secret. */
  project: string;
  /** Environment slug. Changing it replaces the secret. */
  environment: string;
  /** Folder path. Changing it replaces the secret. @default "/" */
  path?: string;
  /** Secret key, used exactly as given. Changing it replaces the secret. */
  name: string;
  /** Secret value. Never included in attributes. */
  value: string | Redacted.Redacted<string>;
  /** Secret comment. @default "" */
  comment?: string;
}

export interface SecretAttributes {
  /** Infisical secret ID. */
  id: string;
  /** Project UUID. */
  project: string;
  /** Environment slug. */
  environment: string;
  /** Folder path. */
  path: string;
  /** Secret key. */
  name: string;
  /** Secret comment. */
  comment: string;
  /** Secret version. */
  version: number;
}

export type Secret = Resource<"Infisical.Secret", SecretProps, SecretAttributes, never, Providers>;

/**
 * A shared secret at an exact key in an Infisical environment and folder, so
 * tools that read Infisical can consume a value a stack produces. Writing the
 * shared row never touches personal overrides; deleting it also deletes every
 * personal override of the same key there, as deleting a shared secret in
 * Infisical does.
 *
 * Changing project, environment, path or name replaces the secret; value and
 * comment update in place. A row this stack didn't make needs `--adopt`.
 *
 * ### Publishing a Stack Value
 * **Example:** An ingest token for tools that read Infisical
 * ```typescript
 * const secret = yield* Infisical.Secret("IngestToken", {
 *   project: "00000000-0000-4000-8000-000000000000",
 *   environment: "dev",
 *   path: "/observability",
 *   name: "INGEST_TOKEN",
 *   value: token.value,
 * });
 * ```
 *
 * @resource
 */
export const Secret = Resource<Secret>("Infisical.Secret");

/** A write is waiting on approval, or the row at the key isn't this stack's. */
export class SecretError extends Data.TaggedError("SecretError")<{
  readonly message: string;
}> {}

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    list: () => Effect.succeed([]),
    read: Effect.fn(function* ({ id, olds, output }) {
      const key = output ?? keyOf(olds);
      const live = yield* getSecret(key);
      if (!live) return undefined;
      yield* refuseReplacedRow(id, live, output);
      const attrs = attributes(key, live);
      return (yield* hasAlchemyTags(id, metadataOf(live))) ? attrs : Unowned(attrs);
    }),
    diff: Effect.fn(function* ({ id, instanceId, news, output }) {
      if (!output) return undefined;
      const path = "path" in news ? news.path : undefined;
      if (
        !("project" in news) ||
        !("environment" in news) ||
        !("name" in news) ||
        !isResolved(news.project) ||
        !isResolved(news.environment) ||
        !isResolved(path) ||
        !isResolved(news.name) ||
        news.project !== output.project ||
        news.environment !== output.environment ||
        (path ?? "/") !== output.path ||
        news.name !== output.name
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved<SecretProps>(news)) return { action: "update" } as const;
      const live = yield* getSecret(output);
      return live && (yield* current(id, instanceId, live, news))
        ? undefined
        : ({ action: "update" } as const);
    }),
    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const key = keyOf(news);
      const value = valueOf(news);
      const comment = news.comment ?? "";
      const live = yield* getSecret(key);
      if (live) yield* refuseReplacedRow(id, live, output);
      const tags = { ...(yield* createInternalTags(id)), [instanceTag]: instanceId };
      const secretMetadata = Object.entries(tags).map(([key, value]) => ({ key, value }));
      if (!live) {
        const created = yield* infisical.createSecretV4({
          ...request(key),
          secretValue: value,
          secretComment: comment,
          secretMetadata,
        });
        return attributes(key, yield* applied(key, "create", created));
      }
      if (yield* current(id, instanceId, live, news)) return attributes(key, live);
      const updated = yield* infisical.updateSecretV4({
        ...request(key),
        secretValue: value,
        secretComment: comment,
        // Keep metadata others set on the row; replace only this stack's tags.
        secretMetadata: [
          ...(live.secretMetadata ?? []).filter(({ key }) => !(key in tags)),
          ...secretMetadata,
        ],
      });
      return attributes(key, yield* applied(key, "update", updated));
    }),
    delete: Effect.fn(function* ({ instanceId, output }) {
      // A replacement at the same key now owns the row: leave it.
      const live = yield* getSecret(output);
      if (!live || metadataOf(live)[instanceTag] !== instanceId) return;
      const deleted = yield* infisical
        .deleteSecretV4(request(output))
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (deleted) yield* applied(output, "delete", deleted);
    }),
  });

interface Key {
  readonly project: string;
  readonly environment: string;
  readonly path?: string;
  readonly name: string;
}

/** Marks which resource instance wrote the row, so a replacement keeps it. */
const instanceTag = "alchemy::instance";

const keyOf = (props: SecretProps): Key => ({
  project: props.project,
  environment: props.environment,
  path: props.path ?? "/",
  name: props.name,
});

const valueOf = (props: SecretProps) =>
  typeof props.value === "string" ? props.value : Redacted.value(props.value);

const request = (key: Key) => ({
  projectId: key.project,
  environment: key.environment,
  secretPath: key.path ?? "/",
  secretName: key.name,
  type: "shared" as const,
});

const getSecret = (key: Key) =>
  infisical
    .getSecretByNameV4({
      ...request(key),
      viewSecretValue: true,
      expandSecretReferences: false,
      includeImports: false,
    })
    .pipe(
      Effect.map(({ secret }) => secret),
      Effect.catchTag("NotFound", () => Effect.undefined),
    );

const metadataOf = (secret: {
  readonly secretMetadata?: ReadonlyArray<{ key: string; value?: string }>;
}) => Object.fromEntries((secret.secretMetadata ?? []).map(({ key, value }) => [key, value]));

/**
 * A row at the key that replaced this stack's by hand is not taken over: the
 * stack's own row was deleted, and someone else made this one.
 */
const refuseReplacedRow = Effect.fnUntraced(function* (
  id: string,
  live: infisical.GetSecretByNameV4ResponseSecret,
  output: SecretAttributes | undefined,
) {
  if (!output || live.id === output.id || (yield* hasAlchemyTags(id, metadataOf(live)))) return;
  return yield* new SecretError({
    message:
      `Infisical secret ${output.name}: shared row ${live.id} was not made by this stack. ` +
      `Delete it, or run alchemy state rm for this resource and deploy with --adopt.`,
  });
});

/** The live row holds the declared value and comment, under this instance's tags. */
const current = Effect.fnUntraced(function* (
  id: string,
  instanceId: string,
  live: infisical.GetSecretByNameV4ResponseSecret,
  props: SecretProps,
) {
  return (
    !live.secretValueHidden &&
    live.secretValue === valueOf(props) &&
    live.secretComment === (props.comment ?? "") &&
    metadataOf(live)[instanceTag] === instanceId &&
    (yield* hasAlchemyTags(id, metadataOf(live)))
  );
});

/** Under a change policy, Infisical answers a write with an approval request instead of applying it. */
const applied = <A>(
  key: Key,
  action: string,
  response: { readonly secret: A } | { readonly approval: { readonly id: string } },
) =>
  "approval" in response
    ? Effect.fail(
        new SecretError({
          message: `Infisical secret ${key.name}: the ${action} waits on approval ${response.approval.id}; approve it in Infisical and deploy again.`,
        }),
      )
    : Effect.succeed(response.secret);

const attributes = (
  key: Key,
  secret: { readonly id: string; readonly secretComment: string; readonly version: number },
): SecretAttributes => ({
  id: secret.id,
  project: key.project,
  environment: key.environment,
  path: key.path ?? "/",
  name: key.name,
  comment: secret.secretComment,
  version: secret.version,
});
