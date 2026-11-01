import * as router from "@distilled.cloud/stackit/telemetry_router";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import {
  conflictRetry,
  emptyToUndefined,
  generatedDisplayName,
  isGeneratedDisplayName,
} from "../internal/displayNames.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  getRouterOrUndefined,
  listOwnedRouters,
  listRouterDestinations,
  onRegion,
  POLL,
  TELEMETRY_TIMEOUT,
  type RouterScope,
} from "./internal.ts";
import { filterEquals, type TelemetryFilter } from "./Router.ts";

/** Forward records to an endpoint that speaks OTLP. */
export interface OpenTelemetryDestinationConfig {
  type: "OpenTelemetry";
  /** Where to send the records. */
  uri: string;
  /** Basic auth at `uri`. Use this or `bearerToken`. */
  basicAuth?: {
    /** User name. */
    username: string;
    /** Password. */
    password: string | Redacted.Redacted<string>;
  };
  /** Bearer token at `uri`. Use this or `basicAuth`. */
  bearerToken?: string | Redacted.Redacted<string>;
  /** Which records this destination takes. Omit to leave the live filter alone. */
  filter?: TelemetryFilter;
}

/** Write records to S3-compatible storage. */
export interface S3DestinationConfig {
  type: "S3";
  /** The S3 endpoint. */
  endpoint: string;
  /** Bucket to write to. */
  bucket: string;
  /** Access key for the bucket. */
  accessKey?: {
    /** Access key id. */
    id: string;
    /** Secret access key. */
    secret: string | Redacted.Redacted<string>;
  };
  /** Which records this destination takes. Omit to leave the live filter alone. */
  filter?: TelemetryFilter;
}

export type DestinationConfig = OpenTelemetryDestinationConfig | S3DestinationConfig;

export interface DestinationProps {
  /** Id of the router the destination is on. Changing it replaces the destination. */
  routerId: string;
  /**
   * Name of the destination: 1 to 32 letters, digits, spaces and hyphens, starting with
   * a letter or digit. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /**
   * Description: letters, digits, spaces and hyphens only, at most 1024 characters.
   * Updates in place; omit to leave the live value alone.
   */
  description?: string;
  /**
   * Where the records go. Updates in place, including a switch between `OpenTelemetry`
   * and `S3`.
   */
  config: DestinationConfig;
  /** Project of the router. Changing it replaces the destination. @default the profile's project */
  projectId?: string;
  /** Region of the router. Changing it replaces the destination. @default the profile's region */
  region?: string;
}

/** A destination's configuration, without its secrets. */
export interface DestinationConfigAttributes {
  /** `OpenTelemetry` or `S3`. */
  type: string;
  /** Endpoint of an OpenTelemetry destination. */
  uri: string | undefined;
  /** User name of an OpenTelemetry destination with basic auth. */
  username: string | undefined;
  /** Endpoint of an S3 destination. */
  endpoint: string | undefined;
  /** Bucket of an S3 destination. */
  bucket: string | undefined;
  /** Access key id of an S3 destination. */
  accessKeyId: string | undefined;
  /** The destination's filter, if any. */
  filter: router.ConfigFilter | undefined;
}

export interface DestinationAttributes {
  /** STACKIT destination id (UUID). Stable across updates. */
  destinationId: string;
  /** Id of the router the destination is on. */
  routerId: string;
  /** Project of the router. */
  projectId: string;
  /** Region of the router. */
  region: string;
  /** Name of the destination. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** Where the records go, without the secrets. */
  config: DestinationConfigAttributes;
  /** Kind of credential: `bearerToken`, `basicAuth` or `accessKey`. */
  credentialType: string;
  /** Status; `active` after a deploy. */
  status: string;
  /** When the destination was created (RFC 3339). */
  creationTime: string;
}

export type Destination = Resource<
  "Stackit.Telemetry.Destination",
  DestinationProps,
  DestinationAttributes,
  never,
  Providers
>;

/**
 * Where a `Stackit.Telemetry.Router` forwards its records: an endpoint that speaks
 * OTLP, or S3-compatible storage. A router forwards to all its destinations in
 * parallel. STACKIT documents at-least-once delivery.
 *
 * Name, description and configuration update in place, including a switch between the
 * two types; moving to another router replaces the destination.
 *
 * The API may not hand back the password, bearer token or secret key, and Alchemy
 * doesn't store them in the attributes. A secret is re-sent when it differs from the
 * last deployed props, which is the only way a changed secret can be noticed: one
 * rotated outside Alchemy isn't detected.
 *
 * Destinations have no labels. Without state, a generated name proves a destination is
 * Alchemy's, and an explicit name found on the router is reported as unowned, and only
 * taken over with `--adopt`.
 *
 * ### Exporting to OpenTelemetry
 * **Example:** An endpoint with a bearer token
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * const token = yield* Config.redacted("SIEM_TOKEN");
 * yield* Stackit.Telemetry.Destination("Siem", {
 *   routerId: router.routerId,
 *   config: {
 *     type: "OpenTelemetry",
 *     uri: "https://siem.example.com/otlp/v1/logs",
 *     bearerToken: token,
 *   },
 * });
 * ```
 *
 * **Example:** An endpoint with basic auth
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * const password = yield* Config.redacted("SIEM_PASSWORD");
 * yield* Stackit.Telemetry.Destination("Siem", {
 *   routerId: router.routerId,
 *   config: {
 *     type: "OpenTelemetry",
 *     uri: "https://siem.example.com/otlp/v1/logs",
 *     basicAuth: { username: "audit", password },
 *   },
 * });
 * ```
 *
 * ### Exporting to Object Storage
 * **Example:** A bucket with its own access key
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * const secret = yield* Config.redacted("AUDIT_BUCKET_SECRET");
 * yield* Stackit.Telemetry.Destination("Archive", {
 *   routerId: router.routerId,
 *   config: {
 *     type: "S3",
 *     endpoint: "https://object.storage.eu01.onstackit.cloud",
 *     bucket: "audit-archive",
 *     accessKey: { id: "AKIAEXAMPLE", secret },
 *   },
 * });
 * ```
 *
 * ### Filtering Records
 * **Example:** Keep records of one service in this destination
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const router = yield* Stackit.Telemetry.Router("AuditLogs", {});
 * const token = yield* Config.redacted("SIEM_TOKEN");
 * yield* Stackit.Telemetry.Destination("IamEvents", {
 *   routerId: router.routerId,
 *   config: {
 *     type: "OpenTelemetry",
 *     uri: "https://siem.example.com/otlp/v1/logs",
 *     bearerToken: token,
 *     filter: {
 *       attributes: [
 *         { key: "service.name", level: "resource", matcher: "=", values: ["iam"] },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Telemetry Router
 * @category Telemetry
 */
export const Destination = Resource<Destination>("Stackit.Telemetry.Destination");

type LiveDestination = router.DestinationResponse;

const toRequestConfig = (config: DestinationConfig): router.DestinationConfig => {
  const filter = config.filter !== undefined ? { filter: config.filter } : {};
  return config.type === "OpenTelemetry"
    ? {
        configType: "OpenTelemetry",
        openTelemetry: {
          uri: config.uri,
          ...(config.basicAuth !== undefined ? { basicAuth: config.basicAuth } : {}),
          ...(config.bearerToken !== undefined ? { bearerToken: config.bearerToken } : {}),
        },
        ...filter,
      }
    : {
        configType: "S3",
        s3: {
          endpoint: config.endpoint,
          bucket: config.bucket,
          ...(config.accessKey !== undefined ? { accessKey: config.accessKey } : {}),
        },
        ...filter,
      };
};

const toAttrs = (scope: RouterScope, routerId: string, live: LiveDestination) =>
  ({
    destinationId: live.id,
    routerId,
    projectId: scope.projectId,
    region: scope.region,
    displayName: live.displayName,
    description: emptyToUndefined(live.description),
    config: {
      type: live.config.configType,
      uri: live.config.openTelemetry?.uri,
      username: live.config.openTelemetry?.basicAuth?.username,
      endpoint: live.config.s3?.endpoint,
      bucket: live.config.s3?.bucket,
      accessKeyId: live.config.s3?.accessKey?.id,
      filter: live.config.filter,
    },
    credentialType: live.credentialType,
    status: live.status,
    creationTime: live.creationTime,
  }) satisfies DestinationAttributes;

/** Whether the parts of the config the API shows differ from the props. */
const configDrifted = (live: router.DestinationConfig, desired: DestinationConfig) => {
  if (live.configType !== desired.type) return true;
  if (desired.filter !== undefined && !filterEquals(live.filter, desired.filter)) return true;
  if (desired.type === "OpenTelemetry") {
    return (
      live.openTelemetry?.uri !== desired.uri ||
      live.openTelemetry?.basicAuth?.username !== desired.basicAuth?.username
    );
  }
  return (
    live.s3?.endpoint !== desired.endpoint ||
    live.s3?.bucket !== desired.bucket ||
    live.s3?.accessKey?.id !== desired.accessKey?.id
  );
};

/** The secrets in a config, to compare with the last deployed props. */
const secretsOf = (config: DestinationConfig) =>
  config.type === "OpenTelemetry"
    ? { password: config.basicAuth?.password, bearerToken: config.bearerToken }
    : { secret: config.accessKey?.secret };

const getOrUndefined = (scope: RouterScope, telemetryRouterId: string, destinationId: string) =>
  router
    .getDestination({ ...onRegion(scope), telemetryRouterId, destinationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (scope: RouterScope, telemetryRouterId: string, name: string) =>
  listRouterDestinations(scope, telemetryRouterId).pipe(
    Effect.map((destinations) => destinations.find((item) => item.displayName === name)),
  );

const waitForActive = (
  scope: RouterScope,
  telemetryRouterId: string,
  destinationId: string,
  applied: (live: LiveDestination) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT Telemetry Router destination ${destinationId}`,
    read: router.getDestination({ ...onRegion(scope), telemetryRouterId, destinationId }),
    ready: (live) => live.status === "active" && applied(live),
    // A destination being deleted won't become active (the Go SDK's error state).
    failed: (live) => live.status === "deleting",
    state: (live) => live.status,
    timeout: TELEMETRY_TIMEOUT,
    ...POLL,
  });

const waitForGone = (scope: RouterScope, telemetryRouterId: string, destinationId: string) =>
  waitUntilGone({
    resource: `STACKIT Telemetry Router destination ${destinationId}`,
    read: getOrUndefined(scope, telemetryRouterId, destinationId),
    state: (live) => live.status,
    timeout: TELEMETRY_TIMEOUT,
    ...POLL,
  });

export const DestinationProvider = () =>
  Provider.succeed(Destination, {
    stables: ["destinationId", "routerId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.Telemetry.Router"] },

    // Only generated names: a destination someone added to our router by hand isn't ours.
    list: Effect.fn(function* () {
      const scope = yield* resolveProjectScope(undefined, undefined);
      const routers = yield* listOwnedRouters(scope);
      const found: DestinationAttributes[] = [];
      for (const owner of routers) {
        const destinations = yield* listRouterDestinations(scope, owner.id);
        for (const live of destinations) {
          if (isGeneratedDisplayName(live.displayName)) {
            found.push(toAttrs(scope, owner.id, live));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the router the destination is already on. A
      // generated name carries the generation, an explicit one survives it.
      if (hasUnresolvedTrigger<DestinationProps>(news, ["routerId", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<DestinationProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<DestinationProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.routerId !== output.routerId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed, which reads
      // through `Redacted`).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const routerId = output?.routerId ?? olds?.routerId;
      if (routerId === undefined) return undefined;
      if (output?.destinationId !== undefined) {
        const byId = yield* getOrUndefined(scope, routerId, output.destinationId);
        if (byId !== undefined && byId.status !== "deleting") {
          return toAttrs(scope, routerId, byId);
        }
      }
      // The list operation has no typed "router is gone".
      if ((yield* getRouterOrUndefined(scope, routerId)) === undefined) return undefined;
      const name = output?.displayName ?? olds?.displayName ?? (yield* generatedDisplayName(id));
      const found = yield* findByName(scope, routerId, name);
      if (found === undefined || found.status === "deleting") return undefined;
      const attrs = toAttrs(scope, routerId, found);
      // No labels: a generated name carries this generation's id, so it is ours. An
      // explicit name proves nothing, unless it is the generation being replaced.
      return olds?.displayName === undefined || previous?.destinationId === found.id
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const routerId = news.routerId;
      const generatedName = yield* generatedDisplayName(id);
      const displayName = news.displayName ?? output?.displayName ?? generatedName;
      const known =
        output?.routerId === routerId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output
          : undefined;

      // 1. Observe — by cached id, then by a generated name (a crashed create). Only
      // this generation's generated name proves a destination is ours.
      let live: LiveDestination | undefined;
      if (known !== undefined) {
        live = yield* getOrUndefined(scope, routerId, known.destinationId);
      }
      if (live === undefined && displayName === generatedName) {
        live = yield* findByName(scope, routerId, displayName);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (live?.status === "deleting") {
        yield* waitForGone(scope, routerId, live.id);
        live = undefined;
      }

      // 2. Ensure
      let created = false;
      if (live === undefined) {
        live = yield* router
          .createDestination({
            ...onRegion(scope),
            telemetryRouterId: routerId,
            displayName,
            config: toRequestConfig(news.config),
            ...(news.description !== undefined ? { description: news.description } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        created = true;
      }
      const destinationId = live.id;
      live = yield* waitForActive(scope, routerId, destinationId);

      // 3. Sync — what the API shows against the live destination. The secrets can't be
      // compared with it, so they are re-sent when the deployed props held others, or
      // when there are no deployed props to compare with (an adoption or a crashed create).
      const resendConfig =
        configDrifted(live.config, news.config) ||
        (!created &&
          (olds === undefined || secretsDiffer(secretsOf(olds.config), secretsOf(news.config))));
      const patch = {
        ...(live.displayName !== displayName ? { displayName } : {}),
        ...(news.description !== undefined && (live.description ?? "") !== news.description
          ? { description: news.description }
          : {}),
        ...(resendConfig ? { config: toRequestConfig(news.config) } : {}),
      };
      if (Object.keys(patch).length > 0) {
        yield* router
          .updateDestination({
            ...onRegion(scope),
            telemetryRouterId: routerId,
            destinationId,
            ...patch,
          })
          .pipe(Effect.retry(conflictRetry));
        live = yield* waitForActive(
          scope,
          routerId,
          destinationId,
          (observed) =>
            observed.displayName === displayName &&
            (news.description === undefined || (observed.description ?? "") === news.description) &&
            !configDrifted(observed.config, news.config),
        );
      }

      // 4. Return
      return toAttrs(scope, routerId, live);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { routerId, destinationId } = output;
      yield* router
        .deleteDestination({ ...onRegion(scope), telemetryRouterId: routerId, destinationId })
        .pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      yield* waitForGone(scope, routerId, destinationId);
    }),
  });
