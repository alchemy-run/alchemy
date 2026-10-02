import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { lower, reveal, siteWhere } from "./common.ts";

export interface FunctionKeyProps {
  /** Resource group of the function app. Changing it replaces the key. */
  resourceGroup: string;
  /** Name of the function app. Changing it replaces the key. */
  functionAppName: string;
  /**
   * Name of the function the key authorizes (it must be deployed).
   * Changing it replaces the key.
   */
  functionName: string;
  /**
   * Name of the key. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the key.
   */
  name?: string;
  /**
   * Key value (at least 32 characters). If omitted, Azure generates one and
   * keeps it across deploys.
   */
  value?: string | Redacted.Redacted<string>;
}

export interface FunctionKey extends Resource<
  "Azure.Web.FunctionKey",
  FunctionKeyProps,
  {
    /** Name of the key. */
    keyName: string;
    /** Name of the function. */
    functionName: string;
    /** Name of the function app. */
    functionAppName: string;
    /** Resource group of the function app. */
    resourceGroup: string;
    /** The key value; send it as `x-functions-key` or `?code=`. */
    value: Redacted.Redacted<string>;
  },
  never,
  Providers
> {}

/**
 * A function key (`sites/functions/keys/{keyName}`) that authorizes calls
 * to a single HTTP-triggered function of a function app. Use
 * `Azure.Web.FunctionAppHostKey` for a key valid for every function.
 *
 * The function must already be deployed and the Functions host running.
 *
 * @see https://learn.microsoft.com/azure/azure-functions/function-keys-how-to
 *
 * ### Creating a Function Key
 * **Example:** Generated key for one function
 * ```typescript
 * const key = yield* Azure.Web.FunctionKey("webhook", {
 *   resourceGroup: group.resourceGroupName,
 *   functionAppName: app.siteName,
 *   functionName: "HttpTrigger",
 * });
 * // send key.value as the x-functions-key header
 * ```
 *
 * **Example:** Key with an explicit value
 * ```typescript
 * const key = yield* Azure.Web.FunctionKey("webhook", {
 *   resourceGroup: group.resourceGroupName,
 *   functionAppName: app.siteName,
 *   functionName: "HttpTrigger",
 *   value: Redacted.make(secret),
 * });
 * ```
 *
 * @resource
 */
export const FunctionKey = Resource<FunctionKey>("Azure.Web.FunctionKey");

const createKeyName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true });

const readKey = (
  subscriptionId: string,
  resourceGroup: string,
  functionAppName: string,
  functionName: string,
  keyName: string,
) =>
  orUndefinedIfNotFound(
    web.ListWebAppFunctionKeys({
      ...siteWhere(subscriptionId, resourceGroup, functionAppName),
      functionName,
    }),
  ).pipe(Effect.map((keys) => keys?.properties?.[keyName]));

export const FunctionKeyProvider = () =>
  Provider.succeed(FunctionKey, {
    stables: ["keyName", "functionName", "functionAppName", "resourceGroup"],

    // Function keys are removed with their function app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.functionAppName) !== lower(output.functionAppName) ||
        lower(news.functionName) !== lower(output.functionName) ||
        (news.name !== undefined && news.name !== output.keyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const functionAppName = output?.functionAppName ?? olds?.functionAppName;
      const functionName = output?.functionName ?? olds?.functionName;
      if (
        resourceGroup === undefined ||
        functionAppName === undefined ||
        functionName === undefined
      ) {
        return undefined;
      }
      const keyName =
        output?.keyName ?? olds?.name ?? (yield* createKeyName(id));
      const value = yield* readKey(
        subscriptionId,
        resourceGroup,
        functionAppName,
        functionName,
        keyName,
      );
      if (value === undefined) return undefined;
      const attrs = {
        keyName,
        functionName,
        functionAppName,
        resourceGroup,
        value: Redacted.make(value),
      };
      // Function keys carry no tags; only a key this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, functionAppName, functionName } = news;
      const keyName =
        news.name ?? output?.keyName ?? (yield* createKeyName(id));
      const desired = reveal(news.value);
      const read = readKey(
        subscriptionId,
        resourceGroup,
        functionAppName,
        functionName,
        keyName,
      );

      // Observe.
      const observed = yield* read;

      // Ensure + sync the value. Without an explicit value the generated
      // one is kept.
      if (
        observed === undefined ||
        (desired !== undefined && observed !== desired)
      ) {
        yield* web.WebAppsCreateOrUpdateFunctionSecret({
          ...siteWhere(subscriptionId, resourceGroup, functionAppName),
          functionName,
          keyName,
          properties: { name: keyName, value: desired },
        });
      }

      // The runtime persists keys asynchronously; wait until it serves it.
      const value = yield* waitForProvisioned(
        `function key ${keyName}`,
        read,
        (current) =>
          desired === undefined || current === desired
            ? undefined
            : "InProgress",
        { interval: "3 seconds", times: 20 },
      );
      return {
        keyName,
        functionName,
        functionAppName,
        resourceGroup,
        value: Redacted.make(value),
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppFunctionSecret({
          ...siteWhere(
            subscriptionId,
            output.resourceGroup,
            output.functionAppName,
          ),
          functionName: output.functionName,
          keyName: output.keyName,
        }),
      );
      yield* waitUntilGone(
        `function key ${output.keyName}`,
        readKey(
          subscriptionId,
          output.resourceGroup,
          output.functionAppName,
          output.functionName,
          output.keyName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.FunctionApp"],
    },
  });
