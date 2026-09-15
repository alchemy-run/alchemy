import * as chat from "@distilled.cloud/gcp/chat_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_SPACE_TYPE,
  encodeOwnership,
  encodeOwnershipLine,
  findOwnedSpace,
  getSpace,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listOwnedSpaces,
  MAX_DESCRIPTION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_GUIDELINES_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  spaceIdOf,
  spaceOwnedText,
  toGeneratedName,
  toSpaceName,
  updateMaskOf,
} from "./internal.ts";

export type SpaceDetails = {
  /** Space description. Max 150 characters. */
  description?: string;
  /** Space rules and etiquette. Max 5,000 characters including ownership. */
  guidelines?: string;
};

export type AccessSettings = {
  /** Access state (`PRIVATE` or `DISCOVERABLE`). Output on read. */
  accessState?: chat.AccessSettingsAccessStateEnum | (string & {});
  /**
   * Target audience who can discover the space (`audiences/{audience}`
   * or `audiences/default`).
   */
  audience?: string;
};

export type PermissionSetting = {
  /** Whether assistant managers have this permission. */
  assistantManagersAllowed?: boolean;
  /** Whether space managers have this permission. */
  managersAllowed?: boolean;
  /** Whether basic members have this permission. */
  membersAllowed?: boolean;
};

export type PermissionSettings = {
  /** Who can manage members and groups. */
  manageMembersAndGroups?: PermissionSetting;
  /** Who can toggle history. */
  toggleHistory?: PermissionSetting;
  /** Who can use @all. */
  useAtMentionAll?: PermissionSetting;
  /** Who can reply to messages. */
  replyMessages?: PermissionSetting;
  /** Who can update space details. */
  modifySpaceDetails?: PermissionSetting;
  /** Who can manage webhooks. */
  manageWebhooks?: PermissionSetting;
  /** Who can manage apps. */
  manageApps?: PermissionSetting;
};

export type SpaceProps = {
  /**
   * Resource name `spaces/{space}` or the `{space}` id. Server-assigned
   * on create. Immutable — changing it replaces the space.
   */
  spaceId?: string;
  /**
   * Display name. Required for `SPACE` type (max 128 characters). Chat
   * spaces have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix (stripped from attributes).
   */
  displayName?: string;
  /**
   * Space type. Required on create. Immutable except `GROUP_CHAT` to
   * `SPACE`.
   * @default "SPACE"
   */
  spaceType?: chat.SpaceSpaceTypeEnum | (string & {});
  /**
   * Description and guidelines. Ownership is also stamped into
   * `guidelines` for `list` / nuke.
   */
  spaceDetails?: SpaceDetails;
  /**
   * Message history state (`HISTORY_ON` or `HISTORY_OFF`).
   */
  spaceHistoryState?: chat.SpaceSpaceHistoryStateEnum | (string & {});
  /**
   * Access setting. Only populated for `SPACE` type.
   */
  accessSettings?: AccessSettings;
  /**
   * Create-only predefined permission preset.
   */
  predefinedPermissionSettings?:
    | chat.SpacePredefinedPermissionSettingsEnum
    | (string & {});
  /**
   * Exact permission settings. Replaces the whole set on update.
   */
  permissionSettings?: PermissionSettings;
  /**
   * Whether any Google Chat user may join. Immutable after create.
   */
  externalUserAllowed?: boolean;
  /**
   * Customer id (`customers/{customer}`). App-auth create only.
   */
  customer?: string;
  /**
   * Create the space in import mode.
   */
  importMode?: boolean;
  /**
   * Whether this is a DM between a Chat app and a single human.
   */
  singleUserBotDm?: boolean;
};

export type Space = Resource<
  "GCP.Chat.Space",
  SpaceProps,
  {
    /** Full resource name `spaces/{space}`. */
    name: string;
    /** Space id (last path segment). */
    spaceId: string;
    /** Project id used when the space was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy prefix stripped. */
    displayName: string | undefined;
    /** Space type. */
    spaceType: string | undefined;
    /** Description with no ownership marker. */
    spaceDetails: SpaceDetails | undefined;
    /** History state. */
    spaceHistoryState: string | undefined;
    /** Access settings. */
    accessSettings: AccessSettings | undefined;
    /** Permission settings. */
    permissionSettings: chat.PermissionSettings | undefined;
    /** Threading state. */
    spaceThreadingState: string | undefined;
    /** Whether any Google Chat user may join. */
    externalUserAllowed: boolean | undefined;
    /** Customer id. */
    customer: string | undefined;
    /** Space URI. */
    spaceUri: string | undefined;
    /** Membership counts. */
    membershipCount: chat.MembershipCount | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-active timestamp. */
    lastActiveTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Chat space.
 *
 * Chat spaces have no labels field, so Alchemy stamps ownership into
 * `displayName` and `spaceDetails.guidelines` for `list` / nuke. The
 * space id is identity — changing `spaceId` replaces the space. Display
 * name, details, history, audience, and permission settings update in
 * place. Creating a space requires Chat user or app authentication.
 *
 * ### Creating a Space
 * **Example:** Generated name
 * ```typescript
 * const space = yield* GCP.Chat.Space("Team", {});
 * ```
 *
 * **Example:** Named collaboration space
 * ```typescript
 * const space = yield* GCP.Chat.Space("Team", {
 *   displayName: "Platform",
 *   spaceType: "SPACE",
 *   spaceDetails: { description: "platform on-call" },
 * });
 * ```
 *
 * ### Updating a Space
 * **Example:** Rename and edit guidelines
 * ```typescript
 * const space = yield* GCP.Chat.Space("Team", {
 *   spaceId: existing.spaceId,
 *   displayName: "Platform Eng",
 *   spaceDetails: { description: "platform on-call" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Chat
 */
export const Space = Resource<Space>("GCP.Chat.Space");

export class SpaceNotResolved extends Data.TaggedError(
  "GCP.Chat.SpaceNotResolved",
)<{
  name: string;
}> {}

const detailsOf = (
  details: chat.SpaceDetails | undefined,
): SpaceDetails | undefined => {
  if (details === undefined) return undefined;
  return {
    description: details.description,
    guidelines: parseOwnership(details.guidelines).text,
  };
};

const accessOf = (
  settings: chat.AccessSettings | undefined,
): AccessSettings | undefined => {
  if (settings === undefined) return undefined;
  return {
    accessState: settings.accessState,
    audience: settings.audience,
  };
};

const toAttrs = (space: chat.Space, project: string) => {
  const name = space.name ?? "";
  return {
    name,
    spaceId: spaceIdOf(name),
    project,
    displayName: parseOwnership(space.displayName).text,
    spaceType: space.spaceType,
    spaceDetails: detailsOf(space.spaceDetails),
    spaceHistoryState: space.spaceHistoryState,
    accessSettings: accessOf(space.accessSettings),
    permissionSettings: space.permissionSettings,
    spaceThreadingState: space.spaceThreadingState,
    externalUserAllowed: space.externalUserAllowed,
    customer: space.customer,
    spaceUri: space.spaceUri,
    membershipCount: space.membershipCount,
    createTime: space.createTime,
    lastActiveTime: space.lastActiveTime,
  };
};

const lookupName = (
  spaceId: string | undefined,
  existingName: string | undefined,
) => {
  if (spaceId !== undefined && spaceId.length > 0) {
    return toSpaceName(spaceId);
  }
  if (existingName !== undefined && existingName.length > 0) {
    return toSpaceName(existingName);
  }
  return "";
};

export const SpaceProvider = () =>
  Provider.succeed(Space, {
    stables: ["name", "spaceId", "project", "createTime", "customer"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.spaceId ?? output?.spaceId ?? output?.name;
      if (
        previous !== undefined &&
        news.spaceId !== undefined &&
        toSpaceName(news.spaceId) !== toSpaceName(previous) &&
        news.spaceId !== output?.spaceId &&
        toSpaceName(news.spaceId) !== output?.name
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.spaceType ?? output?.spaceType;
      const nextType = news.spaceType ?? DEFAULT_SPACE_TYPE;
      if (
        previousType !== undefined &&
        previousType !== nextType &&
        !(previousType === "GROUP_CHAT" && nextType === "SPACE")
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = lookupName(olds?.spaceId ?? output?.spaceId, output?.name);
      let existing = yield* getSpace(name);
      if (existing === undefined) {
        existing = yield* findOwnedSpace(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, spaceOwnedText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const spaces = yield* listOwnedSpaces();
        return spaces
          .filter((space) => hasOwnershipMarker(spaceOwnedText(space)))
          .map((space) => toAttrs(space, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* ownershipLabels(id);
      const userDisplayName = yield* toGeneratedName(
        id,
        news.displayName,
        output?.displayName,
        40,
      );
      const displayName = encodeOwnershipLine(
        labels,
        userDisplayName,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const guidelines = encodeOwnership(
        labels,
        news.spaceDetails?.guidelines,
      ).slice(0, MAX_GUIDELINES_LENGTH);
      const description = news.spaceDetails?.description?.slice(
        0,
        MAX_DESCRIPTION_LENGTH,
      );
      const spaceType =
        news.spaceType ?? output?.spaceType ?? DEFAULT_SPACE_TYPE;
      const requestId = yield* toGeneratedName(
        `${id}-req`,
        undefined,
        output?.spaceId,
        63,
      );

      let current = yield* getSpace(
        lookupName(news.spaceId ?? output?.spaceId, output?.name),
      );
      if (current === undefined) {
        current = yield* findOwnedSpace(id);
      }

      if (current === undefined) {
        const created = yield* chat
          .createSpaces({
            requestId,
            body: {
              displayName,
              spaceType,
              spaceDetails: { description, guidelines },
              spaceHistoryState: news.spaceHistoryState,
              accessSettings: news.accessSettings
                ? { audience: news.accessSettings.audience }
                : undefined,
              predefinedPermissionSettings: news.predefinedPermissionSettings,
              externalUserAllowed: news.externalUserAllowed,
              customer: news.customer,
              importMode: news.importMode,
              singleUserBotDm: news.singleUserBotDm,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedSpace(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SpaceNotResolved({
          name:
            lookupName(news.spaceId ?? output?.spaceId, output?.name) ||
            displayName,
        });
      }

      const name = current.name ?? lookupName(output?.spaceId, output?.name);
      const detailsChanged =
        !sameText(current.displayName, displayName) ||
        !sameText(current.spaceDetails?.description, description) ||
        !sameText(current.spaceDetails?.guidelines, guidelines);
      if (detailsChanged) {
        current = yield* chat.patchSpaces({
          name,
          updateMask: updateMaskOf("display_name", "space_details"),
          body: {
            displayName,
            spaceDetails: { description, guidelines },
          },
        });
      }

      const typeChanged =
        spaceType !== (current.spaceType ?? "") &&
        current.spaceType === "GROUP_CHAT" &&
        spaceType === "SPACE";
      if (typeChanged) {
        current = yield* chat.patchSpaces({
          name,
          updateMask: updateMaskOf("space_type", "display_name"),
          body: { spaceType, displayName },
        });
      }

      if (
        news.spaceHistoryState !== undefined &&
        !sameText(current.spaceHistoryState, news.spaceHistoryState)
      ) {
        current = yield* chat.patchSpaces({
          name,
          updateMask: "space_history_state",
          body: { spaceHistoryState: news.spaceHistoryState },
        });
      }

      if (
        news.accessSettings?.audience !== undefined &&
        !sameText(
          current.accessSettings?.audience,
          news.accessSettings.audience,
        )
      ) {
        current = yield* chat.patchSpaces({
          name,
          updateMask: "access_settings.audience",
          body: {
            accessSettings: { audience: news.accessSettings.audience },
          },
        });
      }

      if (
        news.permissionSettings !== undefined &&
        !jsonEqual(current.permissionSettings, {
          ...current.permissionSettings,
          ...news.permissionSettings,
        })
      ) {
        const masks = updateMaskOf(
          news.permissionSettings.manageMembersAndGroups
            ? "permission_settings.manageMembersAndGroups"
            : undefined,
          news.permissionSettings.modifySpaceDetails
            ? "permission_settings.modifySpaceDetails"
            : undefined,
          news.permissionSettings.toggleHistory
            ? "permission_settings.toggleHistory"
            : undefined,
          news.permissionSettings.useAtMentionAll
            ? "permission_settings.useAtMentionAll"
            : undefined,
          news.permissionSettings.manageApps
            ? "permission_settings.manageApps"
            : undefined,
          news.permissionSettings.manageWebhooks
            ? "permission_settings.manageWebhooks"
            : undefined,
          news.permissionSettings.replyMessages
            ? "permission_settings.replyMessages"
            : undefined,
        );
        if (masks.length > 0) {
          current = yield* chat.patchSpaces({
            name,
            updateMask: masks,
            body: { permissionSettings: news.permissionSettings },
          });
        }
      }

      const fresh = (yield* getSpace(name)) ?? current;
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name || toSpaceName(output.spaceId);
      if (name.length === 0) return;
      yield* ignoreMissing(chat.deleteSpaces({ name }));
    }),
  });
