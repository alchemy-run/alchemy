import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { childNuke, getAccount, sameName, sameText } from "./Common.ts";

export interface DscConfigurationProps {
  /** Resource group of the Automation account. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Automation account that holds the configuration. Changing it replaces the configuration. */
  automationAccount: string;
  /**
   * Configuration name; must equal the name after the `Configuration`
   * keyword in `script`. Changing it replaces the configuration.
   */
  name: string;
  /** PowerShell DSC configuration script. */
  script: string;
  /** Description of the configuration. */
  description?: string;
  /**
   * Write verbose records when compiling.
   * @default false
   */
  logVerbose?: boolean;
  /**
   * Write progress records when compiling.
   * @default false
   */
  logProgress?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DscConfiguration extends Resource<
  "Azure.Automation.DscConfiguration",
  DscConfigurationProps,
  {
    /** Name of the configuration. */
    configurationName: string;
    /** ARM resource ID of the configuration. */
    configurationId: string;
    /** Automation account that holds the configuration. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Publication state (`New`, `Edit`, `Published`). */
    state: string | undefined;
    /** Number of compiled node configurations. */
    nodeConfigurationCount: number | undefined;
    /** Description of the configuration. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A PowerShell DSC configuration in an Azure Automation account (Azure
 * Automation State Configuration). Compile it into node configurations
 * with {@link DscNodeConfiguration}.
 *
 * Azure Automation State Configuration retires in September 2027 in favor
 * of Azure Machine Configuration.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-dsc-overview
 *
 * ### Uploading a Configuration
 * **Example:** Configuration from an inline script
 * ```typescript
 * const web = yield* Azure.Automation.DscConfiguration("WebServer", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   name: "WebServer",
 *   script: `Configuration WebServer {
 *     Node localhost {
 *       WindowsFeature IIS { Ensure = "Present"; Name = "Web-Server" }
 *     }
 *   }`,
 * });
 * ```
 *
 * @resource
 */
export const DscConfiguration = Resource<DscConfiguration>(
  "Azure.Automation.DscConfiguration",
);

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  configurationName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetDscConfiguration({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      configurationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  config: automation.GetDscConfigurationResponse,
): DscConfiguration["Attributes"] => ({
  configurationName: name,
  configurationId: config.id ?? "",
  automationAccount,
  resourceGroup,
  state: config.properties?.state,
  nodeConfigurationCount: config.properties?.nodeConfigurationCount,
  description: config.properties?.description,
  tags: userTags(config.tags),
});

const normalizeScript = (script: string | undefined) =>
  script?.replace(/\r\n/g, "\n").trim();

export const DscConfigurationProvider = () =>
  Provider.succeed(DscConfiguration, {
    stables: [
      "configurationName",
      "configurationId",
      "automationAccount",
      "resourceGroup",
    ],

    // Configurations live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        !sameName(news.name, output.configurationName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      const name = output?.configurationName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getConfiguration(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount, name } = news;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        configurationName: name,
      };
      const get = getConfiguration(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );
      const logVerbose = news.logVerbose ?? false;

      // Observe the configuration and its script.
      let observed = yield* get;
      const script =
        observed === undefined
          ? undefined
          : yield* orUndefinedIfNotFound(
              automation.GetDscConfigurationContent(where),
            );

      // Ensure + sync: the PUT is a synchronous upsert of every aspect.
      if (
        observed === undefined ||
        normalizeScript(script) !== normalizeScript(news.script) ||
        !sameText(observed.properties?.description, news.description) ||
        (observed.properties?.logVerbose ?? false) !== logVerbose ||
        tagsDiffer(observed.tags, tags)
      ) {
        const location =
          observed?.location ??
          (yield* getAccount(subscriptionId, resourceGroup, automationAccount))
            ?.location;
        yield* automation.DscConfigurationCreateOrUpdate({
          ...where,
          name,
          location,
          tags,
          properties: {
            source: { type: "embeddedContent", value: news.script },
            description: news.description,
            logVerbose,
            logProgress: news.logProgress ?? false,
          },
        });
        observed = yield* waitForProvisioned(
          `dsc configuration ${name}`,
          get,
          (config) => config.properties?.provisioningState,
          { interval: "2 seconds", times: 30 },
        );
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteDscConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          configurationName: output.configurationName,
        }),
      );
      yield* waitUntilGone(
        `dsc configuration ${output.configurationName}`,
        getConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.configurationName,
        ),
      );
    }),

    nuke: childNuke,
  });
