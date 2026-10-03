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
import {
  accountOwnedByStage,
  type AutomationContentLink,
  contentLinkChanged,
  sameName,
} from "./Common.ts";

export interface RuntimeEnvironmentPackageProps {
  /** Resource group of the Automation account. Changing it replaces the package. */
  resourceGroup: string;
  /** Automation account of the runtime environment. Changing it replaces the package. */
  automationAccount: string;
  /** {@link RuntimeEnvironment} that holds the package. Changing it replaces the package. */
  runtimeEnvironment: string;
  /**
   * Package name; must match the module or package in the content.
   * Changing it replaces the package.
   */
  name: string;
  /**
   * Package to import: a PowerShell Gallery `.nupkg` URL for PowerShell
   * environments, or a `.whl` URL for Python environments. Changing it
   * re-imports the package.
   */
  contentLink: AutomationContentLink;
}

export interface RuntimeEnvironmentPackage extends Resource<
  "Azure.Automation.RuntimeEnvironmentPackage",
  RuntimeEnvironmentPackageProps,
  {
    /** Name of the package. */
    packageName: string;
    /** ARM resource ID of the package. */
    packageId: string;
    /** Runtime environment that holds the package. */
    runtimeEnvironment: string;
    /** Automation account of the runtime environment. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Imported package version. */
    version: string | undefined;
    /** Import state (`Succeeded` once usable). */
    provisioningState: string | undefined;
    /** Size of the package in bytes. */
    sizeInBytes: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A package imported into an Automation {@link RuntimeEnvironment}, on top
 * of its default packages.
 *
 * The import runs in the background; Alchemy waits until it succeeds.
 *
 * @see https://learn.microsoft.com/azure/automation/manage-runtime-environment
 *
 * ### Adding a Package
 * **Example:** PowerShell Gallery module in a PowerShell 7.4 environment
 * ```typescript
 * const ps74 = yield* Azure.Automation.RuntimeEnvironment("ps74", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   language: "PowerShell",
 *   version: "7.4",
 * });
 * yield* Azure.Automation.RuntimeEnvironmentPackage("PSWriteColor", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   runtimeEnvironment: ps74.runtimeEnvironmentName,
 *   name: "PSWriteColor",
 *   contentLink: {
 *     uri: "https://www.powershellgallery.com/api/v2/package/PSWriteColor/1.0.1",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const RuntimeEnvironmentPackage = Resource<RuntimeEnvironmentPackage>(
  "Azure.Automation.RuntimeEnvironmentPackage",
);

const getPackage = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  runtimeEnvironmentName: string,
  packageName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetPackage({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      runtimeEnvironmentName,
      packageName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  runtimeEnvironment: string,
  name: string,
  pkg: automation.GetPackageResponse,
): RuntimeEnvironmentPackage["Attributes"] => ({
  packageName: name,
  packageId: pkg.id ?? "",
  runtimeEnvironment,
  automationAccount,
  resourceGroup,
  version: pkg.properties?.version,
  provisioningState: pkg.properties?.provisioningState,
  sizeInBytes: pkg.properties?.sizeInBytes,
});

export const RuntimeEnvironmentPackageProvider = () =>
  Provider.succeed(RuntimeEnvironmentPackage, {
    stables: [
      "packageName",
      "packageId",
      "runtimeEnvironment",
      "automationAccount",
      "resourceGroup",
    ],

    // Packages live inside a runtime environment; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        !sameName(news.runtimeEnvironment, output.runtimeEnvironment) ||
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
      const env = output?.runtimeEnvironment ?? olds?.runtimeEnvironment;
      const name = output?.packageName ?? olds?.name;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        env === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getPackage(
        subscriptionId,
        resourceGroup,
        account,
        env,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, env, name, observed);
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount, runtimeEnvironment, name } =
        news;
      const get = getPackage(
        subscriptionId,
        resourceGroup,
        automationAccount,
        runtimeEnvironment,
        name,
      );

      // Observe.
      const observed = yield* get;

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
        yield* automation.PackageCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          runtimeEnvironmentName: runtimeEnvironment,
          packageName: name,
          properties: { contentLink: news.contentLink },
        });
      }
      const fresh = yield* waitForProvisioned(
        `runtime environment package ${name}`,
        get,
        (pkg) => pkg.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      return toAttrs(
        resourceGroup,
        automationAccount,
        runtimeEnvironment,
        name,
        fresh,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeletePackage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          runtimeEnvironmentName: output.runtimeEnvironment,
          packageName: output.packageName,
        }),
      );
      yield* waitUntilGone(
        `runtime environment package ${output.packageName}`,
        getPackage(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.runtimeEnvironment,
          output.packageName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Automation.RuntimeEnvironment",
        "Azure.Automation.AutomationAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
