import * as adsense from "@distilled.cloud/gcp/adsense_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findCustomChannelByDisplayName,
  findOwnedCustomChannel,
  getCustomChannel,
  hasOwnershipMarker,
  ignoreMissing,
  lastSegment,
  listOwnedCustomChannels,
  MAX_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parentOf,
  parseOwnership,
  replaceOnIdentity,
  resourceName,
  sameBoolean,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type AdclientsCustomchannelProps = {
  /**
   * Parent ad client. Full name
   * `accounts/{account}/adclients/{adclient}`. Immutable — changing it
   * replaces the custom channel.
   */
  parent: string;
  /**
   * Custom channel id (last path segment). Server-assigned on create.
   * Immutable — changing it replaces the custom channel.
   */
  customChannelId?: string;
  /**
   * Human-readable display name (max 80 characters including Alchemy's
   * ownership marker). Custom channels have no labels field, so
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  displayName?: string;
  /**
   * Whether the custom channel is active and collecting data.
   * @default true
   */
  active?: boolean;
};

export type AdclientsCustomchannel = Resource<
  "GCP.Adsense.AdclientsCustomchannel",
  AdclientsCustomchannelProps,
  {
    /** Full resource name `accounts/{account}/adclients/{adclient}/customchannels/{customchannel}`. */
    name: string;
    /** Custom channel id (last path segment). */
    customChannelId: string;
    /** Parent ad client resource name. */
    parent: string;
    /** Project id used when the custom channel was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Whether the custom channel is active. */
    active: boolean | undefined;
    /** Reporting dimension id (`CUSTOM_CHANNEL_ID`). */
    reportingDimensionId: string | undefined;
  },
  never,
  Providers
>;

/**
 * An AdSense custom channel
 * (`accounts/{account}/adclients/{adclient}/customchannels/{customchannel}`).
 *
 * Custom channels have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent ad client and channel id are
 * identity — changing either replaces the channel. Display name and
 * `active` update in place. Create, update, and delete are restricted to
 * AdSense for Platforms projects.
 *
 * ### Creating a Custom Channel
 * **Example:** Generated display name
 * ```typescript
 * const channel = yield* GCP.Adsense.AdclientsCustomchannel("Homepage", {
 *   parent: "accounts/pub-123/adclients/ca-pub-123",
 * });
 * ```
 *
 * **Example:** Named channel
 * ```typescript
 * const channel = yield* GCP.Adsense.AdclientsCustomchannel("Homepage", {
 *   parent: "accounts/pub-123/adclients/ca-pub-123",
 *   displayName: "homepage",
 *   active: true,
 * });
 * ```
 *
 * ### Updating a Custom Channel
 * **Example:** Rename and deactivate
 * ```typescript
 * const channel = yield* GCP.Adsense.AdclientsCustomchannel("Homepage", {
 *   parent: existing.parent,
 *   customChannelId: existing.customChannelId,
 *   displayName: "homepage-v2",
 *   active: false,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Adsense
 */
export const AdclientsCustomchannel = Resource<AdclientsCustomchannel>(
  "GCP.Adsense.AdclientsCustomchannel",
);

export class AdclientsCustomchannelNotResolved extends Data.TaggedError(
  "GCP.Adsense.AdclientsCustomchannelNotResolved",
)<{
  parent: string;
  name: string;
}> {}

const toParent = (value: string) => value.replace(/\/+$/, "").trim();

const lookupName = (
  parent: string,
  customChannelId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName && existingName.length > 0) return existingName;
  if (customChannelId && customChannelId.length > 0 && parent.length > 0) {
    return resourceName(parent, customChannelId);
  }
  return "";
};

const toAttrs = (row: adsense.CustomChannel, project: string) => {
  const name = row.name ?? "";
  return {
    name,
    customChannelId: lastSegment(name),
    parent: parentOf(name),
    project,
    displayName: parseOwnership(row.displayName).text,
    active: row.active,
    reportingDimensionId: row.reportingDimensionId,
  };
};

export const AdclientsCustomchannelProvider = () =>
  Provider.succeed(AdclientsCustomchannel, {
    stables: ["name", "customChannelId", "parent", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousParent: olds?.parent ?? output?.parent,
        nextParent: toParent(news.parent),
        previousId: olds?.customChannelId ?? output?.customChannelId,
        nextId: news.customChannelId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(
        parent,
        olds?.customChannelId ?? output?.customChannelId,
        output?.name,
      );
      let existing = yield* getCustomChannel(name);
      if (existing === undefined) {
        existing = yield* findOwnedCustomChannel(id, parent);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const channels = yield* listOwnedCustomChannels();
        return channels
          .filter((channel) => hasOwnershipMarker(channel.displayName))
          .map((channel) => toAttrs(channel, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toParent(news.parent);
      const ownership = yield* ownershipLabels(id);
      const rawDisplayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        rawDisplayName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const name = lookupName(
        parent,
        news.customChannelId ?? output?.customChannelId,
        output?.name,
      );

      let current = yield* getCustomChannel(name);
      if (current === undefined) {
        current = yield* findOwnedCustomChannel(id, parent);
      }
      if (current === undefined) {
        current = yield* findCustomChannelByDisplayName(displayName, parent);
      }

      if (current === undefined) {
        const created = yield* adsense
          .createAccountsAdclientsCustomchannels({
            parent,
            body: {
              displayName,
              active: news.active ?? true,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findCustomChannelByDisplayName(displayName, parent),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdclientsCustomchannelNotResolved({
          parent,
          name: name || displayName,
        });
      }

      const desiredActive = news.active ?? current.active ?? true;
      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const activeChanged = !sameBoolean(current.active, desiredActive);
      const updateMask = updateMaskOf(
        displayChanged ? "displayName" : undefined,
        activeChanged ? "active" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* adsense.patchAccountsAdclientsCustomchannels({
          name: currentName,
          updateMask,
          body: {
            displayName,
            active: desiredActive,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreMissing(
        adsense.deleteAccountsAdclientsCustomchannels({ name: output.name }),
      );
    }),
  });
