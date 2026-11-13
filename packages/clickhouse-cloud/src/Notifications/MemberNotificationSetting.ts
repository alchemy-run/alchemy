import * as notifications from "@distilled.cloud/clickhouse-cloud/notifications";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import type { Providers } from "../Providers.ts";

/** A delivery channel. */
export type NotificationChannel = "ui" | "email";

export interface MemberNotificationSettingProps {
  /** ID of the organization member, e.g. from `listMembers`. Changing it replaces the resource. */
  userId: string;
  /** Notification types, as `ListNotificationTypes` names them. */
  notifications: string[];
  /**
   * IDs of the resources the setting covers: services, ClickPipes or
   * Postgres services, or the organization ID for organization-level types
   * such as billing. No wildcards: a resource created later is not covered.
   */
  resources: string[];
  /** Channels the setting covers. Omit for every channel. */
  channels?: NotificationChannel[];
  /** Whether the member gets these notifications. */
  effect: "enabled" | "disabled";
}

export interface MemberNotificationSettingAttributes {
  /** Organization ID. */
  organizationId: string;
  /** Member ID. */
  userId: string;
  /** The member's stored settings this resource covers. */
  settings: notifications.NotificationSetting[];
}

export type MemberNotificationSetting = Resource<
  "ClickHouseCloud.Notifications.MemberNotificationSetting",
  MemberNotificationSettingProps,
  MemberNotificationSettingAttributes,
  never,
  Providers
>;

/**
 * One organization member's explicit choice to get, or not get, a set of
 * notification types about a set of resources on some channels. The API
 * stores one setting per type × resource × channel; this resource owns the
 * whole cross product it declares. The endpoints are in public beta.
 *
 * Destroying the resource sets the `inherit` effect on everything it
 * covered, which removes the stored settings so the member follows the
 * platform default for their role again. Types, resources or channels
 * dropped from the props are reset the same way on the next deploy.
 * Changing them needs `control-plane:organization:manage-notification-settings`.
 * @see https://clickhouse.com/docs/cloud/notifications
 *
 * ### Muting Notifications
 * **Example:** No email about a staging service scaling
 * ```typescript
 * const staging = yield* ClickHouseCloud.Service.Service("Staging", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Notifications.MemberNotificationSetting("QuietStaging", {
 *   userId: "<member user id>",
 *   notifications: ["service_horizontal_autoscaling"],
 *   resources: [staging.serviceId],
 *   channels: ["email"],
 *   effect: "disabled",
 * });
 * ```
 *
 * **Example:** Billing thresholds by email
 * ```typescript
 * const org = yield* ClickHouseCloud.Organization.Organization("Org", {});
 * yield* ClickHouseCloud.Notifications.MemberNotificationSetting("CreditAlerts", {
 *   userId: "<member user id>",
 *   notifications: [
 *     "billing_credit_passed_75pc_threshold",
 *     "billing_credit_passed_90pc_threshold",
 *   ],
 *   resources: [org.organizationId],
 *   channels: ["email"],
 *   effect: "enabled",
 * });
 * ```
 *
 * :::caution
 * Changing `userId` replaces the resource: the old member's settings go
 * back to the defaults.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `listMemberNotificationSettings`, `updateMemberNotificationSettings`.
 *
 * @resource
 * @product Notifications
 */
export const MemberNotificationSetting = Resource<MemberNotificationSetting>(
  "ClickHouseCloud.Notifications.MemberNotificationSetting",
);

const CHANNELS: readonly NotificationChannel[] = ["ui", "email"];

/** Every type × resource × channel key a set of props covers. */
const coverage = (props: MemberNotificationSettingProps) =>
  props.notifications.flatMap((type) =>
    props.resources.flatMap((resource) =>
      (props.channels ?? CHANNELS).map((channel) => `${type}\u0000${resource}\u0000${channel}`),
    ),
  );

const keyOf = (s: notifications.NotificationSetting) =>
  `${s.type}\u0000${s.resourceId}\u0000${s.channelType}`;

const listSettings = (organizationId: string, userId: string) =>
  notifications.listMemberNotificationSettings.items({ organizationId, userId }).pipe(
    Stream.runCollect,
    Effect.map((items) => Array.from(items)),
  );

/** Rules that set `inherit` on every key in `keys`, one rule per key. */
const inheritRules = (keys: string[]): notifications.NotificationSettingRule[] =>
  keys.map((key) => {
    const [type, resource, channel] = key.split("\u0000");
    return {
      effect: "inherit",
      notifications: [type!],
      resources: [resource!],
      channels: [channel!],
    };
  });

export const MemberNotificationSettingProvider = () =>
  Provider.effect(
    MemberNotificationSetting,
    Effect.succeed({
      stables: ["organizationId", "userId"],
      // Settings belong to people, not to anything alchemy can list.
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.userId !== olds.userId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const userId = output?.userId ?? olds.userId;
        const covered = new Set(coverage(olds));
        const all = yield* listSettings(organizationId, userId);
        return {
          organizationId,
          userId,
          settings: all.filter((s) => covered.has(keyOf(s))),
        };
      }),
      reconcile: Effect.fn(function* ({ news, olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { userId } = news;
        const wanted = coverage(news);
        // Observe
        const observed = yield* listSettings(organizationId, userId);
        const byKey = new Map(observed.map((s) => [keyOf(s), s.effect]));
        // Sync: reset what the last props covered and these don't, then set
        // the declared effect where it differs.
        const dropped =
          olds === undefined ? [] : coverage(olds).filter((key) => !wanted.includes(key));
        const stale = wanted.some((key) => byKey.get(key) !== news.effect);
        const rules: notifications.NotificationSettingRule[] = [
          ...inheritRules(dropped.filter((key) => byKey.has(key))),
          ...(stale
            ? [
                {
                  effect: news.effect,
                  notifications: news.notifications,
                  resources: news.resources,
                  channels: news.channels ?? [...CHANNELS],
                },
              ]
            : []),
        ];
        if (rules.length > 0) {
          yield* notifications.updateMemberNotificationSettings({ organizationId, userId, rules });
        }
        const covered = new Set(wanted);
        const after = rules.length > 0 ? yield* listSettings(organizationId, userId) : observed;
        const settings = after.filter((s) => covered.has(keyOf(s)));
        return { organizationId, userId, settings };
      }),
      delete: Effect.fn(function* ({ olds, output }) {
        // `inherit` over the whole cross product the props covered.
        yield* notifications
          .updateMemberNotificationSettings({
            organizationId: output.organizationId,
            userId: output.userId,
            rules: [
              {
                effect: "inherit",
                notifications: olds.notifications,
                resources: olds.resources,
                channels: olds.channels ?? [...CHANNELS],
              },
            ],
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
