import { Services } from "@distilled.cloud/fly-io";
import type { App as FlyApp } from "@distilled.cloud/fly-io/machines";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { resolveOrgSlug } from "./Environment.ts";
import {
  createFlyAppName,
  isAlchemyOwnedMetadata,
  matchesAlchemyPhysicalName,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

export interface AppProps {
  /**
   * Fly App name. Globally unique, DNS-compatible (lowercase letters,
   * digits, hyphens), must start with a letter, max 30 characters. If
   * omitted, a unique name is generated from the stack, stage and logical
   * ID. Changing it replaces the App.
   */
  name?: string;
  /**
   * Organization slug. Defaults to the current token's org
   * (`currentTokenShow`). Changing it replaces the App.
   */
  orgSlug?: string;
  /**
   * Isolated network name. Immutable after create — changing it replaces
   * the App.
   */
  network?: string;
  /**
   * Enable `*.{name}.fly.dev` subdomains. Create-only; ignored on update
   * (Fly has no App update API).
   */
  enableSubdomains?: boolean;
}

export type App = Resource<
  "Fly.App",
  AppProps,
  {
    /** Fly App id. */
    appId: string;
    /** Physical Fly App name. */
    appName: string;
    /** Fly internal numeric id, if the API returned one. */
    internalNumericId: number | undefined;
    /** Isolated network name, if set. */
    network: string | undefined;
    /** Observed status (e.g. `deployed`, `pending`). */
    status: string | undefined;
    /** Organization slug. */
    orgSlug: string | undefined;
    /** Observed machine count. */
    machineCount: number | undefined;
    /** Observed volume count. */
    volumeCount: number | undefined;
    /** Public `https://{appName}.fly.dev` URL. */
    url: string;
  },
  never,
  Providers
>;

/**
 * A Fly.App is a global namespace in your account. It contains Machines,
 * Services, Secrets, IPs, and certificates.
 *
 * @resource
 * @see https://fly.io/docs/machines/api/apps-resource/
 *
 * @section Create an App
 * Alchemy generates a unique name unless you pass one. `url` is
 * `https://{appName}.fly.dev`. Nothing answers there until a
 * {@link Service} or {@link Machine} publishes a proxy service and the App
 * has an {@link IpAssignment}.
 *
 * @example Generated name
 * ```typescript
 * const site = yield* Fly.App("Site");
 * ```
 *
 * :::note
 * Prefer omitting `name` in tests and CI so names stay unique and
 * reclaimable.
 * :::
 *
 * @section A stable hostname
 * Pass `name` when you need a stable `fly.dev` hostname.
 *
 * @example Explicit name
 * ```typescript
 * const site = yield* Fly.App("Site", {
 *   name: "my-site",
 * });
 * ```
 *
 * :::caution[Changing `name` replaces the App]
 * Fly cannot have two Apps with the same name. Alchemy deletes the
 * old App first, then creates the new one.
 * :::
 *
 * @section Organization
 * Org defaults to the current token. Pass `orgSlug` to pin it.
 *
 * @example Pin an org
 * ```typescript
 * const site = yield* Fly.App("Site", {
 *   name: "my-site",
 *   orgSlug: "my-org",
 * });
 * ```
 *
 * :::caution[Changing `orgSlug` replaces the App]
 * The App is created in the new org. The old App is deleted.
 * :::
 *
 * @section Subdomains
 * `enableSubdomains: true` turns on `*.{appName}.fly.dev`.
 *
 * @example Enable subdomains
 * ```typescript
 * const site = yield* Fly.App("Site", {
 *   name: "my-site",
 *   enableSubdomains: true,
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `enableSubdomains` later is ignored.
 * :::
 *
 * @section Isolated network
 * `network` is an optional 6PN name.
 *
 * @example Custom network
 * ```typescript
 * const site = yield* Fly.App("Site", {
 *   name: "my-site",
 *   network: "private",
 * });
 * ```
 *
 * :::caution[Changing `network` replaces the App]
 * The App is recreated on the new network.
 * :::
 *
 * @section Module-scope declarations
 * Declare the App once. Pass it into every child. Resource-valued props
 * accept the resource or an Effect producing it. Do not unwrap it just
 * to pass it along.
 *
 * @example Module-scope App
 * ```typescript
 * // src/app.ts
 * import * as Fly from "alchemy/Fly";
 *
 * export const Site = Fly.App("Site");
 * ```
 */
export const App = Resource<App>("Fly.App");

export class AppNotCreated extends Data.TaggedError("Fly.AppNotCreated")<{
  name: string;
}> {}

const toAttrs = (app: FlyApp, fallbackName?: string): App["Attributes"] => {
  const appName = app.name ?? fallbackName ?? "";
  return {
    appId: app.id ?? appName,
    appName,
    internalNumericId: app.internal_numeric_id,
    network: app.network,
    status: app.status,
    orgSlug: app.organization?.slug,
    machineCount: app.machine_count,
    volumeCount: app.volume_count,
    url: `https://${appName}.fly.dev`,
  };
};

const resolveAppName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyAppName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyAppName(id);
  });

const getByName = (appName: string) =>
  Services.machines
    .appsShow({ app_name: appName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const hasAlchemyMachines = (appName: string) =>
  Services.machines.machinesList({ app_name: appName }).pipe(
    Effect.map((machines) =>
      machines.some((machine) =>
        isAlchemyOwnedMetadata(machine.config?.metadata),
      ),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(false)),
  );

const hasAlchemyNamed = (names: Array<string | undefined>) =>
  names.some((name) => matchesAlchemyPhysicalName(name));

const hasAlchemyVolumes = (appName: string) =>
  Services.machines.volumesList({ app_name: appName }).pipe(
    Effect.map((volumes) =>
      hasAlchemyNamed(volumes.map((volume) => volume.name)),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(false)),
  );

const hasAlchemySecrets = (appName: string) =>
  Services.machines.secretsList({ app_name: appName }).pipe(
    Effect.map((res) =>
      hasAlchemyNamed((res.secrets ?? []).map((secret) => secret.name)),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(false)),
  );

const hasAlchemySecretKeys = (appName: string) =>
  Services.machines.secretkeysList({ app_name: appName }).pipe(
    Effect.map((res) =>
      hasAlchemyNamed((res.secret_keys ?? []).map((key) => key.name)),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(false)),
  );

const isOwnedApp = (app: FlyApp) =>
  Effect.gen(function* () {
    if (matchesAlchemyPhysicalName(app.name)) return true;
    const appName = app.name;
    if (appName === undefined || appName.length === 0) return false;
    const flags = yield* Effect.all(
      [
        hasAlchemyMachines(appName),
        hasAlchemyVolumes(appName),
        hasAlchemySecrets(appName),
        hasAlchemySecretKeys(appName),
      ],
      { concurrency: 4 },
    );
    return flags.some(Boolean);
  });

/**
 * Apps in the current token's org that Alchemy owns. Used by {@link App}
 * `list()` and by child resources (Machine / Volume / Secret) so nuke
 * never enumerates the whole org unfiltered.
 */
export const listOwnedApps = Effect.fn(function* () {
  const orgSlug = yield* resolveOrgSlug();
  const { apps } = yield* Services.machines.appsList({
    org_slug: orgSlug,
  });
  const flagged = yield* Effect.forEach(
    apps ?? [],
    (app) =>
      isOwnedApp(app).pipe(
        Effect.map((owned) => (owned ? toAttrs(app) : undefined)),
      ),
    { concurrency: 8 },
  );
  return flagged.filter((attrs) => attrs !== undefined);
});

export const AppProvider = () =>
  Provider.succeed(App, {
    stables: ["appId", "appName", "orgSlug", "network", "internalNumericId"],

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName =
        news.name !== undefined
          ? sanitizeFlyAppName(news.name)
          : output.appName;
      const nameChanged = desiredName !== output.appName;
      const orgChanged =
        news.orgSlug !== undefined && news.orgSlug !== output.orgSlug;
      const networkChanged =
        news.network !== undefined && news.network !== output.network;
      if (nameChanged || orgChanged || networkChanged) {
        return {
          action: "replace" as const,
          // Same physical name cannot exist twice — delete the old App first.
          deleteFirst: !nameChanged,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* resolveAppName(id, olds?.name, output?.appName);
      const found =
        (output?.appName !== undefined
          ? yield* getByName(output.appName)
          : undefined) ?? (yield* getByName(name));
      if (found === undefined) return undefined;
      const attrs = toAttrs(found, name);
      if (output !== undefined) return attrs;
      return (yield* isOwnedApp(found)) ? attrs : Unowned(attrs);
    }),

    list: listOwnedApps,

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? {};
      const name = yield* resolveAppName(id, props.name, output?.appName);
      const orgSlug = props.orgSlug ?? (yield* resolveOrgSlug());

      // Observe by the cached name, then the desired name.
      let current =
        output?.appName !== undefined
          ? yield* getByName(output.appName)
          : undefined;
      if (current === undefined && output?.appName !== name) {
        current = yield* getByName(name);
      }

      if (current === undefined) {
        yield* Services.machines
          .appsCreate({
            name,
            org_slug: orgSlug,
            network: props.network,
            enable_subdomains: props.enableSubdomains,
          })
          .pipe(
            Effect.catchTag(
              ["Conflict", "UnprocessableEntity"],
              () => Effect.void,
            ),
          );
        current = yield* getByName(name);
      }

      if (current === undefined) {
        return yield* new AppNotCreated({ name });
      }

      // No update API. enableSubdomains is create-only.
      return toAttrs(current, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      const appName = output.appName;
      if (appName.length === 0) return;
      const volumes = yield* Services.machines
        .volumesList({ app_name: appName })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])),
        );
      yield* Effect.forEach(
        volumes,
        (volume) => {
          const volumeId = volume.id;
          if (
            volumeId === undefined ||
            volumeId.length === 0 ||
            !matchesAlchemyPhysicalName(volume.name)
          ) {
            return Effect.void;
          }
          return Services.machines
            .volumeDelete({ app_name: appName, volume_id: volumeId })
            .pipe(
              Effect.asVoid,
              Effect.catchTag(["NotFound", "Conflict"], () => Effect.void),
            );
        },
        { concurrency: 4 },
      );
      yield* Services.machines
        .appsDelete({ app_name: appName })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* getByName(appName).pipe(
        Effect.map((app) => app === undefined),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (gone) => gone,
          times: 8,
        }),
      );
    }),
  });
