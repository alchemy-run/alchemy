import * as waf from "@distilled.cloud/stackit/alb_waf";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { StackitEnvironment } from "../Environment.ts";
import {
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { retryWhileInUse } from "../internal/wait.ts";
import {
  desiredLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
  systemLabels,
  withoutSystemLabels,
} from "../Labels.ts";
import { LOAD_BALANCER_SERVICE_ID, physicalName } from "../LoadBalancer/internal.ts";
import type { Providers } from "../Providers.ts";
import { getConfigurationOrUndefined, listAllConfigurations } from "./internal.ts";

export interface ConfigurationProps extends ProjectScopedProps {
  /**
   * Name of the configuration, the API's key for it: 1-63 characters of
   * `[0-9a-z-]`. Changing it replaces the configuration.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Custom rules to apply, e.g. `group.ruleGroupName`. STACKIT requires the rule
   * group to exist first. Updated in place.
   */
  customRuleGroupName?: string;
  /**
   * Managed rules to apply, e.g. `rules.ruleSetName`. STACKIT requires the rule
   * set to exist first. Updated in place.
   */
  managedRuleSetName?: string;
  /**
   * User labels, at most 64 including Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`), which are added automatically. Keys starting
   * with `stackit-` are reserved by STACKIT. Updated in place.
   */
  labels?: Record<string, string>;
}

export interface ConfigurationAttributes {
  /** Name of the configuration, which an ALB listener takes as `wafConfigName`. */
  configurationName: string;
  /** Project of the configuration. */
  projectId: string;
  /** Region of the configuration. */
  region: string;
  /** The custom rule group it applies, if any. */
  customRuleGroupName: string | undefined;
  /** The managed rule set it applies, if any. */
  managedRuleSetName: string | undefined;
  /** The load balancers and listeners using it when last read. */
  usage: waf.WAFUsage | undefined;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type Configuration = Resource<
  "Stackit.WAF.Configuration",
  ConfigurationProps,
  ConfigurationAttributes,
  never,
  Providers
>;

/**
 * A STACKIT web application firewall configuration: a named pairing of a managed
 * rule set and a custom rule group. An Application Load Balancer listener
 * activates it through `wafConfigName`, and any number of listeners can share it.
 * It has no hourly fee of its own; a load balancer that uses one is billed at its
 * WAF price.
 *
 * Its rule references and labels update in place, which STACKIT also applies to
 * every load balancer using it. A new name or scope replaces it. Ownership is
 * tracked with labels: a configuration with the same name that lacks them is
 * reported as unowned and only taken over with `--adopt`. The first deploy also
 * enables the service (`cloud.stackit.loadbalancer`) for the project.
 *
 * STACKIT refuses to delete a configuration a load balancer still uses. A delete
 * retries for about a minute, in case the load balancer is just going away, then
 * fails with the API's `BadRequest`.
 *
 * See [STACKIT's ALB WAF docs](https://docs.stackit.cloud/products/network/load-balancing-and-content-delivery/application-load-balancer/basics/basic-concepts-alb-waf/).
 *
 * :::caution[Changing `name`, `projectId` or `region` replaces the Configuration]
 * A load balancer listener that takes the name as an output moves to the new one. The
 * old configuration is deleted.
 * :::
 *
 * ### Creating a Configuration
 * **Example:** The OWASP Core Rule Set
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const rules = yield* Stackit.WAF.ManagedRuleSet("Owasp", {});
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   managedRuleSetName: rules.ruleSetName,
 * });
 * ```
 *
 * **Example:** Managed and custom rules together
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const rules = yield* Stackit.WAF.ManagedRuleSet("Owasp", {});
 * const group = yield* Stackit.WAF.CustomRuleGroup("Bots", {
 *   rules: [
 *     {
 *       behavior: { action: "ACTION_DENY" },
 *       conditions: [
 *         {
 *           variable: { type: "VARIABLE_REQUEST_HEADERS", value: "User-Agent" },
 *           operator: { type: "OPERATOR_CONTAINS", value: "badbot" },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   managedRuleSetName: rules.ruleSetName,
 *   customRuleGroupName: group.ruleGroupName,
 *   labels: { team: "edge" },
 * });
 * ```
 *
 * ### Using it on a Load Balancer
 * **Example:** Activate the firewall on a listener
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const rules = yield* Stackit.WAF.ManagedRuleSet("Owasp", {});
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   managedRuleSetName: rules.ruleSetName,
 * });
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const balancer = yield* Stackit.ALB.LoadBalancer("Web", {
 *   networks: [{ networkId: network.networkId }],
 *   options: { ephemeralAddress: true },
 *   listeners: [
 *     {
 *       name: "http",
 *       port: 80,
 *       protocol: "PROTOCOL_HTTP",
 *       wafConfigName: firewall.configurationName,
 *       http: { hosts: [{ host: "app.example.com", rules: [{ targetPool: "web" }] }] },
 *     },
 *   ],
 *   targetPools: [
 *     { name: "web", targetPort: 8080, targets: [{ ip: "10.0.1.10" }] },
 *   ],
 * });
 * ```
 *
 * ### Runtime Operations
 * **Example:** Read which listeners use the firewall from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Firewall = Stackit.WAF.Configuration("Firewall", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const getConfiguration = yield* Stackit.WAF.GetConfiguration(yield* Firewall);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getConfiguration();
 *         return yield* HttpServerResponse.json({ usage: live.usage });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.WAF.GetConfigurationHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming a configuration a load balancer uses
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // A new name creates the new configuration first, and the load balancer moves
 * // to it through `wafConfigName` before the old one is deleted. Moving an
 * // explicitly named configuration to a new project works the same way, but a
 * // load balancer can only use one from its own project.
 * const firewall = yield* Stackit.WAF.Configuration("Firewall", {
 *   name: "edge-firewall-v2",
 * });
 * ```
 *
 * @resource
 * @product STACKIT ALB Web Application Firewall
 * @category WAF
 */
export const Configuration = Resource<Configuration>("Stackit.WAF.Configuration");

/** The API reports an unset reference as absent or empty, depending on the operation. */
const reference = (name: string | undefined) => (name === "" ? undefined : name);

const toAttrs = (
  scope: ProjectScope,
  configuration: waf.GetWAFResponse,
): ConfigurationAttributes => ({
  configurationName: configuration.name,
  ...scope,
  customRuleGroupName: reference(configuration.customRuleGroupName),
  managedRuleSetName: reference(configuration.managedRuleSetName),
  usage: configuration.usage,
  labels: stripInternalLabels(withoutSystemLabels(configuration.labels)),
});

export const ConfigurationProvider = () =>
  Provider.succeed(Configuration, {
    stables: ["configurationName", "projectId", "region"],
    // Delete order: a configuration goes before the rules it references.
    nuke: {
      dependsOn: ["Stackit.WAF.CustomRuleGroup", "Stackit.WAF.ManagedRuleSet"],
    },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const configurations = yield* listAllConfigurations(scope);
      return configurations
        .filter((configuration) => isAlchemyOwned(configuration.labels))
        .map((configuration) => toAttrs(scope, configuration));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An explicit name could resolve to the one the old configuration holds:
      // delete it first. A generated name carries the generation.
      if (hasUnresolvedTrigger<ConfigurationProps>(news, ["name", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<ConfigurationProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ConfigurationProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const nameChanged =
        resolved.name !== undefined
          ? resolved.name !== output.configurationName
          : olds?.name !== undefined;
      // A new name or scope can't collide with the old one, so it comes up first.
      if (scopeChanged || nameChanged) return { action: "replace" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const recorded = output?.configurationName ?? olds?.name;
      let observed: waf.GetWAFResponse | undefined;
      if (recorded !== undefined) {
        observed = yield* getConfigurationOrUndefined(scope, recorded);
      } else if (previous !== undefined) {
        // A replacement looks for its own generated name only: labels can't
        // tell generations apart, and garbage collection deletes the old one.
        const generated = yield* physicalName(id);
        observed = yield* getConfigurationOrUndefined(scope, generated);
      } else {
        // A crashed create or lost state: find it by its labels.
        const all = yield* listAllConfigurations(scope);
        for (const candidate of all) {
          if (yield* hasAlchemyLabels(id, candidate.labels)) {
            observed = candidate;
            break;
          }
        }
      }
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      // The generation being replaced is ours, but only at its own scope: a name is
      // unique per project and region, so elsewhere it can be someone else's.
      if (
        previous?.configurationName === attrs.configurationName &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region
      ) {
        return attrs;
      }
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? output?.configurationName ?? (yield* physicalName(id));
      const labels = yield* desiredLabels(id, news.labels);

      yield* ensureServiceEnabled({ ...scope, serviceId: LOAD_BALANCER_SERVICE_ID });

      // 1. Observe. The name is the API's key.
      const observed = yield* getConfigurationOrUndefined(scope, name);

      // 2. Ensure.
      const current =
        observed ??
        (yield* waf.createWAF({
          ...scope,
          name,
          customRuleGroupName: news.customRuleGroupName,
          managedRuleSetName: news.managedRuleSetName,
          labels,
        }));

      // 3. Sync. A PUT also updates every load balancer that references this
      // configuration, so it is skipped when nothing changed.
      if (
        reference(current.customRuleGroupName) === news.customRuleGroupName &&
        reference(current.managedRuleSetName) === news.managedRuleSetName &&
        !labelsChanged(withoutSystemLabels(current.labels), labels)
      ) {
        return toAttrs(scope, current);
      }
      // A conflict means the configuration just changed: read it again, at most 5 times.
      const updated = yield* waf.getWAF({ ...scope, name }).pipe(
        Effect.flatMap((live) =>
          waf.updateWAF({
            ...scope,
            name,
            customRuleGroupName: news.customRuleGroupName,
            managedRuleSetName: news.managedRuleSetName,
            labels: { ...systemLabels(live.labels), ...labels },
          }),
        ),
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          schedule: Schedule.spaced("5 seconds"),
          times: 5,
        }),
      );

      // 4. Return
      return toAttrs(scope, updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const name = output.configurationName;
      // The spec types no 404 on this delete, so read first: gone is done.
      const current = yield* getConfigurationOrUndefined(scope, name);
      if (current === undefined) return;
      yield* retryWhileInUse(waf.deleteWAF({ ...scope, name }));
    }),
  });
