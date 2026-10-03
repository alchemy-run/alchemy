import * as search from "@distilled.cloud/azure/search";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  stackAndStage,
  waitUntilGone,
} from "../Arm.ts";

/** Resource provider namespace of Azure AI Search. */
export const SEARCH_NAMESPACE = "Microsoft.Search";

/**
 * Deterministic search-scoped name: lowercase letters, digits, and single
 * hyphens, not starting or ending with a hyphen.
 */
export const createSearchName = Effect.fn(function* (
  id: string,
  maxLength = 60,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter: "-",
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
});

export const getSearchService = (
  subscriptionId: string,
  resourceGroupName: string,
  searchServiceName: string,
) =>
  orUndefinedIfNotFound(
    search.GetService({ subscriptionId, resourceGroupName, searchServiceName }),
  );

/**
 * Shared private link resources carry no tags; they belong to the stage
 * that owns their search service.
 */
export const searchServiceOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  searchServiceName: string,
) {
  const service = yield* getSearchService(
    subscriptionId,
    resourceGroupName,
    searchServiceName,
  );
  if (service === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(service.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

export const getSharedPrivateLink = (
  subscriptionId: string,
  resourceGroupName: string,
  searchServiceName: string,
  sharedPrivateLinkResourceName: string,
) =>
  orUndefinedIfNotFound(
    search.GetSharedPrivateLinkResource({
      subscriptionId,
      resourceGroupName,
      searchServiceName,
      sharedPrivateLinkResourceName,
    }),
  );

/**
 * A link cannot be deleted while it is still provisioning (creation takes
 * several minutes), and a search service runs one link operation at a time.
 */
export const whileSharedPrivateLinkBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "SearchSharedPrivateLinkBusy" || e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 60,
} as const;

/** Delete one shared private link and wait until it is gone. */
export const deleteSharedPrivateLink = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  searchServiceName: string,
  sharedPrivateLinkResourceName: string,
) {
  yield* ignoreNotFound(
    search
      .DeleteSharedPrivateLinkResource({
        subscriptionId,
        resourceGroupName,
        searchServiceName,
        sharedPrivateLinkResourceName,
      })
      .pipe(Effect.retry(whileSharedPrivateLinkBusy)),
  );
  yield* waitUntilGone(
    `shared private link ${sharedPrivateLinkResourceName}`,
    getSharedPrivateLink(
      subscriptionId,
      resourceGroupName,
      searchServiceName,
      sharedPrivateLinkResourceName,
    ),
    { interval: "10 seconds", times: 60 },
  );
});

/**
 * Azure refuses to delete a search service that still has shared private
 * links (`LockedSPLResourceFound`) once their target is gone, so links are
 * removed before their service.
 */
export const deleteAllSharedPrivateLinks = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  searchServiceName: string,
) {
  const page = yield* orUndefinedIfNotFound(
    search
      .ListSharedPrivateLinkResourceByService({
        subscriptionId,
        resourceGroupName,
        searchServiceName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListSharedPrivateLinkResourceByService", page),
        ),
      ),
  );
  for (const link of page?.value ?? []) {
    if (link.name === undefined) continue;
    yield* deleteSharedPrivateLink(
      subscriptionId,
      resourceGroupName,
      searchServiceName,
      link.name,
    );
  }
});
