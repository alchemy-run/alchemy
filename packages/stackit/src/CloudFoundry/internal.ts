import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import {
  cloudFoundryJobGuid,
  fromCloudFoundryPassword,
} from "@distilled.cloud/stackit/CloudFoundry";
import * as scf from "@distilled.cloud/stackit/scf";
import { isResolved } from "alchemy/Diff";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { hasAlchemyLabels, hasInstanceLabel, labelRecord, toLabels } from "../Labels.ts";

/** The STACKIT service id Cloud Foundry is enabled under (spec: `CreateOrganization`). */
export const SCF_SERVICE_ID = "cloud.stackit.scf";

/** Longest generated organization or space name. The spec allows 255; this is ours. */
export const CF_NAME_MAX_LENGTH = 63;

/** Longest generated route host: one DNS label. */
export const CF_HOST_MAX_LENGTH = 63;

/** Budget for an organization to appear or disappear: the Go SDK's delete waiter allows 20 minutes. */
export const ORGANIZATION_TIMEOUT = "20 minutes";

/** Budget for a space to appear or disappear; the API reports no typical time. */
export const SPACE_TIMEOUT = "5 minutes";

/** Budget for a Cloud Foundry job (a delete); the API reports no typical time. */
export const JOB_TIMEOUT = "5 minutes";

/** Budget for a build to stage. A Docker image only needs its metadata read. */
export const BUILD_TIMEOUT = "10 minutes";

/** Budget for an app's instances to run: Cloud Foundry's own push waits 5 minutes for it. */
export const APP_START_TIMEOUT = "5 minutes";

/** Budget for a rolling deployment; it replaces one instance at a time. */
export const DEPLOYMENT_TIMEOUT = "15 minutes";

/** Budget for a marketplace service: the broker decides, and databases take minutes. */
export const SERVICE_INSTANCE_TIMEOUT = "30 minutes";

/** A project and region: the scope of everything in `scf`. */
export interface ScfScope {
  readonly projectId: string;
  readonly region: string;
}

/**
 * A user of a Cloud Foundry platform, for what only its v3 API can do. It is the
 * `apiUrl`, `username` and `password` of a `Stackit.CloudFoundry.OrganizationManager`,
 * or of a user from the `space-scoped-service-account` marketplace offering.
 */
export interface CloudFoundryCredentialsProps {
  /** The platform's API, e.g. `https://api.system.01.cf.eu01.stackit.cloud`. */
  apiUrl: string;
  /** The user's name. */
  username: string;
  /** The user's password. */
  password: string | Redacted.Redacted<string> | undefined;
}

/** The credentials have no password: STACKIT only returns an organization manager's once. */
export class CloudFoundryPasswordMissing extends Data.TaggedError(
  "Stackit.CloudFoundry.PasswordMissing",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/**
 * Sign the `cloud_foundry` calls inside `effect` as this user. The token is cached for
 * the duration of `effect`, so wrap one lifecycle operation, not each call.
 */
export const withCloudFoundry =
  (resourceName: string, credentials: CloudFoundryCredentialsProps) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const { password } = credentials;
      if (password === undefined) {
        return yield* new CloudFoundryPasswordMissing({
          resourceName,
          message: `${resourceName}: the Cloud Foundry credentials have no password. An adopted organization manager has none until its rotationKey is set.`,
        });
      }
      return yield* effect.pipe(
        Effect.provide(
          fromCloudFoundryPassword({
            apiUrl: credentials.apiUrl,
            username: credentials.username,
            password: Redacted.isRedacted(password) ? password : Redacted.make(password),
          }),
        ),
      );
    });

/** A generated name is this generation's, so nuke may delete it. */
export const isGeneratedName = (name: string | undefined): name is string =>
  name !== undefined && isGeneratedPhysicalName(name, CF_NAME_MAX_LENGTH);

/** The platform's URLs. */
export const getPlatformOrUndefined = (scope: ScfScope, platformId: string) =>
  scf
    .getPlatform({ ...scope, platformId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Every organization in a project, with the details only `withDetails` returns. */
export const listAllOrganizations = (scope: ScfScope) =>
  scf.listOrganizations.items({ ...scope, withDetails: true, perPage: 100 }).pipe(
    Stream.runCollect,
    Effect.map((organizations) => [...organizations]),
  );

/** Every space in an organization. */
export const listAllSpaces = (scope: ScfScope, organizationId: string) =>
  scf.listSpaces.items({ ...scope, organizationId, perPage: 100 }).pipe(
    Stream.runCollect,
    Effect.map((spaces) => [...spaces]),
  );

export const getOrganizationOrUndefined = (scope: ScfScope, organizationId: string) =>
  scf
    .getOrganization({ ...scope, organizationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const getOrgManagerOrUndefined = (scope: ScfScope, organizationId: string) =>
  scf
    .getOrgManager({ ...scope, organizationId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const getSpaceOrUndefined = (scope: ScfScope, organizationId: string, spaceId: string) =>
  scf
    .getSpace({ ...scope, organizationId, spaceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** A to-one relationship to a resource, as the v3 API takes it. */
export const relationTo = (guid: string) => ({ data: { guid } });

/** The id of a to-one relationship, or `undefined` when it is empty. */
export const relationId = (
  relationship: { readonly data?: { readonly guid?: string } | null } | undefined,
): string | undefined => relationship?.data?.guid;

/** A resource the API answered with no id, which the document marks as optional. */
export class CloudFoundryIdMissing extends Data.TaggedError("Stackit.CloudFoundry.IdMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** The id of what the API answered, which every response has in practice. */
export const requireGuid = (resourceName: string, resource: { readonly guid?: string }) =>
  resource.guid === undefined
    ? Effect.fail(
        new CloudFoundryIdMissing({
          resourceName,
          message: `Cloud Foundry returned ${resourceName} without a guid`,
        }),
      )
    : Effect.succeed(resource.guid);

/** Observed labels of a v3 resource. */
export const observedLabels = (resource: {
  readonly metadata?: { readonly labels?: unknown } | undefined;
}) => labelRecord(resource.metadata?.labels);

/**
 * The label update that takes observed labels to the desired ones, or `undefined` when
 * they already match. The API merges, and `null` removes a key. Only a key this resource
 * wrote before is removed: a label someone else put there stays.
 */
export const labelUpdate = (
  observed: Record<string, string>,
  desired: Record<string, string>,
  previous: Record<string, string> | undefined,
): Record<string, string | null> | undefined => {
  const changes: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (observed[key] !== value) changes[key] = value;
  }
  for (const key of Object.keys(toLabels(previous))) {
    if (!(key in desired) && key in observed) changes[key] = null;
  }
  return Object.keys(changes).length === 0 ? undefined : changes;
};

/**
 * Wait for the job an asynchronous operation answered with. A failed job fails with the
 * API's own reason, and an operation that finished before answering has no job.
 */
export const awaitJob = (
  resource: string,
  location: string | undefined,
  timeout: Duration.Input = JOB_TIMEOUT,
) => {
  const guid = cloudFoundryJobGuid(location);
  if (guid === undefined) return Effect.void;
  return waitFor({
    resource,
    // Finished jobs are removed eventually, so a missing one has finished.
    read: cf.getJob({ guid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined)),
    ready: (job) => job === undefined || job.state === "COMPLETE",
    failed: (job) =>
      job?.state === "FAILED"
        ? (job.errors ?? []).map((error) => error.detail ?? error.title ?? "").join("; ") ||
          "job failed"
        : undefined,
    state: (job) => job?.state,
    timeout,
  }).pipe(Effect.asVoid);
};

/** No shared domain on the platform, or none of the given name. */
export class CloudFoundryDomainNotFound extends Data.TaggedError(
  "Stackit.CloudFoundry.DomainNotFound",
)<{
  readonly resourceName: string;
  readonly domain: string | undefined;
  readonly message: string;
}> {}

const collect = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((items) => [...items]),
  );

/**
 * The domain a route is on: the one named, or the platform's first shared HTTP domain,
 * which is what `cf push` uses (`apps.01.cf.eu01.stackit.cloud` on STACKIT's platform).
 */
export const resolveDomain = (resourceName: string, domain: string | undefined) =>
  Effect.gen(function* () {
    const domains = yield* collect(
      cf.listDomains.items({
        per_page: 100,
        ...(domain !== undefined ? { names: domain } : {}),
      }),
    );
    const found =
      domain !== undefined
        ? domains.find((candidate) => candidate.name === domain)
        : domains.find(
            (candidate) =>
              candidate.internal !== true &&
              relationId(candidate.relationships?.organization) === undefined &&
              (candidate.supported_protocols ?? ["http"]).includes("http"),
          );
    if (found?.guid === undefined || found.name === undefined) {
      return yield* new CloudFoundryDomainNotFound({
        resourceName,
        domain,
        message:
          domain !== undefined
            ? `${resourceName}: the platform has no domain ${domain}`
            : `${resourceName}: the platform has no shared HTTP domain, so name one`,
      });
    }
    return { domainId: found.guid, domain: found.name };
  });

/** A route exists at the address, and nothing says it is this resource's. */
export class CloudFoundryRouteTaken extends Data.TaggedError("Stackit.CloudFoundry.RouteTaken")<{
  readonly resourceName: string;
  readonly host: string;
  readonly message: string;
}> {}

/**
 * The route at an address, for a resource with no record of one, or `undefined`. One
 * without this resource's labels stops the deploy rather than being used, and later deleted.
 */
export const findOwnRoute = (args: {
  readonly id: string;
  /** Only this generation's route counts: an older one is waiting for its delete. */
  readonly instanceId: string;
  readonly spaceId: string;
  readonly domainId: string;
  readonly host: string;
  readonly path: string | undefined;
}) =>
  Effect.gen(function* () {
    const route = yield* findRoute(args);
    if (route === undefined) return undefined;
    const labels = observedLabels(route);
    if ((yield* hasAlchemyLabels(args.id, labels)) && hasInstanceLabel(args.instanceId, labels)) {
      return route;
    }
    return yield* new CloudFoundryRouteTaken({
      resourceName: args.id,
      host: args.host,
      message: `${args.id}: a route ${args.host} already exists in this space, and Alchemy didn't make it`,
    });
  });

/** The route at a space, domain, host and path, if any. */
export const findRoute = (args: {
  readonly spaceId: string;
  readonly domainId: string;
  readonly host: string;
  readonly path: string | undefined;
}) =>
  collect(
    cf.listRoutes.items({
      per_page: 100,
      space_guids: args.spaceId,
      domain_guids: args.domainId,
      hosts: args.host,
    }),
  ).pipe(
    Effect.map((routes) =>
      routes.find((route) => route.host === args.host && (route.path ?? "") === (args.path ?? "")),
    ),
  );

export const getRouteOrUndefined = (guid: string) =>
  cf.getRoute({ guid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Delete a route and wait for it to go. Idempotent. */
export const deleteRouteAndWait = (resource: string, guid: string) =>
  Effect.gen(function* () {
    const deleted = yield* cf
      .deleteRoute({ guid })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
    if (deleted !== undefined) yield* awaitJob(`${resource} delete`, deleted.location);
  });

/** Make `appId` a destination of the route, unless it is one. */
export const ensureDestination = (routeId: string, appId: string) =>
  Effect.gen(function* () {
    const listed = yield* cf.listDestinationsForRoute({ guid: routeId });
    const existing = (listed.destinations ?? []).find(
      (destination) => destination.app?.guid === appId,
    );
    if (existing?.guid !== undefined) return existing.guid;
    const inserted = yield* cf.insertDestinationsForRoute({
      guid: routeId,
      destinations: [{ app: { guid: appId } }],
    });
    return (inserted.destinations ?? []).find((destination) => destination.app?.guid === appId)
      ?.guid;
  });

export { collect as collectCloudFoundryItems };

/**
 * What `Stackit.CloudFoundry.OrganizationRole` and `SpaceRole` share. The `scf` API only
 * has the create; reading and deleting a role take the Cloud Foundry v3 API.
 * NOT exported from index.ts.
 */

/** The props both role resources share. */
export interface RoleProps {
  /** Organization of the role. Changing it replaces the role. */
  organizationId: string;
  /**
   * Cloud Foundry user id of the user to grant the role, such as an organization
   * manager's `userId`. Give this or {@link userName}. Changing it replaces the role.
   */
  userGuid?: string;
  /**
   * Name of the user to grant the role. Give this or {@link userGuid}. Changing it
   * replaces the role.
   *
   * Without a user id, a role the user already holds can't be recognized before the
   * API returns it, so Alchemy takes it over, and deletes it with this resource.
   */
  userName?: string;
  /**
   * A user who can read and delete the role, usually the organization manager's. The
   * role's lifecycle needs it, because `scf` has no read or delete. Updates in place.
   */
  credentials: CloudFoundryCredentialsProps;
  /** Project that owns the organization. Changing it replaces the role. @default the profile's project */
  projectId?: string;
  /** Region of the organization. Changing it replaces the role. @default the profile's region */
  region?: string;
}

/** The attributes both role resources share. */
export interface RoleAttributes {
  /** Cloud Foundry id of the role. */
  roleId: string;
  /** Organization of the role. */
  organizationId: string;
  /** Platform the organization is on. */
  platformId: string;
  /** Cloud Foundry user id of the user holding the role, if the API reports it. */
  userGuid: string | undefined;
  /** Name given for the user, if one was. */
  userName: string | undefined;
  /** Project that owns the organization. */
  projectId: string;
  /** Region of the organization. */
  region: string;
  /**
   * Whether the role's user is the organization manager whose `credentials` manage it. Rotating
   * that manager deletes the user, and the role with it.
   */
  heldByLogin: boolean;
}

const getRoleOrUndefined = (guid: string) =>
  cf.getRole({ guid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** The role's user, which isn't in what `scf` answers. */
export const roleUser = (
  role: { readonly relationships?: { readonly user?: { readonly data?: unknown } } } | undefined,
): string | undefined => {
  const data = role?.relationships?.user?.data;
  return typeof data === "object" &&
    data !== null &&
    "guid" in data &&
    typeof data.guid === "string"
    ? data.guid
    : undefined;
};

/** The role `type` a user holds on a scope, if any. Only a user id can be filtered on. */
export const findRole = (filter: {
  readonly type: string;
  readonly userGuid: string;
  readonly organizationId?: string | undefined;
  readonly spaceId?: string | undefined;
}) =>
  collect(
    cf.listRoles.items({
      per_page: 100,
      types: filter.type,
      user_guids: filter.userGuid,
      ...(filter.organizationId !== undefined ? { organization_guids: filter.organizationId } : {}),
      ...(filter.spaceId !== undefined ? { space_guids: filter.spaceId } : {}),
    }),
  ).pipe(
    Effect.map((roles) =>
      roles.find((role) => role.guid !== undefined && role.type === filter.type),
    ),
  );

/** Observe the role behind `roleId`. */
export const observeRole = (
  resourceName: string,
  credentials: CloudFoundryCredentialsProps,
  roleId: string,
) => getRoleOrUndefined(roleId).pipe(withCloudFoundry(resourceName, credentials));

/** Whether credentials can be used yet: a `read` may run before upstreams resolved. */
export const usableCredentials = (
  credentials: CloudFoundryCredentialsProps | undefined,
): credentials is CloudFoundryCredentialsProps =>
  credentials !== undefined && isResolved(credentials) && credentials.password !== undefined;

/** Delete a role and wait for it to go. Idempotent. */
export const deleteRole = (resource: string, roleId: string) =>
  Effect.gen(function* () {
    const deleted = yield* cf
      .deleteRole({ guid: roleId })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
    if (deleted === undefined) return;
    yield* awaitJob(`${resource} delete`, deleted.location);
    yield* waitUntilGone({
      resource,
      read: getRoleOrUndefined(roleId),
      state: (role) => role.type,
      timeout: JOB_TIMEOUT,
    });
  });

/** Whether the role's user is the organization manager the credentials sign in as. */
export const isLoginsOwnRole = (
  scope: ScfScope,
  organizationId: string,
  credentials: CloudFoundryCredentialsProps,
  userGuid: string | undefined,
) =>
  getOrgManagerOrUndefined(scope, organizationId).pipe(
    Effect.map(
      (manager) =>
        manager !== undefined &&
        manager.guid === userGuid &&
        manager.username === credentials.username,
    ),
  );

/**
 * Delete a role, signing in with the credentials its row recorded. A role replaced because its
 * manager was rotated records the rotated manager's password, which is gone by now, along with
 * the user: Cloud Foundry deletes a user's roles with the user (v3-apidocs.cloudfoundry.org
 * "Delete a user"). So a refused login means there is nothing to delete, once STACKIT confirms
 * that login isn't the organization's manager any more. Any other refused login stays a failure.
 */
export const deleteRoleAs = (
  id: string,
  resource: string,
  credentials: CloudFoundryCredentialsProps,
  output: RoleAttributes,
) =>
  deleteRole(resource, output.roleId).pipe(
    withCloudFoundry(id, credentials),
    Effect.catchTag("ConfigError", (error) =>
      Effect.gen(function* () {
        if (!output.heldByLogin) return yield* Effect.fail(error);
        const scope = { projectId: output.projectId, region: output.region };
        const manager = yield* getOrgManagerOrUndefined(scope, output.organizationId);
        if (manager?.username === credentials.username) return yield* Effect.fail(error);
      }),
    ),
  );

/**
 * The `diff` of a role: everything but the credentials is its identity, and the API
 * answers the existing role for the same identity, so the old one always goes first.
 */
export const roleDiff = <Props extends RoleProps, Attrs extends RoleAttributes>(
  keys: ReadonlyArray<keyof Props & string>,
  matches: (resolved: Props, output: Attrs) => boolean,
) =>
  Effect.fn(function* ({
    news,
    output,
  }: {
    readonly news: unknown;
    readonly output: Attrs | undefined;
  }) {
    if (output === undefined) return undefined;
    if (hasUnresolvedTrigger<Props>(news, keys)) {
      return { action: "replace", deleteFirst: true } as const;
    }
    const resolved = triggerProps<Props>(news);
    const scope = yield* resolveProjectScope(resolved, undefined);
    if (
      scope.projectId !== output.projectId ||
      scope.region !== output.region ||
      resolved.organizationId !== output.organizationId ||
      (resolved.userGuid !== undefined &&
        output.userGuid !== undefined &&
        resolved.userGuid !== output.userGuid) ||
      resolved.userName !== output.userName ||
      !matches(resolved, output)
    ) {
      return { action: "replace", deleteFirst: true } as const;
    }
    return undefined;
  });

/** The user a request names, as `createOrgRole` and `createSpaceRole` take it. */
export const roleTarget = (props: RoleProps) => ({
  ...(props.userGuid !== undefined ? { userGuid: props.userGuid } : {}),
  ...(props.userName !== undefined ? { userName: props.userName } : {}),
});
