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
import {
  type AutomationContentLink,
  childNuke,
  contentLinkChanged,
  getAccount,
  sameName,
} from "./Common.ts";

export interface ModuleProps {
  /** Resource group of the Automation account. Changing it replaces the module. */
  resourceGroup: string;
  /** Automation account that holds the module. Changing it replaces the module. */
  automationAccount: string;
  /**
   * Module name; must match the name of the PowerShell module in the
   * package. Changing it replaces the module.
   */
  name: string;
  /**
   * Package to import, e.g.
   * `https://www.powershellgallery.com/api/v2/package/<name>/<version>`.
   * Changing it re-imports the module.
   */
  contentLink: AutomationContentLink;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Module extends Resource<
  "Azure.Automation.Module",
  ModuleProps,
  {
    /** Name of the module. */
    moduleName: string;
    /** ARM resource ID of the module. */
    moduleId: string;
    /** Automation account that holds the module. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Imported module version. */
    version: string | undefined;
    /** Import state (`Succeeded` once usable). */
    provisioningState: string | undefined;
    /** Size of the module in bytes. */
    sizeInBytes: number | undefined;
    /** Number of cmdlets (activities) in the module. */
    activityCount: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A PowerShell (5.1) module imported into an Azure Automation account, so
 * its runbooks can use the module's cmdlets.
 *
 * The import runs in the background; Alchemy waits until it succeeds.
 *
 * @see https://learn.microsoft.com/azure/automation/shared-resources/modules
 *
 * ### Importing a Module
 * **Example:** Module from the PowerShell Gallery
 * ```typescript
 * const color = yield* Azure.Automation.Module("PSWriteColor", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   name: "PSWriteColor",
 *   contentLink: {
 *     uri: "https://www.powershellgallery.com/api/v2/package/PSWriteColor/1.0.1",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Module = Resource<Module>("Azure.Automation.Module");

const getModule = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  moduleName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetModule({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      moduleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  module: automation.GetModuleResponse,
): Module["Attributes"] => ({
  moduleName: name,
  moduleId: module.id ?? "",
  automationAccount,
  resourceGroup,
  version: module.properties?.version,
  provisioningState: module.properties?.provisioningState,
  sizeInBytes: module.properties?.sizeInBytes,
  activityCount: module.properties?.activityCount,
  tags: userTags(module.tags),
});

export const ModuleProvider = () =>
  Provider.succeed(Module, {
    stables: ["moduleName", "moduleId", "automationAccount", "resourceGroup"],

    // Modules live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        !sameName(news.name, output.moduleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, id }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      const name = output?.moduleName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getModule(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount, name } = news;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        moduleName: name,
      };
      const get = getModule(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );
      const label = `automation module ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure + re-import: the PUT starts an asynchronous import.
      if (
        observed === undefined ||
        contentLinkChanged(
          news.contentLink,
          observed.properties?.contentLink,
          olds?.contentLink,
          observed.properties?.provisioningState,
        )
      ) {
        const location =
          observed?.location ??
          (yield* getAccount(subscriptionId, resourceGroup, automationAccount))
            ?.location;
        yield* automation.ModuleCreateOrUpdate({
          ...where,
          name,
          location,
          tags,
          properties: { contentLink: news.contentLink },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (module) => module.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Sync tags against observed.
      if (tagsDiffer(observed.tags, tags)) {
        yield* automation.UpdateModule({ ...where, tags });
        observed = (yield* get) ?? observed;
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteModule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          moduleName: output.moduleName,
        }),
      );
      yield* waitUntilGone(
        `automation module ${output.moduleName}`,
        getModule(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.moduleName,
        ),
      );
    }),

    nuke: childNuke,
  });
