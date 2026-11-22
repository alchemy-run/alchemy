import type { ResourceLike } from "alchemy/Resource";

/**
 * Any Azure resource a Monitor binding reads metrics or resource-context
 * logs for, e.g. a storage account:
 *
 * ```typescript
 * const target = {
 *   resource: account,
 *   resourceId: account.storageAccountId,
 *   location: account.location,
 * };
 * ```
 *
 * The fields may be Outputs of the resource's attributes.
 */
export interface MonitoredResource {
  /** The resource. Its logical ID names the binding and its role assignment. */
  readonly resource: ResourceLike;
  /** ARM ID of the resource, e.g. `/subscriptions/…/storageAccounts/data`. */
  readonly resourceId: string;
  /** Region of the resource, e.g. `eastus` (picks the regional metrics endpoint). */
  readonly location: string;
}

/**
 * A data collection rule (DCR) that the Logs Ingestion API sends rows to.
 * Alchemy has no `DataCollectionRule` resource yet: declare the rule with an
 * ARM template (`Azure.Resources.DeploymentStack`, which deletes the rule
 * with it) and pass its outputs.
 *
 * ```typescript
 * const target = {
 *   resource: rules,
 *   dataCollectionRuleId: rules.outputs.dcrId.as<string>(),
 *   immutableId: rules.outputs.immutableId.as<string>(),
 *   logsIngestionEndpoint: rules.outputs.logsIngestion.as<string>(),
 * };
 * ```
 *
 * The fields may be Outputs.
 */
export interface DataCollectionRuleTarget {
  /** The resource that declares the rule. Its logical ID names the binding. */
  readonly resource: ResourceLike;
  /** ARM ID of the rule: the scope of the binding's role assignment. */
  readonly dataCollectionRuleId: string;
  /** Immutable ID of the rule (`dcr-…`), as the ingestion URL needs it. */
  readonly immutableId: string;
  /**
   * Logs ingestion endpoint: the rule's own `endpoints.logsIngestion`
   * (a `kind: "Direct"` rule) or its data collection endpoint's, e.g.
   * `https://my-dcr-abcd.eastus-1.ingest.monitor.azure.com`.
   */
  readonly logsIngestionEndpoint: string;
}
