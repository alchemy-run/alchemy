import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  desiredLabels,
  hasAlchemyLabels,
  labelRecord,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { desiredParent } from "./internal.ts";

/** Organizations can't be created through the API, so a missing one is an error. */
export class OrganizationNotFound extends Data.TaggedError(
  "Stackit.ResourceManager.OrganizationNotFound",
)<{
  readonly organizationId: string;
  readonly message: string;
}> {}

export type OrganizationProps = {
  /**
   * Container id or UUID of the organization. Defaults to the profile's
   * organization. Changing it replaces the resource: the old organization
   * loses the labels this resource set, and the new one gains them.
   */
  organizationId?: string;
  /**
   * Organization name, 2-41 characters (letters, digits, `_`, `+`, `&`, `-`,
   * single spaces), starting with a letter or digit. Updated in place. When
   * omitted, the live name is left alone.
   */
  name?: string;
  /**
   * Labels on the organization. Alchemy only touches the keys listed here plus
   * its ownership labels (`alchemy.*`): a key you remove is removed from the
   * organization, and labels set outside Alchemy stay.
   */
  labels?: Record<string, string>;
};

export type Organization = Resource<
  "Stackit.ResourceManager.Organization",
  OrganizationProps,
  {
    /** Organization UUID. */
    organizationId: string;
    /** Globally unique, user-friendly organization id. */
    containerId: string;
    /** Organization name. */
    name: string;
    /** Lifecycle state, e.g. `ACTIVE`. */
    lifecycleState: resourceManager.LifecycleState;
    /** Organization labels, without Alchemy's ownership labels. */
    labels: Record<string, string>;
    /** The user label keys this resource manages. */
    managedLabels: string[];
    /** RFC 3339 creation timestamp. */
    creationTime: string;
  },
  never,
  Providers
>;

/**
 * The settings of an existing STACKIT organization: its name and labels.
 *
 * Organizations are contract objects created in the STACKIT portal, and the API
 * can neither create nor delete them. This resource only adopts one, so the
 * first deploy needs `--adopt` or `adopt(true)`. Destroying it removes the
 * labels it set; the organization, its contents and its current name stay, and
 * `alchemy unsafe nuke` skips this type.
 *
 * Labels on an organization are visible across every stack in it, and
 * organization policies can enforce them. Manage an organization from one stack
 * only, since each stack would overwrite the other's ownership labels.
 *
 * See [STACKIT's Resource Manager docs](https://docs.stackit.cloud/platform/resource-manager/).
 *
 * :::caution[Changing `organizationId` replaces the Organization]
 * Alchemy takes over the other organization's settings and removes the labels it set
 * on the old one. The old organization, its contents and its current name stay.
 * :::
 *
 * ### Adopting an organization
 * **Example:** Label the profile's organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const organization = yield* Stackit.ResourceManager.Organization("Org", {
 *   labels: { costCenter: "cc-1234" },
 * }).pipe(adopt(true));
 * ```
 *
 * **Example:** Rename a specific organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const organization = yield* Stackit.ResourceManager.Organization("Org", {
 *   organizationId: "00000000-0000-0000-0000-000000000000",
 *   name: "Acme Holding",
 * }).pipe(adopt(true));
 * ```
 *
 * ### Placing resources in it
 * **Example:** A folder in the adopted organization
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const organization = yield* Stackit.ResourceManager.Organization("Org", {
 *   labels: { costCenter: "cc-1234" },
 * }).pipe(adopt(true));
 * const folder = yield* Stackit.ResourceManager.Folder("Payments", {
 *   parentId: organization.containerId,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Resource Manager
 * @category Resource Manager
 */
export const Organization = Resource<Organization>("Stackit.ResourceManager.Organization");

const getOrganization = (id: string) =>
  resourceManager.getOrganization({ id }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (
  organization: resourceManager.OrganizationResponse,
  managedLabels: ReadonlyArray<string>,
) => ({
  organizationId: organization.organizationId,
  containerId: organization.containerId,
  name: organization.name,
  lifecycleState: organization.lifecycleState,
  labels: stripInternalLabels(organization.labels),
  managedLabels: [...managedLabels],
  creationTime: organization.creationTime,
});

/**
 * The `labels` field of a PATCH, or `undefined` when nothing changed. The API
 * documents `null` as removing a label, without saying whether it merges or
 * replaces the rest, so the other live labels are sent back unchanged.
 */
const labelsPatch = (
  observed: unknown,
  desired: Record<string, string>,
  previouslyManaged: ReadonlyArray<string>,
): resourceManager.UpdateLabels | undefined => {
  const live = labelRecord(observed);
  const removed = previouslyManaged.filter((key) => !(key in desired) && key in live);
  const changed = Object.entries(desired).some(([key, value]) => live[key] !== value);
  if (!changed && removed.length === 0) return undefined;
  return {
    ...live,
    ...desired,
    ...Object.fromEntries(removed.map((key) => [key, null])),
  };
};

export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: ["organizationId", "containerId", "creationTime"],
    // No delete API: `delete` only removes labels, and `list` would always
    // re-enumerate the organization.
    nuke: { singleton: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the current organization, whose labels
      // must not be removed after its replacement set them.
      if (hasUnresolvedTrigger<OrganizationProps>(news, ["organizationId"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<OrganizationProps>(news);
      const env = yield* StackitEnvironment.current;
      const desired = resolved.organizationId ?? env.organizationId;
      if (
        desired !== undefined &&
        desired !== output.organizationId &&
        desired !== output.containerId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const organizationId = output?.containerId ?? (yield* desiredParent(olds?.organizationId));
      const organization = yield* getOrganization(organizationId);
      if (organization === undefined) return undefined;
      const attrs = toAttrs(organization, output?.managedLabels ?? []);
      // Never created by Alchemy: only state or its labels make it ours.
      return output !== undefined || (yield* hasAlchemyLabels(id, organization.labels))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const organizationId = yield* desiredParent(news.organizationId ?? output?.containerId);

      // Observe — there is nothing to ensure: the API can't create one.
      let current = yield* getOrganization(organizationId);
      if (current === undefined) {
        return yield* new OrganizationNotFound({
          organizationId,
          message: `STACKIT organization ${organizationId} does not exist or is not visible to this profile`,
        });
      }

      // Sync name and labels against the observed organization.
      const desired = yield* desiredLabels(id, news.labels);
      const labels = labelsPatch(current.labels, desired, output?.managedLabels ?? []);
      const rename = news.name !== undefined && current.name !== news.name;
      if (rename || labels !== undefined) {
        current = yield* resourceManager.partialUpdateOrganization({
          id: organizationId,
          name: rename ? news.name : undefined,
          labels,
        });
      }

      return toAttrs(current, Object.keys(toLabels(news.labels)));
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getOrganization(output.containerId);
      if (current === undefined) return;
      const keys = Object.keys(labelRecord(current.labels)).filter(
        (key) => key.startsWith(ALCHEMY_LABEL_PREFIX) || output.managedLabels.includes(key),
      );
      // An empty `keys` removes every label on the organization.
      if (keys.length === 0) return;
      yield* resourceManager.deleteOrganizationLabels({
        containerId: output.containerId,
        keys,
      });
    }),
  });
