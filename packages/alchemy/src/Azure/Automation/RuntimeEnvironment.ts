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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStage,
  childNuke,
  createChildName,
  getAccount,
  sameName,
  sameRecord,
  sameText,
} from "./Common.ts";

export interface RuntimeEnvironmentProps {
  /** Resource group of the Automation account. Changing it replaces the environment. */
  resourceGroup: string;
  /** Automation account that holds the environment. Changing it replaces the environment. */
  automationAccount: string;
  /**
   * Environment name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the environment.
   */
  name?: string;
  /** Language of the environment. Changing it replaces the environment. */
  language: "PowerShell" | "Python";
  /**
   * Language version, e.g. `7.4` for PowerShell or `3.10` for Python.
   * Changing it replaces the environment.
   */
  version: string;
  /**
   * Built-in packages and their versions, e.g. `{ Az: "12.3.0" }`.
   */
  defaultPackages?: Record<string, string>;
  /** Description of the environment. */
  description?: string;
  /**
   * User tags: at most 3, values up to 64 characters. Runtime environments
   * are too constrained for the Alchemy ownership tags, so ownership is
   * inferred from the parent account's tags instead.
   */
  tags?: Record<string, string>;
}

export interface RuntimeEnvironment extends Resource<
  "Azure.Automation.RuntimeEnvironment",
  RuntimeEnvironmentProps,
  {
    /** Name of the environment. */
    runtimeEnvironmentName: string;
    /** ARM resource ID of the environment. */
    runtimeEnvironmentId: string;
    /** Automation account that holds the environment. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Language of the environment. */
    language: string | undefined;
    /** Language version. */
    version: string | undefined;
    /** Built-in packages and their versions. */
    defaultPackages: Record<string, string>;
    /** Description of the environment. */
    description: string | undefined;
    /** User tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A runtime environment in an Azure Automation account: a language version
 * plus a set of packages that runbooks run with (pass its name as
 * `runtimeEnvironment` of a {@link Runbook}).
 *
 * @see https://learn.microsoft.com/azure/automation/runtime-environment-overview
 *
 * ### Creating a Runtime Environment
 * **Example:** PowerShell 7.4 with the Az modules
 * ```typescript
 * const ps74 = yield* Azure.Automation.RuntimeEnvironment("ps74", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   language: "PowerShell",
 *   version: "7.4",
 *   defaultPackages: { Az: "12.3.0" },
 * });
 * ```
 *
 * @resource
 */
export const RuntimeEnvironment = Resource<RuntimeEnvironment>(
  "Azure.Automation.RuntimeEnvironment",
);

export const getRuntimeEnvironment = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  runtimeEnvironmentName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetRuntimeEnvironment({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      runtimeEnvironmentName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  env: automation.GetRuntimeEnvironmentResponse,
): RuntimeEnvironment["Attributes"] => ({
  runtimeEnvironmentName: name,
  runtimeEnvironmentId: env.id ?? "",
  automationAccount,
  resourceGroup,
  language: env.properties?.runtime?.language,
  version: env.properties?.runtime?.version,
  defaultPackages: Object.fromEntries(
    Object.entries(env.properties?.defaultPackages ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  ),
  description: env.properties?.description,
  tags: userTags(env.tags),
});

export const RuntimeEnvironmentProvider = () =>
  Provider.succeed(RuntimeEnvironment, {
    stables: [
      "runtimeEnvironmentName",
      "runtimeEnvironmentId",
      "automationAccount",
      "resourceGroup",
    ],

    // Runtime environments live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined &&
          !sameName(news.name, output.runtimeEnvironmentName)) ||
        !sameName(news.language, output.language) ||
        news.version !== output.version
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
        output?.runtimeEnvironmentName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getRuntimeEnvironment(
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

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ??
        output?.runtimeEnvironmentName ??
        (yield* createChildName(id));
      const tags = news.tags ?? {};
      const get = getRuntimeEnvironment(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync: the PUT is a synchronous upsert of every mutable
      // aspect; send it only when observed state differs.
      if (
        observed === undefined ||
        !sameText(observed.properties?.description, news.description) ||
        (news.defaultPackages !== undefined &&
          !sameRecord(
            observed.properties?.defaultPackages,
            news.defaultPackages,
          )) ||
        tagsDiffer(observed.tags, tags)
      ) {
        const location =
          observed?.location ??
          (yield* getAccount(subscriptionId, resourceGroup, automationAccount))
            ?.location ??
          (yield* AzureEnvironment.current).location;
        yield* automation.CreateRuntimeEnvironment({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          runtimeEnvironmentName: name,
          location,
          tags,
          properties: {
            runtime: { language: news.language, version: news.version },
            defaultPackages: news.defaultPackages,
            description: news.description,
          },
        });
        observed = yield* waitForProvisioned(
          `runtime environment ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteRuntimeEnvironment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          runtimeEnvironmentName: output.runtimeEnvironmentName,
        }),
      );
      yield* waitUntilGone(
        `runtime environment ${output.runtimeEnvironmentName}`,
        getRuntimeEnvironment(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.runtimeEnvironmentName,
        ),
      );
    }),

    nuke: childNuke,
  });
