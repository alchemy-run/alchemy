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
  accountOwnedByStage,
  sameName,
} from "./Common.ts";

export interface Python3PackageProps {
  /** Resource group of the Automation account. Changing it replaces the package. */
  resourceGroup: string;
  /** Automation account that holds the package. */
  automationAccount: string;
  /**
   * Package name; must match the name of the Python package. Changing it
   * replaces the package.
   */
  name: string;
  /**
   * Wheel (`.whl`) to import, e.g. a `files.pythonhosted.org` URL.
   * Changing it re-imports the package.
   */
  contentLink: AutomationContentLink;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Python3Package extends Resource<
  "Azure.Automation.Python3Package",
  Python3PackageProps,
  {
    /** Name of the package. */
    packageName: string;
    /** ARM resource ID of the package. */
    packageId: string;
    /** Automation account that holds the package. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Imported package version. */
    version: string | undefined;
    /** Import state (`Succeeded` once usable). */
    provisioningState: string | undefined;
    /** Size of the package in bytes. */
    sizeInBytes: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Python 3 package imported into an Azure Automation account, so its
 * Python 3 runbooks can import it.
 *
 * The import runs in the background; Alchemy waits until it succeeds.
 *
 * @see https://learn.microsoft.com/azure/automation/python-3-packages
 *
 * ### Importing a Package
 * **Example:** Wheel from PyPI
 * ```typescript
 * const six = yield* Azure.Automation.Python3Package("six", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   name: "six",
 *   contentLink: {
 *     uri: "https://files.pythonhosted.org/packages/b7/ce/149a00dd41f10bc29e5921b496af8b574d8413afcd5e30dfa0ed46c2cc5e/six-1.17.0-py2.py3-none-any.whl",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Python3Package = Resource<Python3Package>(
  "Azure.Automation.Python3Package",
);

const getPackage = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  packageName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetPython3Package({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      packageName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  pkg: automation.GetPython3PackageResponse,
): Python3Package["Attributes"] => ({
  packageName: name,
  packageId: pkg.id ?? "",
  automationAccount,
  resourceGroup,
  version: pkg.properties?.version,
  provisioningState: pkg.properties?.provisioningState,
  sizeInBytes: pkg.properties?.sizeInBytes,
  tags: userTags(pkg.tags),
});

export const Python3PackageProvider = () =>
  Provider.succeed(Python3Package, {
    stables: ["packageName", "packageId", "automationAccount", "resourceGroup"],

    // Packages live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        !sameName(news.name, output.packageName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      const name = output?.packageName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getPackage(
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

    reconcile: Effect.fn(function* ({ id, news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount, name } = news;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        packageName: name,
      };
      const get = getPackage(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );
      const label = `python package ${name}`;

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
        yield* automation.Python3PackageCreateOrUpdate({
          ...where,
          tags,
          properties: { contentLink: news.contentLink },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (pkg) => pkg.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Sync tags against observed.
      if (tagsDiffer(observed.tags, tags)) {
        yield* automation.UpdatePython3Package({ ...where, tags });
        observed = (yield* get) ?? observed;
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeletePython3Package({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          packageName: output.packageName,
        }),
      );
      yield* waitUntilGone(
        `python package ${output.packageName}`,
        getPackage(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.packageName,
        ),
      );
    }),

    nuke: childNuke,
  });
