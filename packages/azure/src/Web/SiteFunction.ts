import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, matchesDesired, siteWhere } from "./common.ts";

export interface SiteFunctionProps {
  /** Resource group of the function app. Changing it replaces the function. */
  resourceGroup: string;
  /** Name of the function app. Changing it replaces the function. */
  functionAppName: string;
  /**
   * Deployment slot of the function app. Changing it replaces the function.
   * @default the production slot
   */
  slot?: string;
  /**
   * Name of the function. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the function.
   */
  name?: string;
  /**
   * Contents of the function's `function.json`: its trigger and bindings,
   * e.g. `{ bindings: [{ type: "httpTrigger", direction: "in", name: "Request" }] }`.
   */
  config: Record<string, unknown>;
  /**
   * Script files of the function, keyed by file name (e.g. `run.ps1`,
   * `index.js`), with their text contents.
   */
  files: Record<string, string>;
  /** Sample request body the portal uses to test the function. */
  testData?: string;
}

export interface SiteFunction extends Resource<
  "Azure.Web.SiteFunction",
  SiteFunctionProps,
  {
    /** Name of the function. */
    functionName: string;
    /** ARM resource ID of the function. */
    functionId: string;
    /** Name of the function app. */
    functionAppName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the function app. */
    resourceGroup: string;
    /** Invocation URL template of an HTTP-triggered function. */
    invokeUrlTemplate: string | undefined;
    /** Language Azure detected from the script files. */
    language: string | undefined;
    /**
     * Whether the function is disabled (set the app setting
     * `AzureWebJobs.<name>.Disabled` to disable it).
     */
    isDisabled: boolean;
  },
  never,
  Providers
> {}

/**
 * A function defined in place in a function app
 * (`Microsoft.Web/sites/functions`, or `sites/slots/functions` with `slot`):
 * its `function.json` and script files are written to the app's file system
 * through ARM, as the portal editor does. Use it for script languages
 * (PowerShell, JavaScript, Python, C# script) on Windows Consumption,
 * Elastic Premium, or dedicated plans; apps that run from a package
 * (`WEBSITE_RUN_FROM_PACKAGE`, Flex Consumption, Linux Consumption) have a
 * read-only file system and reject it.
 *
 * :::caution
 * Microsoft.Web can refuse the delete with HTTP 404 "Error deleting
 * function." while the function still exists (seen on a Standard Windows
 * PowerShell app); the delete then fails after waiting instead of leaving
 * the function behind silently.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `functionAppName`, `slot`, or `name` replaces
 * the function.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/appservice/web-apps/create-function
 *
 * ### Defining a Function
 * **Example:** HTTP-triggered PowerShell function
 * ```typescript
 * const hello = yield* Azure.Web.SiteFunction("hello", {
 *   functionAppName: app.siteName,
 *   name: "Hello",
 *   config: {
 *     bindings: [
 *       { authLevel: "function", type: "httpTrigger", direction: "in", name: "Request", methods: ["get"] },
 *       { type: "http", direction: "out", name: "Response" },
 *     ],
 *   },
 *   files: {
 *     "run.ps1": `Push-OutputBinding -Name Response -Value ([HttpResponseContext]@{ StatusCode = 200; Body = "hello" })`,
 *   },
 * });
 * // hello.invokeUrlTemplate
 * ```
 *
 * @resource
 */
export const SiteFunction = GroupedResource<SiteFunction>("Azure.Web.SiteFunction");

type ObservedFunction = web.GetWebAppFunctionResponse;

const createFunctionName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getFunction = (
  subscriptionId: string,
  resourceGroup: string,
  functionAppName: string,
  slot: string | undefined,
  functionName: string,
) => {
  const where = { ...siteWhere(subscriptionId, resourceGroup, functionAppName), functionName };
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppFunction(where)
      : web.GetWebAppInstanceFunctionSlot({ ...where, slot }),
  );
};

const toAttrs = (
  resourceGroup: string,
  functionAppName: string,
  slot: string | undefined,
  functionName: string,
  observed: ObservedFunction,
): SiteFunction["Attributes"] => ({
  functionName,
  functionId: observed.id ?? "",
  functionAppName,
  slot,
  resourceGroup,
  invokeUrlTemplate: observed.properties?.invoke_url_template,
  language: observed.properties?.language,
  isDisabled: observed.properties?.isDisabled ?? false,
});

/** Files equal as sets of `name → content` (Azure does not echo them back). */
const sameFiles = (a: Record<string, string>, b: Record<string, string> | undefined) =>
  b !== undefined &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([name, content]) => b[name] === content);

export const SiteFunctionProvider = () =>
  Provider.succeed(SiteFunction, {
    stables: ["functionName", "functionId", "functionAppName", "slot", "resourceGroup"],

    // Functions are removed with their function app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.functionAppName) !== lower(output.functionAppName) ||
        lower(news.slot) !== lower(output.slot) ||
        (news.name !== undefined && lower(news.name) !== lower(output.functionName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const functionAppName = output?.functionAppName ?? olds?.functionAppName;
      if (resourceGroup === undefined || functionAppName === undefined) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const functionName = output?.functionName ?? olds?.name ?? (yield* createFunctionName(id));
      const observed = yield* getFunction(
        subscriptionId,
        resourceGroup,
        functionAppName,
        slot,
        functionName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, functionAppName, slot, functionName, observed);
      // Functions carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, functionAppName, slot } = news;
      const functionName = news.name ?? output?.functionName ?? (yield* createFunctionName(id));
      const get = getFunction(subscriptionId, resourceGroup, functionAppName, slot, functionName);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT rewrites the whole function; it runs when the
      // function is missing, its observed config drifts, or the script files
      // changed (Azure does not return file contents, so the previous props
      // are the only baseline for them).
      const drifted =
        observed === undefined ||
        !matchesDesired(news.config, observed.properties?.config) ||
        (news.testData !== undefined && observed.properties?.test_data !== news.testData) ||
        !sameFiles(news.files, olds?.files);
      if (drifted) {
        const request = {
          ...siteWhere(subscriptionId, resourceGroup, functionAppName),
          functionName,
          properties: {
            config: news.config,
            files: news.files,
            test_data: news.testData,
          },
        };
        yield* slot === undefined
          ? web.CreateWebAppFunction(request)
          : web.CreateWebAppInstanceFunctionSlot({ ...request, slot });
      }

      // The PUT is long-running: wait until the function serves the
      // desired config.
      const final = yield* waitForProvisioned(
        `function ${functionName}`,
        get,
        (current) =>
          matchesDesired(news.config, current.properties?.config) ? undefined : "InProgress",
        { interval: "5 seconds", times: 24 },
      );
      return toAttrs(resourceGroup, functionAppName, slot, functionName, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        ...siteWhere(subscriptionId, output.resourceGroup, output.functionAppName),
        functionName: output.functionName,
      };
      yield* ignoreNotFound(
        output.slot === undefined
          ? web.DeleteWebAppFunction(where)
          : web.DeleteWebAppInstanceFunctionSlot({ ...where, slot: output.slot }),
      );
      yield* waitUntilGone(
        `function ${output.functionName}`,
        getFunction(
          subscriptionId,
          output.resourceGroup,
          output.functionAppName,
          output.slot,
          output.functionName,
        ),
        { interval: "5 seconds", times: 24 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.FunctionApp", "Azure.Web.WebAppSlot"],
    },
  });
