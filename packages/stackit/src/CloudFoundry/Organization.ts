import * as scf from "@distilled.cloud/stackit/scf";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  CF_NAME_MAX_LENGTH,
  getOrganizationOrUndefined,
  getPlatformOrUndefined,
  isGeneratedName,
  listAllOrganizations,
  listAllSpaces,
  ORGANIZATION_TIMEOUT,
  SCF_SERVICE_ID,
  type ScfScope,
} from "./internal.ts";

export interface OrganizationProps {
  /**
   * Name of the organization, 1-255 characters. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Platform to create the organization on, from `listPlatforms`. Changing it replaces
   * the organization.
   *
   * @default the API's default platform
   */
  platformId?: string;
  /**
   * Quota to apply, from `listPlatformQuotas`. Updates in place.
   *
   * @default the API's default quota
   */
  quotaId?: string;
  /**
   * Whether the organization is suspended. Updates in place.
   *
   * @default false
   */
  suspended?: boolean;
  /**
   * Delete the organization even when it still holds spaces this stack doesn't manage,
   * and everything in them. Without it, the delete fails with
   * `Stackit.CloudFoundry.OrganizationNotEmpty`, which names them. Deploy it on its own before a
   * change that replaces the organization: an old organization keeps the props it was deployed
   * with.
   *
   * @default false
   */
  forceDestroy?: boolean;
  /** Project that owns the organization. Changing it replaces it. @default the profile's project */
  projectId?: string;
  /** Region of the organization. Changing it replaces it. @default the profile's region */
  region?: string;
}

export interface OrganizationAttributes {
  /** STACKIT id of the organization, the same as its Cloud Foundry guid. */
  organizationId: string;
  /** Name of the organization. */
  name: string;
  /** Platform the organization is on. */
  platformId: string;
  /** Cloud Foundry v3 API of the platform. */
  apiUrl: string;
  /** Web console of the platform, if it has one. */
  consoleUrl: string | undefined;
  /** Project that owns the organization. */
  projectId: string;
  /** Region of the organization. */
  region: string;
  /** Quota applied to the organization. */
  quotaId: string | undefined;
  /** State of the organization. STACKIT documents only its failure values. */
  status: string;
  /** Whether the organization is suspended. */
  suspended: boolean;
  /** When the organization was created. */
  createdAt: string | undefined;
  /** When the organization last changed. */
  updatedAt: string | undefined;
}

export type Organization = Resource<
  "Stackit.CloudFoundry.Organization",
  OrganizationProps,
  OrganizationAttributes,
  never,
  Providers
>;

/** The organization still holds spaces nothing in this stack is deleting. */
export class OrganizationNotEmpty extends Data.TaggedError(
  "Stackit.CloudFoundry.OrganizationNotEmpty",
)<{
  readonly organizationId: string;
  readonly spaces: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * A STACKIT Cloud Foundry organization, the top of Cloud Foundry's tenancy: it holds
 * spaces, and spaces hold apps.
 *
 * Changing `platformId`, `projectId` or `region` replaces the organization, and an
 * explicit `name` is reused only after the old one is deleted, because names are
 * presumably unique per platform. Everything else updates in place. The first deploy
 * enables Cloud Foundry (`cloud.stackit.scf`) for the project.
 *
 * The API has no labels. An organization is owned when it is in state or has a name
 * Alchemy generated, so one found by an explicit name without state is reported as
 * unowned, and only taken over with `--adopt`. `alchemy unsafe nuke` only enumerates
 * generated names.
 *
 * See [STACKIT's Cloud Foundry docs](https://docs.stackit.cloud/products/runtime/cloud-foundry/).
 *
 * :::caution[Changing `platformId`, `projectId` or `region` replaces the Organization]
 * The new organization starts empty. Its spaces, apps and services are recreated by
 * whatever declares them, and their data is gone.
 * :::
 *
 * ### Creating an Organization
 * **Example:** An organization with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * ```
 *
 * **Example:** A named organization with a quota
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {
 *   name: "orders",
 *   quotaId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * ### Deploying into it
 * **Example:** A space and a user to deploy with
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * const space = yield* Stackit.CloudFoundry.Space("Dev", {
 *   organizationId: organization.organizationId,
 * });
 * const manager = yield* Stackit.CloudFoundry.OrganizationManager("Manager", {
 *   organizationId: organization.organizationId,
 * });
 * ```
 *
 * ### Reading it at runtime
 * **Example:** Read an organization's usage from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Org = Stackit.CloudFoundry.Organization("Org", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const organization = yield* Org;
 *     const getUsage = yield* Stackit.CloudFoundry.GetOrganizationUsageSummary(organization);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { usageSummary } = yield* getUsage();
 *         return yield* HttpServerResponse.json({ memoryInMb: usageSummary.memoryInMb });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.GetOrganizationUsageSummaryHttp)),
 * ) {}
 * ```
 *
 * ### Deleting a non-empty Organization
 * **Example:** Opt in to deleting what is inside it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * A delete fails with `Stackit.CloudFoundry.OrganizationNotEmpty`, which names the
 * spaces, rather than deleting spaces this stack doesn't manage. Set `forceDestroy` to
 * delete them, or delete them first. Only `alchemy unsafe nuke` goes further on its own.
 *
 * An old organization keeps the props it was deployed with, so `forceDestroy` has to be
 * deployed before the change that replaces it. A replacement that deletes the old organization
 * first, which an explicit `name` can mean, fails at plan while it has spaces, and nothing
 * changes. Any other replacement that a foreign space stops stays stopped until that space is
 * deleted by hand.
 *
 * @resource
 * @product STACKIT Cloud Foundry
 * @category CloudFoundry
 */
export const Organization = Resource<Organization>("Stackit.CloudFoundry.Organization");

const toName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: CF_NAME_MAX_LENGTH });

/** The only documented failure values; see the catalog's "Unverified". */
const failedStatus = (status: string) =>
  status === "deleting_failed" || status === "delete_failed" ? status : undefined;

const isDeleting = (status: string) => status === "deleting";

const toAttrs = (
  organization: scf.Organization,
  platform: scf.Platforms | undefined,
): OrganizationAttributes => ({
  organizationId: organization.guid,
  name: organization.name,
  platformId: organization.platformId,
  apiUrl: platform?.apiUrl ?? "",
  consoleUrl: platform?.consoleUrl,
  projectId: organization.projectId,
  region: organization.region,
  quotaId: organization.quotaId,
  status: organization.status,
  suspended: organization.suspended,
  createdAt: organization.createdAt,
  updatedAt: organization.updatedAt,
});

const attrsOf = (scope: ScfScope, organization: scf.Organization) =>
  getPlatformOrUndefined(scope, organization.platformId).pipe(
    Effect.map((platform) => toAttrs(organization, platform)),
  );

const findByName = (scope: ScfScope, name: string) =>
  listAllOrganizations(scope).pipe(
    Effect.flatMap((organizations) => {
      const found = organizations.find((organization) => organization.name === name);
      return found === undefined ? Effect.undefined : getOrganizationOrUndefined(scope, found.guid);
    }),
  );

const notEmptyError = (
  organizationId: string,
  name: string,
  spaces: ReadonlyArray<string>,
  remedy: string,
) =>
  new OrganizationNotEmpty({
    organizationId,
    spaces,
    message: `Organization ${name} still has spaces: ${spaces.join(", ")}. Deleting it could delete them and their apps. ${remedy}`,
  });

/**
 * A delete-first replacement reaches the old organization before any space in the stack is
 * deleted, so it can't get through while there are spaces. Say so at plan, before anything is
 * created.
 */
const refuseDeleteFirst = (olds: OrganizationProps | undefined, output: OrganizationAttributes) =>
  Effect.gen(function* () {
    if (olds?.forceDestroy === true) return;
    const scope = { projectId: output.projectId, region: output.region };
    const spaces = yield* listAllSpaces(scope, output.organizationId).pipe(
      Effect.catchTag("NotFound", () => Effect.succeed<scf.Space[]>([])),
    );
    if (spaces.length === 0) return;
    return yield* notEmptyError(
      output.organizationId,
      output.name,
      spaces.map((space) => space.name),
      "This change deletes the old organization first, so nothing was changed. Take them out of the stack in a deploy of its own, or deploy forceDestroy: true on the organization on its own, then make this change.",
    );
  });

const waitUntilDeleted = (scope: ScfScope, organizationId: string) =>
  waitUntilGone({
    resource: `STACKIT Cloud Foundry organization ${organizationId}`,
    read: getOrganizationOrUndefined(scope, organizationId),
    failed: (organization) => failedStatus(organization.status),
    state: (organization) => organization.status,
    timeout: ORGANIZATION_TIMEOUT,
  });

export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: ["organizationId", "platformId", "projectId", "region"],

    // Spaces (`dependsOn` on their side) go first.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const organizations = yield* listAllOrganizations(scope);
      const owned: OrganizationAttributes[] = [];
      for (const summary of organizations) {
        if (!isGeneratedName(summary.name)) continue;
        const organization = yield* getOrganizationOrUndefined(scope, summary.guid);
        if (organization === undefined) continue;
        const attrs = yield* attrsOf(scope, organization);
        owned.push(attrs);
      }
      return owned;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved trigger can resolve to the values it already has, and an explicit
      // name can't exist twice: delete first. A generated name carries the generation.
      if (hasUnresolvedTrigger<OrganizationProps>(news, ["platformId", "projectId", "region"])) {
        const deleteFirst = rawProp<OrganizationProps>(news, "name") !== undefined;
        if (deleteFirst) yield* refuseDeleteFirst(olds, output);
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<OrganizationProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // No `platformId` takes whatever the API chose, so only a named one can differ.
      const samePlatform =
        resolved.platformId === undefined || resolved.platformId === output.platformId;
      const sameScope = scope.projectId === output.projectId && scope.region === output.region;
      if (!samePlatform || !sameScope) {
        // Names are presumably unique per platform, whichever project holds the organization.
        const name = rawProp<OrganizationProps>(news, "name");
        const deleteFirst = samePlatform && name === output.name;
        if (deleteFirst) yield* refuseDeleteFirst(olds, output);
        return { action: "replace", deleteFirst } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      let organization =
        output?.organizationId !== undefined
          ? yield* getOrganizationOrUndefined(scope, output.organizationId)
          : undefined;
      if (organization === undefined) {
        const name = output?.name ?? (yield* toName(id, olds?.name));
        organization = yield* findByName(scope, name);
      }
      if (organization === undefined) return undefined;
      const attrs = yield* attrsOf(scope, organization);
      // A generated name carries this generation's id, so it is ours. An explicit name
      // proves nothing, unless it is the generation being replaced at this same scope.
      const isPrevious =
        previous?.organizationId === organization.guid &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return output !== undefined || olds?.name === undefined || isPrevious
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const generatedName = yield* toName(id, undefined);
      const name = news.name ?? generatedName;
      yield* ensureServiceEnabled({ ...scope, serviceId: SCF_SERVICE_ID });
      const resource = `STACKIT Cloud Foundry organization ${name}`;

      // 1. Observe. `output` only speaks for this organization at this scope. Without
      // it, only this generation's generated name proves one is ours.
      let organization =
        output?.projectId === scope.projectId && output.region === scope.region
          ? yield* getOrganizationOrUndefined(scope, output.organizationId)
          : undefined;
      if (organization === undefined && name === generatedName) {
        organization = yield* findByName(scope, name);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (organization !== undefined && isDeleting(organization.status)) {
        yield* waitUntilDeleted(scope, organization.guid);
        organization = undefined;
      }

      // 2. Ensure. The create answers 202 with the id, before reads see it.
      let organizationId = organization?.guid;
      if (organizationId === undefined) {
        const created = yield* scf.createOrganization({
          ...scope,
          name,
          ...(news.platformId !== undefined ? { platformId: news.platformId } : {}),
        });
        organizationId = created.guid;
      }
      const liveId = organizationId;
      const settle = waitFor({
        resource,
        read: getOrganizationOrUndefined(scope, liveId),
        ready: (observed) => observed !== undefined,
        failed: (observed) => (observed === undefined ? undefined : failedStatus(observed.status)),
        state: (observed) => observed?.status,
        timeout: ORGANIZATION_TIMEOUT,
      }).pipe(Effect.map((observed) => observed!));
      let current = yield* settle;

      // 3. Sync, observed against desired. An omitted prop is left alone.
      const suspended = news.suspended ?? false;
      if (current.name !== name || current.suspended !== suspended) {
        yield* scf.updateOrganization({
          ...scope,
          organizationId: liveId,
          ...(current.name !== name ? { name } : {}),
          ...(current.suspended !== suspended ? { suspended } : {}),
        });
      }
      if (news.quotaId !== undefined && current.quotaId !== news.quotaId) {
        yield* scf.applyOrganizationQuota({
          ...scope,
          organizationId: liveId,
          quotaId: news.quotaId,
        });
      }

      // 4. Return
      current = yield* settle;
      return yield* attrsOf(scope, current);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { organizationId } = output;
      if (olds?.forceDestroy !== true && force !== true) {
        const left = yield* childrenLeftAfterSettling(
          listAllSpaces(scope, organizationId).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          ),
        );
        if (left.length > 0) {
          return yield* notEmptyError(
            organizationId,
            output.name,
            left.map((space) => space.name),
            "Delete them first, or deploy forceDestroy: true on the organization. An organization already being replaced keeps the props it was deployed with, so only deleting them by hand finishes that replacement.",
          );
        }
      }
      yield* scf
        .deleteOrganization({ ...scope, organizationId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilDeleted(scope, organizationId);
    }),
  });
