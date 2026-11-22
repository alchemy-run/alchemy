import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Client from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";
import type { NotifySettingV2 } from "./Types.ts";

export interface NotificationSettingProps {
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Whether email deploy notifications are enabled for the workspace. */
  emailEnabled?: boolean;
  /** Which events trigger workspace notifications (`"all"`, `"failure"`, or `"none"`). */
  notificationsToSend?: NotifySettingV2;
  /** Whether preview environment deploy notifications are enabled. */
  previewNotificationsEnabled?: boolean;
}

export interface NotificationSettingAttributes {
  /** Workspace/owner ID owning these notification settings. */
  ownerId: string;
  /** Whether email notifications are enabled. */
  emailEnabled: boolean;
  /** Whether Slack notifications are enabled (configured in the Render dashboard). */
  slackEnabled: boolean;
  /** Active workspace notification policy (`"all"`, `"failure"`, or `"none"`). */
  notificationsToSend: NotifySettingV2;
  /** Whether preview notifications are enabled. */
  previewNotificationsEnabled: boolean;
}

export interface NotificationSettingLookup {
  /** Optional owner ID whose workspace notification settings should be read. */
  ownerId?: string;
}

export type NotificationSetting = Resource<
  "Render.NotificationSetting",
  NotificationSettingProps,
  NotificationSettingAttributes,
  never,
  Providers,
  NotificationSettingLookup
>;

/**
 * Configures default deploy notification settings (`emailEnabled`,
 * `notificationsToSend`, `previewNotificationsEnabled`) for a Render workspace.
 *
 * This is a singleton workspace configuration; deleting the Alchemy resource
 * removes it from state without deleting workspace settings on Render.
 *
 * **Example:** Notify only on failures
 * ```typescript
 * yield* Render.NotificationSetting("Notifications", {
 *   emailEnabled: true,
 *   notificationsToSend: "failure",
 *   previewNotificationsEnabled: false,
 * });
 * ```
 *
 * @resource
 * @product Notifications
 * @category Observability & Events
 */
export const NotificationSetting = Resource<NotificationSetting>("Render.NotificationSetting");

export const NotificationSettingProvider = () =>
  Provider.effect(
    NotificationSetting,
    Effect.succeed({
      stables: ["ownerId"],
      nuke: { singleton: true },
      diff: Effect.fn(function* ({ news }) {
        if (!isResolved(news)) return undefined;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const ownerId = output?.ownerId ?? (yield* Client.resolveOwnerId(explicitOwnerId));
        const res = yield* Client.ignoreNotFound(Client.getOwnerNotificationSettings(ownerId));
        return res ?? undefined;
      }),
      lookup: Effect.fn(function* (props) {
        const ownerId = yield* Client.resolveOwnerId(props.ownerId);
        const res = yield* Client.ignoreNotFound(Client.getOwnerNotificationSettings(ownerId));
        return res ?? undefined;
      }),
      list: Effect.fn(function* () {
        return [];
      }),
      reconcile: Effect.fn(function* ({ news }) {
        const ownerId = yield* Client.resolveOwnerId(news.ownerId);
        return yield* Client.patchOwnerNotificationSettings(ownerId, {
          ...(news.emailEnabled !== undefined ? { emailEnabled: news.emailEnabled } : {}),
          ...(news.notificationsToSend !== undefined
            ? { notificationsToSend: news.notificationsToSend }
            : {}),
          ...(news.previewNotificationsEnabled !== undefined
            ? { previewNotificationsEnabled: news.previewNotificationsEnabled }
            : {}),
        });
      }),
      delete: Effect.fn(function* () {
        // Notification settings always exist on a Render owner; delete detaches from state.
      }),
    }),
  );
