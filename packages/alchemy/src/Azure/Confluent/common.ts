import * as confluent from "@distilled.cloud/azure/confluent";
import * as Effect from "effect/Effect";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Case-insensitive comparison for ARM names, groups, and IDs. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

export const getOrganization = (
  subscriptionId: string,
  resourceGroupName: string,
  organizationName: string,
) =>
  orUndefinedIfNotFound(
    confluent.GetOrganization({
      subscriptionId,
      resourceGroupName,
      organizationName,
    }),
  );

/**
 * Whether the organization is tagged as owned by the current stack and
 * stage. Environments, clusters, topics, and connectors cannot carry tags
 * or metadata, so they inherit ownership from their organization.
 */
export const isOrganizationOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  organizationName: string,
) {
  const organization = yield* getOrganization(
    subscriptionId,
    resourceGroupName,
    organizationName,
  );
  if (organization === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(organization.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Location props shared by every organization child. */
export interface OrganizationChildProps {
  /** Resource group of the organization. Changing it replaces the resource. */
  resourceGroup: string;
  /** Name of the Confluent organization. Changing it replaces the resource. */
  organization: string;
}

/** Stable JSON for order-insensitive comparison of plain objects. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
