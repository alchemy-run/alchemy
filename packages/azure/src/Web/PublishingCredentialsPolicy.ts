import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, orUndefinedIfNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { isSiteOwnedByStack, lower, siteWhere } from "./common.ts";

export interface PublishingCredentialsPolicyProps {
  /** Resource group of the app. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces the policy. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the policy.
   * @default the production slot
   */
  slot?: string;
  /**
   * Allow FTP/FTPS deployment with the app's basic (user name and password)
   * publishing credentials.
   * @default false
   */
  ftp?: boolean;
  /**
   * Allow Kudu (SCM) and WebDeploy deployment with the app's basic
   * publishing credentials. Microsoft Entra ID deployments keep working.
   * @default false
   */
  scm?: boolean;
}

export interface PublishingCredentialsPolicy extends Resource<
  "Azure.Web.PublishingCredentialsPolicy",
  PublishingCredentialsPolicyProps,
  {
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Whether FTP basic authentication is allowed. */
    ftp: boolean;
    /** Whether SCM (Kudu/WebDeploy) basic authentication is allowed. */
    scm: boolean;
  },
  never,
  Providers
> {}

/**
 * The basic-authentication publishing policies of an App Service app
 * (`Microsoft.Web/sites/basicPublishingCredentialsPolicies/ftp` and `/scm`):
 * whether FTP and Kudu/WebDeploy deployments may use the app's user name and
 * password credentials. Each app (and each slot) has exactly one of each.
 * New apps and slots start with both disallowed; deleting this resource
 * leaves the policies as they are (it never re-enables basic auth).
 *
 * :::caution
 * Changing `resourceGroup`, `siteName`, or `slot` replaces the policy.
 * :::
 *
 * @see https://learn.microsoft.com/azure/app-service/configure-basic-auth-disable
 *
 * ### Managing Basic Authentication
 * **Example:** Allow Kudu basic auth for a legacy deployment tool
 * ```typescript
 * yield* Azure.Web.PublishingCredentialsPolicy("kudu-basic-auth", {
 *   siteName: app.siteName,
 *   scm: true,
 * });
 * ```
 *
 * **Example:** Entra ID deployments only, on a deployment slot
 * ```typescript
 * yield* Azure.Web.PublishingCredentialsPolicy("staging-no-basic-auth", {
 *   siteName: app.siteName,
 *   slot: "staging",
 *   ftp: false,
 *   scm: false,
 * });
 * ```
 *
 * @resource
 */
export const PublishingCredentialsPolicy = GroupedResource<PublishingCredentialsPolicy>(
  "Azure.Web.PublishingCredentialsPolicy",
);

type Method = "ftp" | "scm";

const getAllowed = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  method: Method,
) => {
  const where = siteWhere(subscriptionId, resourceGroup, siteName);
  const get =
    method === "ftp"
      ? slot === undefined
        ? web.GetWebAppFtpAllowed(where)
        : web.GetWebAppFtpAllowedSlot({ ...where, slot })
      : slot === undefined
        ? web.GetWebAppScmAllowed(where)
        : web.GetWebAppScmAllowedSlot({ ...where, slot });
  return orUndefinedIfNotFound(get).pipe(Effect.map((observed) => observed?.properties?.allow));
};

const setAllowed = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  method: Method,
  allow: boolean,
) => {
  const request = {
    ...siteWhere(subscriptionId, resourceGroup, siteName),
    properties: { allow },
  };
  const put =
    method === "ftp"
      ? slot === undefined
        ? web.UpdateWebAppFtpAllowed(request)
        : web.UpdateWebAppFtpAllowedSlot({ ...request, slot })
      : slot === undefined
        ? web.UpdateWebAppScmAllowed(request)
        : web.UpdateWebAppScmAllowedSlot({ ...request, slot });
  return Effect.asVoid(put);
};

/** Observe both policies; `undefined` when the app (or slot) is gone. */
const observe = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
) =>
  Effect.gen(function* () {
    const ftp = yield* getAllowed(subscriptionId, resourceGroup, siteName, slot, "ftp");
    const scm = yield* getAllowed(subscriptionId, resourceGroup, siteName, slot, "scm");
    if (ftp === undefined || scm === undefined) return undefined;
    return { ftp, scm };
  });

export const PublishingCredentialsPolicyProvider = () =>
  Provider.succeed(PublishingCredentialsPolicy, {
    stables: ["siteName", "slot", "resourceGroup"],

    // The policies exist exactly as long as their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (resourceGroup === undefined || siteName === undefined) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const observed = yield* observe(subscriptionId, resourceGroup, siteName, slot);
      if (observed === undefined) return undefined;
      const attrs = { siteName, slot, resourceGroup, ...observed };
      if (output !== undefined) return attrs;
      // The singleton always exists and carries no tags: it is ours when the
      // app it configures is.
      return (yield* isSiteOwnedByStack(subscriptionId, resourceGroup, siteName, slot))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const desired = { ftp: news.ftp ?? false, scm: news.scm ?? false };

      // Observe. The policies always exist on a running app.
      const observed = yield* observe(subscriptionId, resourceGroup, siteName, slot);

      // Sync each policy whose observed value differs (synchronous PUTs).
      for (const method of ["ftp", "scm"] as const) {
        if (observed?.[method] !== desired[method]) {
          yield* setAllowed(subscriptionId, resourceGroup, siteName, slot, method, desired[method]);
        }
      }
      return { siteName, slot, resourceGroup, ...desired };
    }),

    // The policies cannot be removed, and resetting them could re-enable
    // basic authentication: deleting the resource leaves them as they are.
    delete: Effect.fn(function* () {}),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
