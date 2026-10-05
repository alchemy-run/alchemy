import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { accountOwnedByStage, createChildName, sameName } from "./Common.ts";

export interface DscNodeConfigurationProps {
  /** Resource group of the Automation account. Changing it replaces the node configuration. */
  resourceGroup: string;
  /** Automation account that holds the node configuration. Changing it replaces the node configuration. */
  automationAccount: string;
  /**
   * {@link DscConfiguration} the node configuration belongs to. Changing it
   * replaces the node configuration.
   */
  configuration: string;
  /**
   * Node part of the name; the full name is `<configuration>.<nodeName>`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the node configuration.
   */
  nodeName?: string;
  /** Compiled MOF document (the node configuration content). */
  mof: string;
  /**
   * Create a new build version instead of overwriting the node
   * configuration when the MOF changes.
   * @default false
   */
  incrementNodeConfigurationBuild?: boolean;
}

export interface DscNodeConfiguration extends Resource<
  "Azure.Automation.DscNodeConfiguration",
  DscNodeConfigurationProps,
  {
    /** Full name (`<configuration>.<nodeName>`). */
    nodeConfigurationName: string;
    /** ARM resource ID of the node configuration. */
    nodeConfigurationId: string;
    /** Automation account that holds the node configuration. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Configuration the node configuration belongs to. */
    configuration: string;
    /** Number of nodes assigned the node configuration. */
    nodeCount: number | undefined;
    /** Last modification time. */
    lastModifiedTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A DSC node configuration (a compiled MOF document) in an Azure Automation
 * account, assignable to DSC nodes.
 *
 * Azure Automation State Configuration retires in September 2027 in favor
 * of Azure Machine Configuration.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-dsc-compile
 *
 * ### Importing a Node Configuration
 * **Example:** Pre-compiled MOF
 * ```typescript
 * const web = yield* Azure.Automation.DscConfiguration("WebServer", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   name: "WebServer",
 *   script: webServerScript,
 * });
 * const node = yield* Azure.Automation.DscNodeConfiguration("web-node", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   configuration: web.configurationName,
 *   nodeName: "localhost",
 *   mof: compiledMof,
 * });
 * ```
 *
 * @resource
 */
export const DscNodeConfiguration = Resource<DscNodeConfiguration>(
  "Azure.Automation.DscNodeConfiguration",
);

const getNodeConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  nodeConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetDscNodeConfiguration({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      nodeConfigurationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  node: automation.GetDscNodeConfigurationResponse,
): DscNodeConfiguration["Attributes"] => ({
  nodeConfigurationName: name,
  nodeConfigurationId: node.id ?? "",
  automationAccount,
  resourceGroup,
  configuration: node.properties?.configuration?.name ?? "",
  nodeCount: node.properties?.nodeCount,
  lastModifiedTime: node.properties?.lastModifiedTime,
});

const nodeConfigurationName = Effect.fn(function* (
  id: string,
  props: { configuration: string; nodeName?: string },
) {
  return `${props.configuration}.${props.nodeName ?? (yield* createChildName(id, 60))}`;
});

export const DscNodeConfigurationProvider = () =>
  Provider.succeed(DscNodeConfiguration, {
    stables: [
      "nodeConfigurationName",
      "nodeConfigurationId",
      "automationAccount",
      "resourceGroup",
      "configuration",
    ],

    // Node configurations live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        !sameName(news.configuration, output.configuration) ||
        (news.nodeName !== undefined &&
          !sameName(
            `${news.configuration}.${news.nodeName}`,
            output.nodeConfigurationName,
          ))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.nodeConfigurationName ??
        (olds !== undefined
          ? yield* nodeConfigurationName(id, olds)
          : undefined);
      if (name === undefined) return undefined;
      const observed = yield* getNodeConfiguration(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        output?.nodeConfigurationName ??
        (yield* nodeConfigurationName(id, news));
      const get = getNodeConfiguration(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The MOF is not returned, so the previous props are
      // the only hint of what was imported.
      if (
        observed === undefined ||
        olds === undefined ||
        olds.mof !== news.mof
      ) {
        yield* automation.DscNodeConfigurationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          nodeConfigurationName: name,
          name,
          properties: {
            configuration: { name: news.configuration },
            source: { type: "embeddedContent", value: news.mof },
            incrementNodeConfigurationBuild:
              news.incrementNodeConfigurationBuild ?? false,
          },
        });
      }

      // The import is a long-running operation (202).
      const fresh = yield* waitForProvisioned(
        `dsc node configuration ${name}`,
        get,
        () => undefined,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, automationAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteDscNodeConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          nodeConfigurationName: output.nodeConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `dsc node configuration ${output.nodeConfigurationName}`,
        getNodeConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.nodeConfigurationName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Automation.DscConfiguration",
        "Azure.Automation.AutomationAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
