import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  asRedacted,
  CONFIG_DELETE_TIMEOUT,
  CONFIG_TIMEOUT,
  dropsMember,
  generatedWebhookReceiverName,
  isGeneratedWebhookReceiverName,
  isInstanceGone,
  listOwnedInstances,
  matches,
  withAlertConfigLock,
  type InstanceScope,
} from "./internal.ts";

export interface AlertWebhookProps {
  /** Id of the instance whose alerts to send. Changing it replaces the webhook. */
  instanceId: string;
  /**
   * Where to POST the alerts. STACKIT's API has no way to sign a request, so a token in
   * this URL is how the delivery proves itself. Updates in place.
   */
  url: string | Redacted.Redacted<string>;
  /** Matchers an alert has to fulfil, such as `severity="critical"`. At most 5. Updates in place. */
  matchers?: string[];
  /** Labels alerts are batched by. Updates in place. */
  groupBy?: string[];
  /** How long to wait before the first notification of a group. Updates in place. */
  groupWait?: string;
  /** How long to wait before notifying about new alerts in a group already notified. Updates in place. */
  groupInterval?: string;
  /** How long to wait before sending a notification again. Updates in place. */
  repeatInterval?: string;
  /**
   * Also notify when an alert resolves. Updates in place.
   *
   * @default true
   */
  sendResolved?: boolean;
  /** Project that owns the instance. Changing it replaces the webhook. @default the profile's project */
  projectId?: string;
}

export interface AlertWebhookAttributes {
  /** Name of the receiver. The route goes by the same name. */
  receiverName: string;
  /** Id of the instance whose alerts this sends. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
}

export type AlertWebhook = Resource<
  "Stackit.Observability.AlertWebhook",
  AlertWebhookProps,
  AlertWebhookAttributes,
  never,
  Providers
>;

/**
 * A webhook receiver and its route on a `Stackit.Observability.Instance`, added
 * alongside whatever else the instance's Alertmanager has. `consumeAlerts` creates one
 * for a runtime; use it directly to send alerts to a URL you already have without
 * taking over the instance's whole configuration with `Stackit.Observability.AlertConfig`.
 *
 * The route has `continue: true`, so alerts it matches go on to the routes after it. A
 * route before it that matches without `continue` keeps alerts from reaching it.
 *
 * The receiver's generated name starts with `alchemy-webhook-`. That is how an
 * `AlertConfig` on the same instance, which writes the whole configuration, knows to
 * carry it along, so don't give a receiver of your own that prefix.
 *
 * See [STACKIT's Observability docs](https://docs.stackit.cloud/products/logging-and-monitoring/observability/).
 *
 * :::caution[Changing `instanceId` or `projectId` replaces the Webhook]
 * The receiver and route are created on the new instance and removed from the old one.
 * :::
 *
 * ### Sending Alerts to a URL
 * **Example:** Post critical alerts to a URL from a redacted config value
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const url = Config.Redacted("PAGER_WEBHOOK_URL");
 * const webhook = yield* Stackit.Observability.AlertWebhook("Pager", {
 *   instanceId: instance.instanceId,
 *   url,
 *   matchers: ['severity="critical"'],
 *   groupBy: ["alertname"],
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving to another instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * // A new receiver and route are created on the other instance, and the old ones are
 * // deleted. Alerts of the old instance stop reaching the URL.
 * const instance = yield* Stackit.Observability.Instance("OtherMetrics", {});
 * const url = Config.Redacted("PAGER_WEBHOOK_URL");
 * const webhook = yield* Stackit.Observability.AlertWebhook("Pager", {
 *   instanceId: instance.instanceId,
 *   url,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const AlertWebhook = Resource<AlertWebhook>("Stackit.Observability.AlertWebhook");

const findReceiver = (scope: InstanceScope, name: string) =>
  observability
    .listAlertConfigReceivers(scope)
    .pipe(Effect.map(({ data }) => data.find((receiver) => receiver.name === name)));

const findRoute = (scope: InstanceScope, receiver: string) =>
  observability
    .listAlertConfigRoutes(scope)
    .pipe(Effect.map(({ data }) => data.routes?.find((route) => route.receiver === receiver)));

const toAttrs = (scope: InstanceScope, receiverName: string): AlertWebhookAttributes => ({
  receiverName,
  instanceId: scope.instanceId,
  projectId: scope.projectId,
});

/** What the receiver should hold. */
const desiredReceiver = (news: AlertWebhookProps) => ({
  webHookConfigs: [{ url: asRedacted(news.url), sendResolved: news.sendResolved ?? true }],
});

/** The body of the route, written out so that a removed member counts as drift. */
const desiredRoute = (news: AlertWebhookProps) => ({
  continue: true,
  matchers: news.matchers ?? [],
  groupBy: news.groupBy ?? [],
  groupWait: news.groupWait,
  groupInterval: news.groupInterval,
  repeatInterval: news.repeatInterval,
});

/** What goes on the wire: the API has no use for empty lists and unset durations. */
const routeBody = (news: AlertWebhookProps) => ({
  continue: true,
  ...(news.matchers !== undefined ? { matchers: [...news.matchers] } : {}),
  ...(news.groupBy !== undefined ? { groupBy: [...news.groupBy] } : {}),
  ...(news.groupWait !== undefined ? { groupWait: news.groupWait } : {}),
  ...(news.groupInterval !== undefined ? { groupInterval: news.groupInterval } : {}),
  ...(news.repeatInterval !== undefined ? { repeatInterval: news.repeatInterval } : {}),
});

/**
 * The members `matches` doesn't compare when unset, so removing one has to force the update.
 * The API falls back to the parent route's value, and the read-back skips it.
 */
const durationsOf = (props: AlertWebhookProps) => ({
  groupWait: props.groupWait,
  groupInterval: props.groupInterval,
  repeatInterval: props.repeatInterval,
});

const removeWebhook = (scope: InstanceScope, receiver: string) =>
  Effect.gen(function* () {
    // The route first: it names the receiver.
    yield* observability
      .deleteAlertConfigRoute({ ...scope, receiver })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    yield* observability
      .deleteAlertConfigReceiver({ ...scope, receiver })
      .pipe(Effect.catchTag("NotFound", () => Effect.void));
    // Until it reads back gone, an `AlertConfig` writing next would carry it along again.
    yield* waitUntilGone({
      resource: `STACKIT Observability alert webhook ${receiver}`,
      read: Effect.all([findRoute(scope, receiver), findReceiver(scope, receiver)]).pipe(
        Effect.map(([route, found]) => route ?? found),
      ),
      timeout: CONFIG_DELETE_TIMEOUT,
    });
  }).pipe(withAlertConfigLock(scope));

export const AlertWebhookProvider = () =>
  Provider.succeed(AlertWebhook, {
    stables: ["receiverName", "instanceId", "projectId"],
    nuke: { dependsOn: ["Stackit.Observability.Instance"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const projectId = env.projectId;
      const instances = yield* listOwnedInstances(projectId);
      const attrs: AlertWebhookAttributes[] = [];
      for (const instance of instances) {
        const scope = { projectId, instanceId: instance.id };
        if (yield* isInstanceGone(scope)) continue;
        const { data } = yield* observability.listAlertConfigReceivers(scope);
        for (const receiver of data) {
          if (isGeneratedWebhookReceiverName(receiver.name)) {
            attrs.push(toAttrs(scope, receiver.name));
          }
        }
      }
      return attrs;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The receiver's name holds the generation, so a new one can't collide with the old.
      if (hasUnresolvedTrigger<AlertWebhookProps>(news, ["instanceId", "projectId"])) {
        return { action: "replace", deleteFirst: false } as const;
      }
      const env = yield* StackitEnvironment.current;
      const resolved = triggerProps<AlertWebhookProps>(news);
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const scope = { projectId, instanceId };
      if (yield* isInstanceGone(scope)) return undefined;
      // The name is always generated, so a receiver of this name can only be ours.
      const name = output?.receiverName ?? (yield* generatedWebhookReceiverName(id));
      const found = yield* findReceiver(scope, name);
      return found === undefined ? undefined : toAttrs(scope, name);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const scope = { projectId, instanceId: news.instanceId };
      const name = output?.receiverName ?? (yield* generatedWebhookReceiverName(id));
      const resource = `STACKIT Observability alert webhook ${name}`;
      const receiverBody = {
        webHookConfigs: [{ url: news.url, sendResolved: news.sendResolved ?? true }],
      };
      const wantedReceiver = desiredReceiver(news);
      const wantedRoute = desiredRoute(news);
      const droppedDuration =
        olds !== undefined && dropsMember(durationsOf(olds), durationsOf(news));

      return yield* Effect.gen(function* () {
        // 1. Observe
        const receiver = yield* findReceiver(scope, name);

        // 2 and 3. Ensure and sync the receiver, against what is live.
        if (receiver === undefined) {
          yield* observability.createAlertConfigReceiver({ ...scope, name, ...receiverBody });
        } else if (!matches(wantedReceiver, receiver)) {
          yield* observability.updateAlertConfigReceiver({
            ...scope,
            receiver: name,
            name,
            ...receiverBody,
          });
        }
        yield* waitFor({
          resource,
          read: findReceiver(scope, name),
          ready: (live) =>
            live !== undefined && matches(wantedReceiver, live, { ignoreSecrets: true }),
          state: (live) => (live === undefined ? "not visible yet" : "applying"),
          timeout: CONFIG_TIMEOUT,
        });

        // The same for the route, which the API keeps by its receiver's name.
        const route = yield* findRoute(scope, name);
        if (route === undefined) {
          yield* observability.createAlertConfigRoute({
            ...scope,
            receiver: name,
            ...routeBody(news),
          });
        } else if (!matches(wantedRoute, route) || droppedDuration) {
          yield* observability.updateAlertConfigRoute({
            ...scope,
            receiver: name,
            ...routeBody(news),
          });
        }
        yield* waitFor({
          resource,
          read: findRoute(scope, name),
          ready: (live) => live !== undefined && matches(wantedRoute, live),
          state: (live) => (live === undefined ? "route not visible yet" : "applying route"),
          timeout: CONFIG_TIMEOUT,
        });

        // 4. Return
        return toAttrs(scope, name);
      }).pipe(withAlertConfigLock(scope));
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      if (yield* isInstanceGone(scope)) return;
      yield* removeWebhook(scope, output.receiverName);
    }),
  });
