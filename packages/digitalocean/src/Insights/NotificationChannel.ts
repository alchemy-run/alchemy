import * as DO from "@distilled.cloud/digitalocean";
import type { NotificationChannel as ApiChannel } from "@distilled.cloud/digitalocean";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type NotificationChannelProps = {
  /**
   * Channel name. Updates in place.
   *
   * @default a generated physical name
   */
  name?: string;
} & (
  | {
      /** Send alerts to an email address. */
      email: { to: string };
    }
  | {
      /** Post alerts to a Slack channel through an incoming webhook. */
      slack: { channel: string; webhookUrl: string | Redacted.Redacted<string> };
    }
  | {
      /** POST alerts as JSON to a URL. */
      webhook: {
        url: string;
        /** Sent as `Authorization: Bearer <token>`. */
        bearerToken?: string | Redacted.Redacted<string>;
        /** Extra request headers. */
        headers?: Record<string, string>;
      };
    }
);

export type NotificationChannel = Resource<
  "DigitalOcean.Insights.NotificationChannel",
  NotificationChannelProps,
  {
    /** Channel id. */
    channelId: string;
    /** Channel name. */
    name: string;
    /** `CHANNEL_TYPE_EMAIL`, `CHANNEL_TYPE_SLACK` or `CHANNEL_TYPE_WEBHOOK`. */
    channelType: string;
  },
  never,
  Providers
>;

export type NotificationChannelAttributes = NotificationChannel["Attributes"];

/**
 * Where Insights alert rules send their notifications: an email address, a
 * Slack channel, or a webhook. The name, destination and credentials update
 * in place; changing the kind of destination replaces the channel.
 *
 * ### Creating a Channel
 * **Example:** Email the on-call address
 * ```typescript
 * const oncall = yield* DigitalOcean.Insights.NotificationChannel("oncall", {
 *   email: { to: "oncall@example.com" },
 * });
 * ```
 *
 * **Example:** Post to Slack
 * ```typescript
 * const webhookUrl = yield* Config.Redacted("SLACK_WEBHOOK_URL");
 * yield* DigitalOcean.Insights.NotificationChannel("alerts", {
 *   slack: { channel: "#alerts", webhookUrl },
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Insights
 *
 * @resource
 * @product Insights
 * @category Observability
 */
export const NotificationChannel = Resource<NotificationChannel>(
  "DigitalOcean.Insights.NotificationChannel",
);

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const kindOf = (props: NotificationChannelProps) =>
  "email" in props ? "email" : "slack" in props ? "slack" : "webhook";

const plain = (value: string | Redacted.Redacted<string>) =>
  typeof value === "string" ? value : Redacted.value(value);

const wireOf = (props: NotificationChannelProps) =>
  "email" in props
    ? { email: props.email }
    : "slack" in props
      ? { slack: { channel: props.slack.channel, webhook_url: plain(props.slack.webhookUrl) } }
      : {
          webhook: {
            url: props.webhook.url,
            headers: props.webhook.headers,
            bearer_token:
              props.webhook.bearerToken === undefined
                ? undefined
                : { token: plain(props.webhook.bearerToken) },
          },
        };

// Secrets are write-only; a changed one is seen by comparing the props.
const secretOf = (props: NotificationChannelProps | undefined) =>
  props === undefined
    ? undefined
    : "slack" in props
      ? plain(props.slack.webhookUrl)
      : "webhook" in props && props.webhook.bearerToken !== undefined
        ? plain(props.webhook.bearerToken)
        : undefined;

const toAttrs = (channel: ApiChannel): NotificationChannelAttributes => ({
  channelId: channel.id,
  name: channel.name,
  channelType: channel.channel_type,
});

const observe = (channelId: string) =>
  noneIfNotFound(
    DO.getInsightNotificationChannel({ id: channelId }).pipe(
      Effect.map((r) => r.notification_channel),
    ),
  );

const inSync = (observed: ApiChannel, name: string, props: NotificationChannelProps) =>
  observed.name === name &&
  ("email" in props
    ? observed.email?.to === props.email.to
    : "slack" in props
      ? observed.slack?.channel === props.slack.channel
      : observed.webhook?.url === props.webhook.url &&
        JSON.stringify(observed.webhook?.headers ?? {}) ===
          JSON.stringify(props.webhook.headers ?? {}));

export const NotificationChannelProvider = () =>
  Provider.succeed(NotificationChannel, {
    stables: ["channelId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.channelId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (kindOf(news as NotificationChannelProps) !== kindOf(olds)) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const observed =
        output === undefined ? Option.none<ApiChannel>() : yield* observe(output.channelId);
      if (Option.isNone(observed)) {
        const { notification_channel } = yield* DO.createInsightNotificationChannel({
          name,
          ...wireOf(news),
        });
        return toAttrs(notification_channel);
      }
      if (inSync(observed.value, name, news) && secretOf(olds) === secretOf(news)) {
        return toAttrs(observed.value);
      }
      const { notification_channel } = yield* DO.updateInsightNotificationChannel({
        id: observed.value.id,
        name,
        ...wireOf(news),
      });
      return toAttrs(notification_channel);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteInsightNotificationChannel({ id: output.channelId }));
    }),
  });
