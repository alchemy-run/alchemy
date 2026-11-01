import * as StackitBindings from "../StackitBindings.ts";
import type { Organization } from "./Organization.ts";
import type { Space } from "./Space.ts";

/**
 * Shared HTTP scaffolding for Cloud Foundry bindings.
 * NOT exported from index.ts.
 *
 * Each binding grants a custom role with the permission the spec names for the operation
 * (`x-stackit-authorization`), on the project holding the organization, because STACKIT
 * has no role binding on anything narrower (see `StackitBindings`). The role is shared per
 * permission set.
 *
 * These reach the STACKIT control plane. Apps, routes and services are behind the platform's
 * Cloud Foundry API, which takes no STACKIT identity.
 */

/** Build a binding over one operation on an organization. */
export const makeOrganizationHttpBinding = <
  I extends { projectId: string; region: string; organizationId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.CloudFoundry.GetOrganization`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the organization's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (organization: Organization) => ({
      projectId: organization.projectId,
      region: organization.region,
      organizationId: organization.organizationId,
    }),
    grants: (organization) => [
      StackitBindings.grantOn(organization, { permissions: options.permissions }),
    ],
  });

/** Build a binding over one operation on the project and region of an organization. */
export const makeOrganizationProjectHttpBinding = <
  I extends { projectId: string; region: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.CloudFoundry.ListOrganizations`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the organization's project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (organization: Organization) => ({
      projectId: organization.projectId,
      region: organization.region,
    }),
    grants: (organization) => [
      StackitBindings.grantOn(organization, { permissions: options.permissions }),
    ],
  });

/** Build a binding over one operation on the platform an organization is on. */
export const makePlatformHttpBinding = <
  I extends { projectId: string; region: string; platformId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.CloudFoundry.GetPlatform`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the organization's project, region and platform are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (organization: Organization) => ({
      projectId: organization.projectId,
      region: organization.region,
      platformId: organization.platformId,
    }),
    grants: (organization) => [
      StackitBindings.grantOn(organization, { permissions: options.permissions }),
    ],
  });

/** Build a binding over one operation on a space. */
export const makeSpaceHttpBinding = <
  I extends { projectId: string; region: string; organizationId: string; spaceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.CloudFoundry.GetSpace`. */
  tag: string;
  /** The exact permissions the operation needs. */
  permissions: readonly string[];
  /** The distilled operation; the space's project, region, organization and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (space: Space) => ({
      projectId: space.projectId,
      region: space.region,
      organizationId: space.organizationId,
      spaceId: space.spaceId,
    }),
    grants: (space) => [StackitBindings.grantOn(space, { permissions: options.permissions })],
  });
