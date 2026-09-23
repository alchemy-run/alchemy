import type { App as FlyApp } from "@distilled.cloud/fly-io/machines";
import * as machines from "@distilled.cloud/fly-io/machines";
import * as Retry from "@distilled.cloud/fly-io/Retry";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
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

export class AppDeletionAmbiguous extends Data.TaggedError(
  "Fly.AppDeletionAmbiguous",
)<{
  appName: string;
  evidence: string;
}> {
  get message() {
    return `Deletion of ${this.appName} is uncertain (${this.evidence}); reconcile the App before retrying or recreating its name. Machine leases cannot fence App deletion.`;
  }
}

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
   * (`getCurrentToken`). Changing it replaces the App.
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
 * Secrets, IPs, and certificates. A {@link Service} creates its own App,
 * so declare an App yourself for {@link Machine}s, or to group Services
 * that share Secrets or a custom domain (the Service `app` prop).
 *
 * @see https://fly.io/docs/machines/api/apps-resource/
 *
 * ### Create an App
 * Alchemy generates a unique name unless you pass one. `url` is
 * `https://{appName}.fly.dev`. Nothing answers there until a
 * {@link Machine} (or a Service with `app`) publishes a proxy service and
 * the App has an {@link IpAssignment}.
 *
 * **Example:** Generated name
 * ```typescript
 * const site = yield* Fly.App("Site");
 * ```
 *
 * :::note
 * Prefer omitting `name` in tests and CI so names stay unique and
 * reclaimable.
 * :::
 *
 * ### A stable hostname
 * Pass `name` when you need a stable `fly.dev` hostname.
 *
 * **Example:** Explicit name
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
 * ### Organization
 * Org defaults to the current token. Pass `orgSlug` to pin it.
 *
 * **Example:** Pin an org
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
 * ### Subdomains
 * `enableSubdomains: true` turns on `*.{appName}.fly.dev`.
 *
 * **Example:** Enable subdomains
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
 * ### Isolated network
 * `network` is an optional 6PN name.
 *
 * **Example:** Custom network
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
 * ### Module-scope declarations
 * Declare the App once. Pass it into every child. Resource-valued props
 * accept the resource or an Effect producing it. Do not unwrap it just
 * to pass it along.
 *
 * **Example:** Module-scope App
 * ```typescript
 * // src/app.ts
 * import * as Fly from "alchemy/Fly";
 *
 * export const Site = Fly.App("Site");
 * ```
 *
 * @resource
 * @product App
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
  machines
    .getApp({ app_name: appName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const hasAlchemyMachines = (appName: string) =>
  machines.listMachines({ app_name: appName }).pipe(
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
  machines.listVolumes({ app_name: appName }).pipe(
    Effect.map((volumes) =>
      hasAlchemyNamed(volumes.map((volume) => volume.name)),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(false)),
  );

const hasAlchemySecrets = (appName: string) =>
  machines.listSecrets({ app_name: appName }).pipe(
    Effect.map((res) =>
      hasAlchemyNamed((res.secrets ?? []).map((secret) => secret.name)),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(false)),
  );

const hasAlchemySecretKeys = (appName: string) =>
  machines.listSecretKeys({ app_name: appName }).pipe(
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
  const { apps } = yield* machines.listApps({
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

/**
 * Observe an App by name and create it when missing. Shared by
 * {@link App} and by Services that own their App.
 */
export const ensureApp = Effect.fn(function* (input: {
  name: string;
  orgSlug?: string;
  network?: string;
  enableSubdomains?: boolean;
  /** Physical name from a previous reconcile, observed first. */
  previousName?: string;
}) {
  let current =
    input.previousName !== undefined
      ? yield* getByName(input.previousName)
      : undefined;
  if (current === undefined && input.previousName !== input.name) {
    current = yield* getByName(input.name);
  }
  if (current === undefined) {
    const orgSlug = input.orgSlug ?? (yield* resolveOrgSlug());
    yield* machines
      .createApp({
        name: input.name,
        org_slug: orgSlug,
        network: input.network,
        enable_subdomains: input.enableSubdomains,
      })
      .pipe(
        Effect.catchTag(["Conflict", "UnprocessableEntity"], () => Effect.void),
      );
    current = yield* getByName(input.name);
  }
  if (current === undefined) {
    return yield* new AppNotCreated({ name: input.name });
  }
  return current;
});

/**
 * Delete an App and the Alchemy-owned Volumes in it. Idempotent: a missing
 * App is not an error. Fly deletes the App's Machines, addresses, secrets,
 * and certificates with it.
 */
export const deleteApp = Effect.fn(function* (appName: string) {
  if (appName.length === 0) return;
  const volumes = yield* machines
    .listVolumes({ app_name: appName })
    .pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed([])));
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
      return machines
        .deleteVolume({ app_name: appName, volume_id: volumeId })
        .pipe(
          Effect.asVoid,
          Effect.catchTag(["NotFound", "Conflict"], () => Effect.void),
        );
    },
    { concurrency: 4 },
  );
  const http = yield* HttpClient.HttpClient;
  const fetchOptions = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
  yield* machines.deleteApp({ app_name: appName }).pipe(
    Retry.none,
    // Bun can replay DELETE on a reused socket below the SDK retry policy.
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.mapRequest(
        http,
        HttpClientRequest.setHeader("connection", "close"),
      ),
    ),
    Effect.provideService(FetchHttpClient.RequestInit, {
      ...Option.getOrUndefined(fetchOptions),
      keepalive: false,
      redirect: "error",
    }),
    Effect.timeout("30 seconds"),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag(
      [
        "HttpClientError",
        "TimeoutError",
        "InternalServerError",
        "BadGateway",
        "ServiceUnavailable",
        "GatewayTimeout",
      ],
      (error) =>
        Effect.fail(
          new AppDeletionAmbiguous({ appName, evidence: error._tag }),
        ),
    ),
  );
  const gone = yield* getByName(appName).pipe(
    Effect.map((app) => app === undefined),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (gone) => gone,
      times: 8,
    }),
    Effect.timeout("30 seconds"),
    Effect.mapError(
      (error) =>
        new AppDeletionAmbiguous({
          appName,
          evidence: `delete accepted but absence verification failed: ${error._tag}`,
        }),
    ),
  );
  if (!gone)
    return yield* new AppDeletionAmbiguous({
      appName,
      evidence: "delete accepted but absence not observed",
    });
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
      const current = yield* ensureApp({
        name,
        orgSlug: props.orgSlug,
        network: props.network,
        enableSubdomains: props.enableSubdomains,
        previousName: output?.appName,
      });
      // No update API. enableSubdomains is create-only.
      return toAttrs(current, name);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteApp(output.appName);
    }),
  });
