import { createHash } from "node:crypto";
import { Services } from "@distilled.cloud/fly-io";
import type { AppSecret } from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { App, listOwnedApps } from "./App.ts";
import { createFlyVolumeName, matchesAlchemyPhysicalName } from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * A resource-valued prop: the resource itself, or an Effect that produces
 * it (so `yield* App(...)` and `App(...)` both type-check).
 */
type Ref<T> = T | Effect.Effect<T, never, Providers>;

export interface SecretProps {
  /**
   * Parent Fly App. Changing it replaces the secret.
   */
  app: Ref<App>;
  /**
   * Secret name. Used as the Machine env-var name when set by the user
   * (case-sensitive, stored as-is). If omitted, a unique name is generated
   * from the stack, stage and logical ID (the ownership stamp). Changing
   * it replaces the secret.
   */
  name?: string;
  /**
   * Secret value. Wrap with `Redacted.make(...)` so it is never logged.
   * Updated in place via `secretsUpdate`. Never persisted in attributes.
   */
  value: Redacted.Redacted<string> | string;
}

export type Secret = Resource<
  "Fly.Secret",
  SecretProps,
  {
    /** Parent Fly App name. */
    appName: string;
    /** Secret name (unique per App). */
    name: string;
    /** Fly digest of the current value. Not the plaintext. */
    digest: string | undefined;
    /** RFC3339 creation timestamp. */
    createdAt: string | undefined;
    /** RFC3339 last-update timestamp. */
    updatedAt: string | undefined;
  },
  never,
  Providers
>;

const resolveSecretProps = (
  props: SecretProps | Effect.Effect<SecretProps, never, Providers>,
): Effect.Effect<SecretProps, never, Providers> =>
  Effect.gen(function* () {
    const resolved = Effect.isEffect(props) ? yield* props : props;
    if (globalThis.__ALCHEMY_RUNTIME__) return resolved;
    const app = Effect.isEffect(resolved.app)
      ? yield* resolved.app as Effect.Effect<App, never, Providers>
      : resolved.app;
    return { ...resolved, app };
  });

const SecretResource = Resource<Secret>("Fly.Secret");

/**
 * A Fly.io App secret. Fly injects app secrets into Machines as
 * environment variables unless `skip_secrets` is set. The resource
 * manages the app-level value; the plaintext is never stored in
 * attributes or logged.
 *
 * @resource
 * @see https://fly.io/docs/apps/secrets/
 *
 * @section Creating a Secret
 * @example Generated name
 * ```typescript
 * const site = yield* Fly.App("Site");
 * const dbUrl = yield* Fly.Secret("DatabaseUrl", {
 *   app: site,
 *   value: Redacted.make("postgres://…"),
 * });
 * ```
 *
 * @example Explicit env-var name
 * ```typescript
 * const apiKey = yield* Fly.Secret("ApiKey", {
 *   app: site,
 *   name: "API_KEY",
 *   value: Redacted.make("sk_live_…"),
 * });
 * ```
 *
 * @section Updating a Secret
 * @example Rotate the value
 * ```typescript
 * const apiKey = yield* Fly.Secret("ApiKey", {
 *   app: site,
 *   name: "API_KEY",
 *   value: Redacted.make("sk_live_rotated"),
 * });
 * ```
 */
export const Secret: typeof SecretResource = Object.assign(
  (
    id: string,
    props: SecretProps | Effect.Effect<SecretProps, never, Providers>,
  ) => SecretResource(id, resolveSecretProps(props)),
  SecretResource,
);

export class SecretNotCreated extends Data.TaggedError("Fly.SecretNotCreated")<{
  appName: string;
  name: string;
}> {}

export class SecretAppRequired extends Data.TaggedError(
  "Fly.SecretAppRequired",
)<{
  message: string;
}> {}

const appNameOf = (value: unknown): string | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as { appName?: unknown };
  return typeof rec.appName === "string" && rec.appName.length > 0
    ? rec.appName
    : undefined;
};

const unwrapSecret = (value: Redacted.Redacted<string> | string): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    // User env-var names are stored as-is (case-sensitive). Generated
    // names use the Volume underscore shape — Fly rejects hyphens.
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createFlyVolumeName(id);
  });

const toAttrs = (
  appName: string,
  secret: AppSecret,
  fallbackName: string,
): Secret["Attributes"] => ({
  appName,
  name: secret.name ?? fallbackName,
  digest: secret.digest,
  createdAt: secret.created_at,
  updatedAt: secret.updated_at,
});

const getByName = (appName: string, secretName: string) =>
  Services.machines
    .secretGet({
      app_name: appName,
      secret_name: secretName,
      show_secrets: false,
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listSecrets = (appName: string) =>
  Services.machines
    .secretsList({
      app_name: appName,
      show_secrets: false,
    })
    .pipe(
      Effect.map((res) => res.secrets ?? []),
      Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
    );

const flyDigestCandidates = (plain: string) =>
  Effect.sync(() => {
    const utf8 = Buffer.from(plain, "utf8");
    return [
      createHash("md5").update(utf8).digest("hex"),
      createHash("sha256").update(utf8).digest("hex"),
    ];
  });

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["appName", "name", "createdAt"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName = news.name !== undefined ? news.name : output.name;
      const nameChanged = desiredName !== output.name;
      const nextApp = appNameOf(news.app);
      const appChanged = nextApp !== undefined && nextApp !== output.appName;
      if (nameChanged || appChanged) {
        return {
          action: "replace" as const,
          // Same (app, name) cannot exist twice — delete the old secret first.
          deleteFirst: nameChanged && !appChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const appName =
        output?.appName ??
        (olds !== undefined ? appNameOf(olds.app) : undefined);
      if (appName === undefined) return undefined;
      const name = yield* resolveName(id, olds?.name, output?.name);
      const found = yield* getByName(appName, name);
      if (found === undefined) return undefined;
      const attrs = toAttrs(appName, found, name);
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const apps = yield* listOwnedApps();
      const rows = yield* Effect.forEach(
        apps,
        (app) =>
          listSecrets(app.appName).pipe(
            Effect.map((secrets) =>
              secrets.flatMap((secret) => {
                const name = secret.name;
                if (!matchesAlchemyPhysicalName(name)) return [];
                return [toAttrs(app.appName, secret, name ?? "")];
              }),
            ),
          ),
        { concurrency: 8 },
      );
      return rows.flat();
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const props = news ?? ({} as SecretProps);
      const appName = appNameOf(props.app) ?? output?.appName;
      if (appName === undefined) {
        return yield* new SecretAppRequired({
          message: "Secret requires a resolved Fly.App",
        });
      }
      const name = yield* resolveName(id, props.name, output?.name);
      const desiredPlain = unwrapSecret(props.value);

      // Observe by cached identity, then the desired (app, name).
      let current =
        output !== undefined
          ? yield* getByName(output.appName, output.name)
          : undefined;
      if (
        current === undefined &&
        (output === undefined ||
          output.appName !== appName ||
          output.name !== name)
      ) {
        current = yield* getByName(appName, name);
      }

      let createdThisRun = false;
      if (current === undefined) {
        yield* Services.machines
          .secretCreate({
            app_name: appName,
            secret_name: name,
            value: desiredPlain,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
        current = yield* getByName(appName, name);
        createdThisRun = true;
      }

      if (current === undefined) {
        return yield* new SecretNotCreated({ appName, name });
      }

      // Sync — skip if we just created. Prefer observed digest vs hash of
      // desired; otherwise re-put when olds is absent (adoption) or the
      // previous value differs. Never log the plaintext.
      if (!createdThisRun) {
        const candidates = yield* flyDigestCandidates(desiredPlain);
        const digestMatches =
          current.digest !== undefined && candidates.includes(current.digest);
        const previousPlain =
          olds?.value !== undefined ? unwrapSecret(olds.value) : undefined;
        const valueChanged =
          previousPlain === undefined || previousPlain !== desiredPlain;
        if (!digestMatches && valueChanged) {
          yield* Services.machines
            .secretsUpdate({
              app_name: appName,
              values: { [name]: desiredPlain },
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.void));
          current = (yield* getByName(appName, name)) ?? current;
        }
      }

      return toAttrs(appName, current, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.appName.length === 0 || output.name.length === 0) return;
      yield* Services.machines
        .secretDelete({
          app_name: output.appName,
          secret_name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getByName(output.appName, output.name).pipe(
        Effect.map((secret) => secret === undefined),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (gone) => gone,
          times: 8,
        }),
      );
    }),
  });
