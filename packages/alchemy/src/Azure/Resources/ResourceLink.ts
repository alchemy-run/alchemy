import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import {
  descriptionWithMarker,
  descriptionWithoutMarker,
  MARKER,
  ownershipMarker,
} from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./Shared.ts";

export interface ResourceLinkProps {
  /**
   * ARM ID of the source resource the link belongs to. Changing it
   * replaces the link.
   */
  sourceId: string;
  /**
   * ARM ID of the target resource. ARM cannot retarget a link, so changing
   * it replaces the link.
   */
  targetId: string;
  /**
   * Name of the link, unique per source resource. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the link.
   */
  name?: string;
  /**
   * Notes about the link. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because links have no tags.
   */
  notes?: string;
}

export interface ResourceLink extends Resource<
  "Azure.Resources.ResourceLink",
  ResourceLinkProps,
  {
    /** Name of the link. */
    linkName: string;
    /** ARM ID, `{sourceId}/providers/Microsoft.Resources/links/{name}`. */
    linkId: string;
    /** Source resource ID. */
    sourceId: string;
    /** Target resource ID. */
    targetId: string;
    /** User notes (ownership marker removed). */
    notes: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure resource link — a directional, informational relationship
 * between two resources (for example an app and the database it uses),
 * visible in the portal and queryable through the links API.
 *
 * Links cannot be tagged, so Alchemy records ownership as a
 * `[alchemy <stack>/<stage>/<id>]` marker at the end of the notes.
 *
 * @see https://learn.microsoft.com/rest/api/resources/resource-links
 *
 * ### Linking Resources
 * **Example:** Link an identity to the storage account it uses
 * ```typescript
 * yield* Azure.Resources.ResourceLink("api-uses-files", {
 *   sourceId: identity.identityId,
 *   targetId: account.storageAccountId,
 *   notes: "api reads uploads",
 * });
 * ```
 *
 * @resource
 */
export const ResourceLink = Resource<ResourceLink>(
  "Azure.Resources.ResourceLink",
);

const linkNameOf = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id });

const linkIdOf = (sourceId: string, name: string) =>
  `${sourceId.replace(/\/+$/, "")}/providers/Microsoft.Resources/links/${name}`;

const getLink = (linkId: string) =>
  orUndefinedIfNotFound(
    resources.GetResourceLink({ linkId: linkId.replace(/^\/+/, "") }),
  );

const toAttrs = (
  linkId: string,
  name: string,
  observed: resources.ResourceLink,
): ResourceLink["Attributes"] => ({
  linkName: name,
  linkId: observed.id ?? linkId,
  // ARM echoes the source id with a trailing slash.
  sourceId: (
    observed.properties?.sourceId ??
    linkId.replace(/\/providers\/Microsoft\.Resources\/links\/[^/]+$/i, "")
  ).replace(/\/+$/, ""),
  targetId: (observed.properties?.targetId ?? "").replace(/\/+$/, ""),
  notes: descriptionWithoutMarker(observed.properties?.notes),
});

export const ResourceLinkProvider = () =>
  Provider.succeed(ResourceLink, {
    stables: ["linkName", "linkId", "sourceId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resources
        .ListResourceLinkAtSubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListResourceLinkAtSubscription", page),
          ),
        );
      return page.value.flatMap((link) =>
        link.id !== undefined &&
        link.name !== undefined &&
        MARKER.test(link.properties?.notes ?? "")
          ? [toAttrs(link.id, link.name, link)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news)) {
        return !("sourceId" in news) ||
          !isResolved(news.sourceId) ||
          !("targetId" in news) ||
          !isResolved(news.targetId)
          ? ({ action: "replace" } as const)
          : undefined;
      }
      if (
        !sameId(news.sourceId, output.sourceId) ||
        !sameId(news.targetId, output.targetId) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.linkName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const sourceId = output?.sourceId ?? olds?.sourceId;
      if (sourceId === undefined) return undefined;
      const name = output?.linkName ?? (yield* linkNameOf(id, olds?.name));
      const linkId = output?.linkId ?? linkIdOf(sourceId, name);
      const observed = yield* getLink(linkId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(linkId, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.notes ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Resources");
      const name = output?.linkName ?? (yield* linkNameOf(id, news.name));
      const linkId = linkIdOf(news.sourceId, name);
      const notes = descriptionWithMarker(
        news.notes,
        yield* ownershipMarker(id),
      );

      // Observe.
      let observed = yield* getLink(linkId);

      // ARM rejects retargeting an existing link (409 Conflict), so a link
      // observed with another target (e.g. on adoption) is recreated.
      if (
        observed !== undefined &&
        !sameId(observed.properties?.targetId, news.targetId)
      ) {
        yield* ignoreNotFound(
          resources.DeleteResourceLink({ linkId: linkId.replace(/^\/+/, "") }),
        );
        yield* waitUntilGone(`resource link ${name}`, getLink(linkId));
        observed = undefined;
      }

      // Ensure + sync notes with one idempotent PUT, skipped when they
      // already match.
      if (observed === undefined || observed.properties?.notes !== notes) {
        yield* resources.ResourceLinksCreateOrUpdate({
          linkId: linkId.replace(/^\/+/, ""),
          properties: { targetId: news.targetId, notes },
        });
      }

      const fresh = yield* waitForProvisioned(
        `resource link ${name}`,
        getLink(linkId),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(linkId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        resources.DeleteResourceLink({
          linkId: output.linkId.replace(/^\/+/, ""),
        }),
      );
      yield* waitUntilGone(
        `resource link ${output.linkName}`,
        getLink(output.linkId),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
