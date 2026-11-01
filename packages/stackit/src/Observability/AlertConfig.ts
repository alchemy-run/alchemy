import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  ALERT_WEBHOOK_RECEIVER_PREFIX,
  asRedacted,
  assertNoMaskedSecrets,
  CONFIG_TIMEOUT,
  dropsMember,
  isInstanceGone,
  matches,
  withAlertConfigLock,
  type InstanceScope,
} from "./internal.ts";

const isWebhookReceiver = (name: string) => name.startsWith(ALERT_WEBHOOK_RECEIVER_PREFIX);

/** Send alerts by e-mail. */
export interface AlertEmailConfig {
  /** Address to notify. */
  to: string;
  /** Sender address. */
  from?: string;
  /** SMTP host and port. */
  smarthost?: string;
  /** SMTP username. */
  authUsername?: string;
  /** SMTP password. */
  authPassword?: string | Redacted.Redacted<string>;
  /** SMTP identity. */
  authIdentity?: string;
  /** Also notify when an alert resolves. */
  sendResolved?: boolean;
}

/** Send alerts to Opsgenie. */
export interface AlertOpsgenieConfig {
  /** Opsgenie API key. */
  apiKey?: string | Redacted.Redacted<string>;
  /** Opsgenie API host. */
  apiUrl?: string;
  /** Priority, from `P1` to `P5`. */
  priority?: string;
  /** Comma-separated tags. */
  tags?: string;
  /** Also notify when an alert resolves. */
  sendResolved?: boolean;
}

/** POST alerts to a URL. */
export interface AlertWebhookConfig {
  /** Where to POST. STACKIT's API has no way to sign a request, so a token in this URL is how it proves itself. */
  url: string | Redacted.Redacted<string>;
  /** Format the request for Microsoft Teams. Not with `googleChat`. */
  msTeams?: boolean;
  /** Format the request for Google Chat. Not with `msTeams`. */
  googleChat?: boolean;
  /** Also notify when an alert resolves. */
  sendResolved?: boolean;
}

/** Somewhere alerts can go. */
export interface AlertReceiver {
  /** Name of the receiver, unique on the instance, of `a-zA-Z0-9-`. */
  name: string;
  /** E-mail targets. */
  emailConfigs?: AlertEmailConfig[];
  /** Opsgenie targets. */
  opsgenieConfigs?: AlertOpsgenieConfig[];
  /** Webhook targets. */
  webHookConfigs?: AlertWebhookConfig[];
}

/** A child of the root route. */
export interface AlertChildRoute {
  /** Receiver of the alerts this route matches. */
  receiver: string;
  /** Matchers an alert has to fulfil, such as `severity="critical"`. At most 5. */
  matchers?: string[];
  /** Labels alerts are batched by. */
  groupBy?: string[];
  /** How long to wait before the first notification of a group. */
  groupWait?: string;
  /** How long to wait before notifying about new alerts in a group already notified. */
  groupInterval?: string;
  /** How long to wait before sending a notification again. */
  repeatInterval?: string;
  /** Keep matching later siblings after this one. */
  continue?: boolean;
}

/** The root of the routing tree: every alert starts here. */
export interface AlertRoute {
  /** Receiver of the alerts no child route takes. */
  receiver: string;
  /** Labels alerts are batched by. */
  groupBy?: string[];
  /** How long to wait before the first notification of a group. */
  groupWait?: string;
  /** How long to wait before notifying about new alerts in a group already notified. */
  groupInterval?: string;
  /** How long to wait before sending a notification again. */
  repeatInterval?: string;
  /** Routes tried in order. */
  routes?: AlertChildRoute[];
}

/** Defaults every receiver can use. The API only updates this block as a whole. */
export interface AlertGlobal {
  /** How long until an alert with no end time counts as resolved. */
  resolveTimeout?: string;
  /** Default Opsgenie API key. */
  opsgenieApiKey?: string | Redacted.Redacted<string>;
  /** Default Opsgenie API host. */
  opsgenieApiUrl?: string;
  /** Default sender address. */
  smtpFrom?: string;
  /** Default SMTP host and port. */
  smtpSmarthost?: string;
  /** Default SMTP username. */
  smtpAuthUsername?: string;
  /** Default SMTP password. */
  smtpAuthPassword?: string | Redacted.Redacted<string>;
  /** Default SMTP identity. */
  smtpAuthIdentity?: string;
}

/** Mute some alerts while others fire. */
export interface AlertInhibitRule {
  /** Labels that have to be equal in the source and the target alert. */
  equal?: string[];
  /** Labels an alert has to have to mute others. */
  sourceMatch?: Record<string, string>;
  /** Regular expressions an alert has to match to mute others. */
  sourceMatchRe?: Record<string, string>;
  /** Labels of the alerts to mute. */
  targetMatch?: Record<string, string>;
  /** Regular expressions of the alerts to mute. */
  targetMatchRe?: Record<string, string>;
}

export interface AlertConfigProps {
  /** Id of the instance whose alerting this configures. Changing it replaces the configuration. */
  instanceId: string;
  /** Where alerts can go. Updates in place. */
  receivers: AlertReceiver[];
  /** Which receiver gets which alert. Updates in place. */
  route: AlertRoute;
  /** Receiver defaults. Updates in place, as a whole; omit to leave them as they are. */
  global?: AlertGlobal;
  /**
   * An inhibition rule. Updates in place; omit to leave the live one as it is.
   *
   * The API's update takes one rule, without `sourceMatchers` or `targetMatchers`, though
   * it reads back as a list. So an instance holding more than one rule, or a rule with
   * matchers, can't be written without losing them, and the deploy fails with
   * `Stackit.Observability.InhibitRulesWouldBeLost` unless `replaceInhibitRules` is set.
   */
  inhibitRule?: AlertInhibitRule;
  /**
   * Accept that writing the configuration, and restoring it on delete, keeps only one
   * inhibition rule, without its matchers. The rules the API's update can't express are
   * lost, and alerts they muted start firing.
   *
   * @default false
   */
  replaceInhibitRules?: boolean;
  /** Project that owns the instance. Changing it replaces the configuration. @default the profile's project */
  projectId?: string;
}

/** The configuration found before Alchemy's first write, restored on delete. */
export interface CapturedAlertConfig {
  /** Receiver defaults, secrets `Redacted`. */
  global: observability.Global | undefined;
  /** Inhibition rules. */
  inhibitRules: observability.InhibitRules[] | undefined;
  /** Receivers, secrets `Redacted`. */
  receivers: observability.Receivers[];
  /** The routing tree. */
  route: observability.Route;
}

export interface AlertConfigAttributes {
  /** Id of the instance whose alerting this configures. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Names of the receivers. Their secrets stay out of the attributes. */
  receivers: string[];
  /** The routing tree, as live. */
  route: observability.Route;
  /** How long until an alert with no end time counts as resolved. */
  resolveTimeout: string | undefined;
  /** The configuration found before Alchemy's first write, restored on delete. */
  captured: CapturedAlertConfig;
}

/** A write would drop inhibition rules that the API's update can't express. */
export class InhibitRulesWouldBeLost extends Data.TaggedError(
  "Stackit.Observability.InhibitRulesWouldBeLost",
)<{
  readonly instanceId: string;
  /** The live or kept rules, as JSON. */
  readonly rules: ReadonlyArray<string>;
  readonly message: string;
}> {}

export type AlertConfig = Resource<
  "Stackit.Observability.AlertConfig",
  AlertConfigProps,
  AlertConfigAttributes,
  never,
  Providers
>;

/**
 * The Alertmanager configuration of a `Stackit.Observability.Instance`: its receivers,
 * its routing tree and their defaults. There is one per instance. The instance's
 * Terraform resource nests this; here it is separate, so a receiver can take an output
 * of something that depends on the instance.
 *
 * It is a singleton, so Alchemy doesn't create or delete it. The first deploy keeps the
 * configuration it finds, deploys write only what differs, and deleting the resource
 * writes the kept configuration back. Don't declare two on one instance. The API's update
 * can only write one inhibition rule, without matchers, so a configuration holding others
 * fails with `Stackit.Observability.InhibitRulesWouldBeLost` rather than losing them, on a
 * write or on the restore: set `replaceInhibitRules` to accept that.
 *
 * The API only reads and writes the whole configuration, so this resource owns all of
 * it, except for what `Stackit.Observability.AlertWebhook` and `consumeAlerts` add:
 * their receivers and routes are carried along. Secrets stay out of the attributes
 * that describe the live configuration, and stay `Redacted` in the kept one.
 *
 * ### Routing Alerts
 * **Example:** Mail the team, and page on critical alerts
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const opsgenieKey = yield* Config.redacted("OPSGENIE_KEY");
 * const alerts = yield* Stackit.Observability.AlertConfig("Alerts", {
 *   instanceId: instance.instanceId,
 *   receivers: [
 *     { name: "team", emailConfigs: [{ to: "team@example.com" }] },
 *     { name: "pager", opsgenieConfigs: [{ apiKey: opsgenieKey, priority: "P1" }] },
 *   ],
 *   route: {
 *     receiver: "team",
 *     groupBy: ["alertname"],
 *     routes: [{ receiver: "pager", matchers: ['severity="critical"'] }],
 *   },
 * });
 * ```
 *
 * ### Sending to a Webhook
 * **Example:** Post to a chat, with the URL from a redacted config value
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const url = yield* Config.redacted("CHAT_WEBHOOK_URL");
 * const alerts = yield* Stackit.Observability.AlertConfig("Alerts", {
 *   instanceId: instance.instanceId,
 *   receivers: [{ name: "chat", webHookConfigs: [{ url, googleChat: true }] }],
 *   route: { receiver: "chat" },
 * });
 * ```
 *
 * ### Setting Defaults
 * **Example:** One SMTP server for every e-mail receiver
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const smtpAuthPassword = yield* Config.redacted("SMTP_PASSWORD");
 * const alerts = yield* Stackit.Observability.AlertConfig("Alerts", {
 *   instanceId: instance.instanceId,
 *   global: {
 *     smtpFrom: "alerts@example.com",
 *     smtpSmarthost: "smtp.example.com:587",
 *     smtpAuthUsername: "alerts",
 *     smtpAuthPassword,
 *   },
 *   receivers: [{ name: "team", emailConfigs: [{ to: "team@example.com" }] }],
 *   route: { receiver: "team" },
 * });
 * ```
 *
 * ### Keeping Inhibition Rules
 * **Example:** Accept losing the rules the API's update can't write
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Without this, an instance with two rules, or one with matchers, stops the deploy.
 * const instance = yield* Stackit.Observability.Instance("Metrics", {});
 * const alerts = yield* Stackit.Observability.AlertConfig("Alerts", {
 *   instanceId: instance.instanceId,
 *   receivers: [{ name: "team", emailConfigs: [{ to: "team@example.com" }] }],
 *   route: { receiver: "team" },
 *   inhibitRule: {
 *     equal: ["alertname"],
 *     sourceMatch: { severity: "critical" },
 *     targetMatch: { severity: "warning" },
 *   },
 *   replaceInhibitRules: true,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving to another instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The new instance is configured, and the old one gets back the configuration it
 * // had before Alchemy's first write.
 * const instance = yield* Stackit.Observability.Instance("OtherMetrics", {});
 * const alerts = yield* Stackit.Observability.AlertConfig("Alerts", {
 *   instanceId: instance.instanceId,
 *   receivers: [{ name: "team", emailConfigs: [{ to: "team@example.com" }] }],
 *   route: { receiver: "team" },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Observability
 * @category Observability
 */
export const AlertConfig = Resource<AlertConfig>("Stackit.Observability.AlertConfig");

const isChildOfWebhook = (route: { readonly receiver?: string }) =>
  route.receiver !== undefined && isWebhookReceiver(route.receiver);

const withoutWebhooks = (config: observability.Alert): CapturedAlertConfig => ({
  global: config.global,
  inhibitRules: config.inhibitRules,
  receivers: config.receivers.filter((receiver) => !isWebhookReceiver(receiver.name)),
  route: {
    ...config.route,
    routes: config.route.routes?.filter((route) => !isChildOfWebhook(route)),
  },
});

const redactReceiver = (receiver: AlertReceiver) => ({
  ...receiver,
  emailConfigs: receiver.emailConfigs?.map((config) => ({
    ...config,
    authPassword: asRedacted(config.authPassword),
  })),
  opsgenieConfigs: receiver.opsgenieConfigs?.map((config) => ({
    ...config,
    apiKey: asRedacted(config.apiKey),
  })),
  webHookConfigs: receiver.webHookConfigs?.map((config) => ({
    ...config,
    url: asRedacted(config.url),
  })),
});

/** What the live configuration should hold, in its own shape. */
const desiredConfig = (
  news: AlertConfigProps,
  keptReceivers: ReadonlyArray<observability.Receivers>,
  keptRoutes: ReadonlyArray<observability.RouteSerializer>,
) => ({
  receivers: [...news.receivers.map(redactReceiver), ...keptReceivers],
  route: {
    ...news.route,
    // Written out so that removing all child routes counts as drift. Routes are tried
    // in order, and a webhook's route has `continue: true`, so it goes first.
    routes: [...keptRoutes, ...(news.route.routes ?? [])],
  },
  global:
    news.global === undefined
      ? undefined
      : {
          ...news.global,
          opsgenieApiKey: asRedacted(news.global.opsgenieApiKey),
          smtpAuthPassword: asRedacted(news.global.smtpAuthPassword),
        },
  inhibitRules: news.inhibitRule === undefined ? undefined : [news.inhibitRule],
});

/** The API's root route takes no `matchers`, so they don't go back with it. */
const routeRequest = (route: observability.Route): observability.UpdateAlertConfigsRequestRoute => {
  const { matchers: _matchers, ...rest } = route;
  return rest;
};

/** Rules a write would lose: the API's update takes one rule, with no field for matchers. */
const unwritableInhibitRules = (
  rules: ReadonlyArray<observability.InhibitRules> | undefined,
): ReadonlyArray<observability.InhibitRules> => {
  const live = rules ?? [];
  if (live.length > 1) return live;
  return live.filter(
    (rule) => (rule.sourceMatchers?.length ?? 0) > 0 || (rule.targetMatchers?.length ?? 0) > 0,
  );
};

const inhibitRulesWouldBeLost = (
  instanceId: string,
  rules: ReadonlyArray<observability.InhibitRules>,
) => {
  const named = rules.map((rule) => JSON.stringify(rule));
  return new InhibitRulesWouldBeLost({
    instanceId,
    rules: named,
    message: `STACKIT Observability instance ${instanceId} holds inhibition rules the API's update can't write back: ${named.join(", ")}. Writing would keep one rule without its matchers, and alerts the others mute would start firing. Set replaceInhibitRules to accept that.`,
  });
};

/** The API's update takes one rule, and has no field for matchers on it. */
const inhibitRequest = (
  rules: ReadonlyArray<observability.InhibitRules> | undefined,
): observability.UpdateAlertConfigsRequestInhibitRules | undefined => {
  const rule = rules?.[0];
  if (rule === undefined) return undefined;
  const { sourceMatchers: _sourceMatchers, targetMatchers: _targetMatchers, ...rest } = rule;
  return rest;
};

const toAttrs = (
  scope: InstanceScope,
  config: observability.Alert,
  captured: CapturedAlertConfig,
): AlertConfigAttributes => ({
  instanceId: scope.instanceId,
  projectId: scope.projectId,
  receivers: config.receivers.map((receiver) => receiver.name),
  route: config.route,
  resolveTimeout: config.global?.resolveTimeout,
  captured,
});

export const AlertConfigProvider = () =>
  Provider.succeed(AlertConfig, {
    stables: ["instanceId", "projectId"],
    nuke: { dependsOn: ["Stackit.Observability.Instance"] },

    // A singleton that goes with its instance: there is nothing to list.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the same instance, whose one configuration both
      // generations would own: restore first, so the new one captures what is underneath.
      if (hasUnresolvedTrigger<AlertConfigProps>(news, ["instanceId", "projectId"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const env = yield* StackitEnvironment.current;
      const resolved = triggerProps<AlertConfigProps>(news);
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    // A singleton always exists, so finding one says nothing about who wrote it: only
    // state does. That also means a crash between the first write and the state write
    // loses what was captured, and the next deploy captures Alchemy's own configuration.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      if (yield* isInstanceGone(scope)) return undefined;
      const { data } = yield* observability.getAlertConfigs(scope);
      return toAttrs(scope, data, output.captured);
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const scope = { projectId, instanceId: news.instanceId };

      return yield* Effect.gen(function* () {
        // 1. Observe. What was captured only speaks for this instance.
        const { data: observed } = yield* observability.getAlertConfigs(scope);
        const captured =
          output?.instanceId === news.instanceId && output.projectId === projectId
            ? output.captured
            : withoutWebhooks(observed);

        // 2. There is nothing to ensure: every instance has a configuration.

        // 3. Sync — the whole configuration, only when it differs from what is live.
        const keptReceivers = observed.receivers.filter((receiver) =>
          isWebhookReceiver(receiver.name),
        );
        const keptRoutes = (observed.route.routes ?? []).filter(isChildOfWebhook);
        const desired = desiredConfig(news, keptReceivers, keptRoutes);
        // The API falls back to its defaults when this is left out, so what isn't
        // declared goes back as it is live.
        const global = desired.global ?? observed.global;

        // What goes back as it was read, and what the delete writes.
        yield* assertNoMaskedSecrets(news.instanceId, {
          keptReceivers,
          ...(desired.global === undefined ? { global } : {}),
          captured,
        });

        let config = observed;
        // A member removed from the props isn't compared, so it has to force the write.
        const dropped =
          dropsMember(olds?.route, news.route) ||
          dropsMember(olds?.receivers, news.receivers) ||
          dropsMember(olds?.global, news.global) ||
          dropsMember(olds?.inhibitRule, news.inhibitRule);
        if (!matches(desired, observed) || dropped) {
          const lost = unwritableInhibitRules(observed.inhibitRules);
          if (lost.length > 0 && news.replaceInhibitRules !== true) {
            return yield* inhibitRulesWouldBeLost(news.instanceId, lost);
          }
          yield* observability.updateAlertConfigs({
            ...scope,
            receivers: desired.receivers,
            route: desired.route,
            ...(global !== undefined ? { global } : {}),
            ...withInhibit(news.inhibitRule ?? inhibitRequest(observed.inhibitRules)),
          });
          // The write answers 202 and reports no status: only the desired values finish it.
          const { data } = yield* waitFor({
            resource: `Alert configuration of STACKIT Observability instance ${news.instanceId}`,
            read: observability.getAlertConfigs(scope),
            ready: ({ data }) => matches(desired, data, { ignoreSecrets: true }),
            timeout: CONFIG_TIMEOUT,
          });
          config = data;
        }

        // 4. Return
        return toAttrs(scope, config, captured);
      }).pipe(withAlertConfigLock(scope));
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      yield* Effect.gen(function* () {
        if (yield* isInstanceGone(scope)) return;
        const { captured } = output;
        // What the API can't write back was only taken with the opt-in.
        const lost = unwritableInhibitRules(captured.inhibitRules);
        if (lost.length > 0) {
          if (olds?.replaceInhibitRules !== true && force !== true) {
            return yield* inhibitRulesWouldBeLost(output.instanceId, lost);
          }
          yield* Effect.logWarning(
            `STACKIT Observability instance ${output.instanceId}: restoring one inhibition rule of ${lost.length}, without matchers, as replaceInhibitRules accepted.`,
          );
        }
        // Webhooks added since aren't this resource's to remove.
        const { data: observed } = yield* observability.getAlertConfigs(scope);
        const keptReceivers = observed.receivers.filter((receiver) =>
          isWebhookReceiver(receiver.name),
        );
        const keptRoutes = (observed.route.routes ?? []).filter(isChildOfWebhook);
        yield* assertNoMaskedSecrets(output.instanceId, { keptReceivers, captured });
        const restored = {
          receivers: [...captured.receivers, ...keptReceivers],
          route: routeRequest({
            ...captured.route,
            routes: [...keptRoutes, ...(captured.route.routes ?? [])],
          }),
        };
        yield* observability.updateAlertConfigs({
          ...scope,
          ...restored,
          ...(captured.global !== undefined ? { global: captured.global } : {}),
          ...withInhibit(inhibitRequest(captured.inhibitRules)),
        });
        // A replacement captures next, so it has to see this write.
        yield* waitFor({
          resource: `Alert configuration of STACKIT Observability instance ${output.instanceId}`,
          read: observability.getAlertConfigs(scope),
          ready: ({ data }) => matches(restored, data, { ignoreSecrets: true }),
          timeout: CONFIG_TIMEOUT,
        });
      }).pipe(withAlertConfigLock(scope));
    }),
  });

const withInhibit = (rule: observability.UpdateAlertConfigsRequestInhibitRules | undefined) =>
  rule === undefined ? {} : { inhibitRules: rule };
