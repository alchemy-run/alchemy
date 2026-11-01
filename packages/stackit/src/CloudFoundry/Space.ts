import * as cf from "@distilled.cloud/stackit/cloud_foundry";
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
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  CF_NAME_MAX_LENGTH,
  collectCloudFoundryItems,
  getPlatformOrUndefined,
  getSpaceOrUndefined,
  isGeneratedName,
  listAllOrganizations,
  listAllSpaces,
  SPACE_TIMEOUT,
  usableCredentials,
  withCloudFoundry,
  type CloudFoundryCredentialsProps,
  type ScfScope,
} from "./internal.ts";

export interface SpaceProps {
  /** Organization holding the space. Changing it replaces the space. */
  organizationId: string;
  /**
   * Name of the space. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * A user who can see what is in the space, usually the organization manager, so a delete can
   * check it is empty. A user with no role in the space sees nothing there, which reads as empty.
   * The `scf` API can't list a space's contents, so without this a delete stops with
   * `Stackit.CloudFoundry.SpaceDeleteRefused`, unless {@link forceDestroy} is set. Updates in place.
   */
  credentials?: CloudFoundryCredentialsProps;
  /**
   * Allow deleting the space whatever is in it. STACKIT doesn't document what `DeleteSpace` does to
   * apps and service instances in the space, so assume they are deleted too. Deploy it on its own
   * before a change that replaces the space: an old space keeps the props it was deployed with.
   *
   * @default false
   */
  forceDestroy?: boolean;
  /** Project that owns the organization. Changing it replaces the space. @default the profile's project */
  projectId?: string;
  /** Region of the organization. Changing it replaces the space. @default the profile's region */
  region?: string;
}

export interface SpaceAttributes {
  /** STACKIT id of the space, the same as its Cloud Foundry guid. */
  spaceId: string;
  /** Name of the space. */
  name: string;
  /** Organization holding the space. */
  organizationId: string;
  /** Platform the space is on. */
  platformId: string;
  /** Cloud Foundry v3 API of the platform. */
  apiUrl: string;
  /** Project that owns the organization. */
  projectId: string;
  /** Region of the organization. */
  region: string;
  /** When the space was created. */
  createdAt: string;
  /** When the space last changed. */
  updatedAt: string;
}

export type Space = Resource<
  "Stackit.CloudFoundry.Space",
  SpaceProps,
  SpaceAttributes,
  never,
  Providers
>;

/**
 * A space in a STACKIT Cloud Foundry organization: where apps, routes and service
 * instances live, and what roles are granted on.
 *
 * Changing `organizationId`, `projectId` or `region` replaces the space; its name
 * updates in place.
 *
 * The API has no labels. A space is owned when it is in state or has a name Alchemy
 * generated, so one found by an explicit name without state is reported as unowned,
 * and only taken over with `--adopt`.
 *
 * ### What Deleting Does <!-- api-prose -->
 * STACKIT doesn't document what `DeleteSpace` does to apps in the space, so Alchemy never finds
 * out with your data. With `credentials`, a delete lists the space's apps and service instances
 * through the platform's Cloud Foundry API, waits up to two minutes for this stack's own to go,
 * and fails with `Stackit.CloudFoundry.SpaceDeleteRefused`, naming what's left. Only an empty
 * space is deleted. Without `credentials` nothing can look, so a delete fails with the same error.
 *
 * With `forceDestroy`, or under `alchemy unsafe nuke`, nothing is checked.
 *
 * ### Creating a Space
 * **Example:** A space with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * const space = yield* Stackit.CloudFoundry.Space("Dev", {
 *   organizationId: organization.organizationId,
 * });
 * ```
 *
 * **Example:** A named space
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * const space = yield* Stackit.CloudFoundry.Space("Staging", {
 *   organizationId: organization.organizationId,
 *   name: "staging",
 * });
 * ```
 *
 * ### Deleting a Space
 * **Example:** Check it's empty, with the organization manager's login
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * const manager = yield* Stackit.CloudFoundry.OrganizationManager("Manager", {
 *   organizationId: organization.organizationId,
 * });
 * const space = yield* Stackit.CloudFoundry.Space("Dev", {
 *   organizationId: organization.organizationId,
 *   credentials: {
 *     apiUrl: manager.apiUrl,
 *     username: manager.username,
 *     password: manager.password,
 *   },
 * });
 * ```
 *
 * **Example:** Delete it whatever is in it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const organization = yield* Stackit.CloudFoundry.Organization("Org", {});
 * const space = yield* Stackit.CloudFoundry.Space("Dev", {
 *   organizationId: organization.organizationId,
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Deploying an App into a Space
 * **Example:** An organization manager with the role to deploy there
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
 * const credentials = {
 *   apiUrl: manager.apiUrl,
 *   username: manager.username,
 *   password: manager.password,
 * };
 * yield* Stackit.CloudFoundry.SpaceRole("Deployer", {
 *   organizationId: organization.organizationId,
 *   spaceId: space.spaceId,
 *   type: "space_developer",
 *   userGuid: manager.userId,
 *   credentials,
 * });
 * ```
 *
 * ### Reading it at runtime
 * **Example:** Read a space from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Org = Stackit.CloudFoundry.Organization("Org", {});
 * export const Dev = Effect.gen(function* () {
 *   const organization = yield* Org;
 *   return yield* Stackit.CloudFoundry.Space("Dev", {
 *     organizationId: organization.organizationId,
 *   });
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const space = yield* Dev;
 *     const getSpace = yield* Stackit.CloudFoundry.GetSpace(space);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const space = yield* getSpace();
 *         return yield* HttpServerResponse.json({ name: space.name });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.CloudFoundry.GetSpaceHttp)),
 * ) {}
 * ```
 *
 * :::caution[Changing `organizationId`, `projectId` or `region` replaces the Space]
 * The new space starts empty. What declares its apps and services recreates them. Without
 * `forceDestroy` deployed first, a plan that replaces a space with no `credentials`, or that
 * deletes the old space before the new one while it holds anything, fails and changes nothing.
 * Anything else left in the old space stops its delete, and only deleting that by hand finishes
 * the replacement: an old space keeps the props it was deployed with.
 * :::
 *
 * @resource
 * @product STACKIT Cloud Foundry
 * @category CloudFoundry
 */
export const Space = Resource<Space>("Stackit.CloudFoundry.Space");

/** A delete of a space that holds something, or that nothing could look into. */
export class SpaceDeleteRefused extends Data.TaggedError(
  "Stackit.CloudFoundry.SpaceDeleteRefused",
)<{
  readonly spaceId: string;
  readonly reason: "no-credentials" | "not-empty";
  readonly apps: ReadonlyArray<string>;
  readonly serviceInstances: ReadonlyArray<string>;
  readonly message: string;
}> {}

/** What the platform's Cloud Foundry API shows in a space. */
const listContents = (spaceId: string) =>
  Effect.all([
    collectCloudFoundryItems(cf.listApps.items({ per_page: 100, space_guids: spaceId })),
    collectCloudFoundryItems(
      cf.listServiceInstances.items({ per_page: 100, space_guids: spaceId }),
    ),
  ]).pipe(
    Effect.map(([apps, serviceInstances]) => [
      ...apps.map((app) => ({ kind: "app" as const, name: app.name ?? app.guid ?? "unknown" })),
      ...serviceInstances.map((instance) => ({
        kind: "service-instance" as const,
        name: instance.name,
      })),
    ]),
  );

const noCredentialsError = (output: SpaceAttributes, remedy: string) =>
  new SpaceDeleteRefused({
    spaceId: output.spaceId,
    reason: "no-credentials",
    apps: [],
    serviceInstances: [],
    message: `Space ${output.name} has no credentials to check what is in it, and deleting it may delete its apps and service instances. ${remedy}`,
  });

const notEmptyError = (
  output: SpaceAttributes,
  left: ReadonlyArray<{ readonly kind: "app" | "service-instance"; readonly name: string }>,
  remedy: string,
) => {
  const namesOf = (kind: "app" | "service-instance") =>
    left.filter((child) => child.kind === kind).map((child) => child.name);
  const apps = namesOf("app");
  const serviceInstances = namesOf("service-instance");
  return new SpaceDeleteRefused({
    spaceId: output.spaceId,
    reason: "not-empty",
    apps,
    serviceInstances,
    message: `Space ${output.name} still has apps (${apps.join(", ") || "none"}) and service instances (${serviceInstances.join(", ") || "none"}), and deleting it may delete them. ${remedy}`,
  });
};

/**
 * A replacement ends in the old space's delete, which sees the props it was deployed with. So
 * nothing can opt in after this point: refuse at plan what that delete is sure to refuse, where
 * nothing has happened yet. A create-first replacement deletes this stack's own first, so only a
 * delete-first one is sure to find them.
 */
const refuseReplacement = (args: {
  readonly id: string;
  readonly olds: SpaceProps | undefined;
  readonly output: SpaceAttributes;
  readonly deleteFirst: boolean;
}) =>
  Effect.gen(function* () {
    const { id, olds, output, deleteFirst } = args;
    if (olds?.forceDestroy === true) return;
    const scope = { projectId: output.projectId, region: output.region };
    const live = yield* getSpaceOrUndefined(scope, output.organizationId, output.spaceId);
    if (live === undefined) return;
    const remedy =
      "This change replaces the space, so nothing was changed. Deploy forceDestroy: true on it on its own first, then make this change.";
    const credentials = olds?.credentials;
    if (!usableCredentials(credentials)) return yield* noCredentialsError(output, remedy);
    if (!deleteFirst) return;
    const left = yield* listContents(output.spaceId).pipe(withCloudFoundry(id, credentials));
    if (left.length > 0) return yield* notEmptyError(output, left, remedy);
  });

const toName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: CF_NAME_MAX_LENGTH });

const attrsOf = (scope: ScfScope, space: scf.Space) =>
  getPlatformOrUndefined(scope, space.platformId).pipe(
    Effect.map((platform): SpaceAttributes => ({
      spaceId: space.guid,
      name: space.name,
      organizationId: space.orgId,
      platformId: space.platformId,
      apiUrl: platform?.apiUrl ?? "",
      projectId: space.projectId,
      region: space.region,
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    })),
  );

const findByName = (scope: ScfScope, organizationId: string, name: string) =>
  listAllSpaces(scope, organizationId).pipe(
    Effect.map((spaces) => spaces.find((space) => space.name === name)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const SpaceProvider = () =>
  Provider.succeed(Space, {
    stables: ["spaceId", "organizationId", "platformId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.CloudFoundry.Organization"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const organizations = yield* listAllOrganizations(scope);
      const owned: SpaceAttributes[] = [];
      for (const organization of organizations) {
        if (!isGeneratedName(organization.name)) continue;
        const spaces = yield* listAllSpaces(scope, organization.guid).pipe(
          // The organization may be deleted mid-listing.
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
        for (const space of spaces) {
          if (!isGeneratedName(space.name)) continue;
          const attrs = yield* attrsOf(scope, space);
          owned.push(attrs);
        }
      }
      return owned;
    }),

    diff: Effect.fn(function* ({ id, news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the organization the space is already in, and
      // an explicit name can't exist twice there. A generated name carries the generation.
      if (hasUnresolvedTrigger<SpaceProps>(news, ["organizationId", "projectId", "region"])) {
        const deleteFirst = rawProp<SpaceProps>(news, "name") !== undefined;
        yield* refuseReplacement({ id, olds, output, deleteFirst });
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<SpaceProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.organizationId !== output.organizationId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        yield* refuseReplacement({ id, olds, output, deleteFirst: false });
        return { action: "replace", deleteFirst: false } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const organizationId = output?.organizationId ?? olds?.organizationId;
      if (organizationId === undefined) return undefined;
      let space =
        output?.spaceId !== undefined
          ? yield* getSpaceOrUndefined(scope, organizationId, output.spaceId)
          : undefined;
      if (space === undefined) {
        const name = output?.name ?? (yield* toName(id, olds?.name));
        space = yield* findByName(scope, organizationId, name);
      }
      if (space === undefined) return undefined;
      const attrs = yield* attrsOf(scope, space);
      // A space id only means something in its organization, project and region.
      const isPrevious =
        previous?.spaceId === space.guid &&
        previous.organizationId === organizationId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return output !== undefined || olds?.name === undefined || isPrevious
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const organizationId = news.organizationId;
      const generatedName = yield* toName(id, undefined);
      const name = news.name ?? generatedName;

      // 1. Observe. `output` only speaks for this space where it is.
      let space =
        output?.organizationId === organizationId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? yield* getSpaceOrUndefined(scope, organizationId, output.spaceId)
          : undefined;
      if (space === undefined && name === generatedName) {
        space = yield* findByName(scope, organizationId, name);
      }

      // 2. Ensure
      if (space === undefined) {
        space = yield* scf.createSpace({ ...scope, organizationId, name });
      }
      const spaceId = space.guid;
      const resource = `STACKIT Cloud Foundry space ${name}`;

      // 3. Sync
      if (space.name !== name) {
        yield* scf.updateSpace({ ...scope, organizationId, spaceId, name });
        space = yield* waitFor({
          resource,
          read: scf.getSpace({ ...scope, organizationId, spaceId }),
          ready: (observed) => observed.name === name,
          state: (observed) => observed.name,
          timeout: SPACE_TIMEOUT,
        });
      }

      // 4. Return
      return yield* attrsOf(scope, space);
    }),

    delete: Effect.fn(function* ({ id, olds, output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { organizationId, spaceId } = output;
      const live = yield* getSpaceOrUndefined(scope, organizationId, spaceId);
      if (live === undefined) return;
      // What's in the space may go with it, whoever made it: the prop, or `alchemy unsafe nuke`,
      // is the opt-in. This stack's own are deleted and awaited first.
      if (olds?.forceDestroy !== true && force !== true) {
        const remedy =
          "Delete them first, or deploy forceDestroy: true on the space to allow this. A space already being replaced keeps the props it was deployed with, so only deleting what's in it by hand finishes that replacement.";
        const credentials = olds?.credentials;
        if (!usableCredentials(credentials)) {
          return yield* noCredentialsError(
            output,
            "Give it credentials, or deploy forceDestroy: true on the space to allow this. A space already being replaced keeps the props it was deployed with, so only deleting it by hand finishes that replacement.",
          );
        }
        const left = yield* childrenLeftAfterSettling(listContents(spaceId)).pipe(
          withCloudFoundry(id, credentials),
        );
        if (left.length > 0) return yield* notEmptyError(output, left, remedy);
      }
      yield* scf
        .deleteSpace({ ...scope, organizationId, spaceId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT Cloud Foundry space ${output.name}`,
        read: getSpaceOrUndefined(scope, organizationId, spaceId),
        state: (space) => space.name,
        timeout: SPACE_TIMEOUT,
      });
    }),
  });
