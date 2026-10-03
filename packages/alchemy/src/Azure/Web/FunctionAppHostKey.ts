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
import { lower, reveal } from "./common.ts";

/** Scope of a Functions host key. */
export type FunctionAppHostKeyType = "functionKeys" | "systemKeys";

export interface FunctionAppHostKeyProps {
  /** Resource group of the function app. Changing it replaces the key. */
  resourceGroup: string;
  /** Name of the function app. Changing it replaces the key. */
  functionAppName: string;
  /**
   * `functionKeys` (host keys accepted by every HTTP function) or
   * `systemKeys` (keys for extensions such as Event Grid webhooks).
   * Changing it replaces the key.
   * @default "functionKeys"
   */
  keyType?: FunctionAppHostKeyType;
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

export interface FunctionAppHostKey extends Resource<
  "Azure.Web.FunctionAppHostKey",
  FunctionAppHostKeyProps,
  {
    /** Name of the key. */
    keyName: string;
    /** Scope of the key. */
    keyType: FunctionAppHostKeyType;
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
 * A Functions host key (`sites/host/default/{keyType}/{keyName}`) that
 * authorizes calls to every HTTP-triggered function of a function app.
 *
 * The function app's host must be running (its `AzureWebJobsStorage`
 * setting configured) for keys to be managed.
 *
 * @see https://learn.microsoft.com/azure/azure-functions/function-keys-how-to
 *
 * ### Creating a Host Key
 * **Example:** Generated host key for a client
 * ```typescript
 * const key = yield* Azure.Web.FunctionAppHostKey("partner", {
 *   resourceGroup: group.resourceGroupName,
 *   functionAppName: app.siteName,
 * });
 * // send key.value as the x-functions-key header
 * ```
 *
 * **Example:** Key with an explicit value
 * ```typescript
 * const key = yield* Azure.Web.FunctionAppHostKey("partner", {
 *   resourceGroup: group.resourceGroupName,
 *   functionAppName: app.siteName,
 *   value: Redacted.make(secret),
 * });
 * ```
 *
 * @resource
 */
export const FunctionAppHostKey = Resource<FunctionAppHostKey>(
  "Azure.Web.FunctionAppHostKey",
);

const createKeyName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true });

const readKey = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  keyType: FunctionAppHostKeyType,
  keyName: string,
) =>
  orUndefinedIfNotFound(
    web.ListWebAppHostKeys({ subscriptionId, resourceGroupName, name }),
  ).pipe(Effect.map((keys) => keys?.[keyType]?.[keyName]));

export const FunctionAppHostKeyProvider = () =>
  Provider.succeed(FunctionAppHostKey, {
    stables: ["keyName", "keyType", "functionAppName", "resourceGroup"],

    // Host keys are removed with their function app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.functionAppName) !== lower(output.functionAppName) ||
        (news.keyType ?? "functionKeys") !== output.keyType ||
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
      if (resourceGroup === undefined || functionAppName === undefined) {
        return undefined;
      }
      const keyType = output?.keyType ?? olds?.keyType ?? "functionKeys";
      const keyName =
        output?.keyName ?? olds?.name ?? (yield* createKeyName(id));
      const value = yield* readKey(
        subscriptionId,
        resourceGroup,
        functionAppName,
        keyType,
        keyName,
      );
      if (value === undefined) return undefined;
      const attrs = {
        keyName,
        keyType,
        functionAppName,
        resourceGroup,
        value: Redacted.make(value),
      };
      // Host keys carry no tags; only a key this stack recorded is known to
      // be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, functionAppName } = news;
      const keyType = news.keyType ?? "functionKeys";
      const keyName =
        news.name ?? output?.keyName ?? (yield* createKeyName(id));
      const desired = reveal(news.value);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        name: functionAppName,
      };
      const read = readKey(
        subscriptionId,
        resourceGroup,
        functionAppName,
        keyType,
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
        yield* web.WebAppsCreateOrUpdateHostSecret({
          ...where,
          keyType,
          keyName,
          properties: { name: keyName, value: desired },
        });
      }

      // The runtime persists keys asynchronously; wait until it serves it.
      const value = yield* waitForProvisioned(
        `host key ${keyName}`,
        read,
        (current) =>
          desired === undefined || current === desired
            ? undefined
            : "InProgress",
        { interval: "3 seconds", times: 20 },
      );
      return {
        keyName,
        keyType,
        functionAppName,
        resourceGroup,
        value: Redacted.make(value),
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppHostSecret({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.functionAppName,
          keyType: output.keyType,
          keyName: output.keyName,
        }),
      );
      yield* waitUntilGone(
        `host key ${output.keyName}`,
        readKey(
          subscriptionId,
          output.resourceGroup,
          output.functionAppName,
          output.keyType,
          output.keyName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.FunctionApp"],
    },
  });
