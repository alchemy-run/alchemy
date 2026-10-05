import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, reveal } from "./common.ts";

/** Which environments of a static site require the password. */
export type StaticSiteBasicAuthMode =
  | "AllEnvironments"
  | "StagingEnvironments"
  | "SpecifiedEnvironments";

export interface StaticSiteBasicAuthProps {
  /** Resource group of the static site. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the setting. */
  staticSiteName: string;
  /**
   * Password visitors must enter (at least 8 characters with upper- and
   * lowercase letters, a digit and a symbol). Either `password` or
   * `secretUrl` is required.
   */
  password?: string | Redacted.Redacted<string>;
  /** Key Vault secret URL holding the password (instead of `password`). */
  secretUrl?: string;
  /**
   * Environments the password protects.
   * @default "AllEnvironments"
   */
  applicableEnvironmentsMode?: StaticSiteBasicAuthMode;
  /**
   * Environment names protected with `SpecifiedEnvironments` mode.
   */
  environments?: string[];
}

export interface StaticSiteBasicAuth extends Resource<
  "Azure.Web.StaticSiteBasicAuth",
  StaticSiteBasicAuthProps,
  {
    /** Name of the static site. */
    staticSiteName: string;
    /** Resource group of the static site. */
    resourceGroup: string;
    /** Environments the password protects. */
    applicableEnvironmentsMode: string;
    /** Environment names protected in `SpecifiedEnvironments` mode. */
    environments: string[];
    /** Where the password comes from (`Password` or `SecretUrl`). */
    secretState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Password protection of an Azure Static Web App
 * (`Microsoft.Web/staticSites/basicAuth/default`). Each site has one
 * setting; deleting the resource turns protection off. Requires the
 * `Standard` plan.
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/password-protection
 *
 * ### Protecting a Site
 * **Example:** Password-protect staging environments
 * ```typescript
 * yield* Azure.Web.StaticSiteBasicAuth("preview-password", {
 *   resourceGroup: group.resourceGroupName,
 *   staticSiteName: site.staticSiteName,
 *   password: Redacted.make(previewPassword),
 *   applicableEnvironmentsMode: "StagingEnvironments",
 * });
 * ```
 *
 * @resource
 */
export const StaticSiteBasicAuth = Resource<StaticSiteBasicAuth>(
  "Azure.Web.StaticSiteBasicAuth",
);

type ObservedBasicAuth = web.GetStaticSiteBasicAuthResponse;

/** Protection is off when no environment is selected. */
const isEnabled = (observed: ObservedBasicAuth) => {
  const mode = observed.properties?.applicableEnvironmentsMode;
  return (
    mode !== undefined &&
    (mode !== "SpecifiedEnvironments" ||
      (observed.properties?.environments ?? []).length > 0)
  );
};

const getBasicAuth = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    web.GetStaticSiteBasicAuth({
      subscriptionId,
      resourceGroupName,
      name,
      basicAuthName: "default",
    }),
  ).pipe(
    Effect.map((observed) =>
      observed !== undefined && isEnabled(observed) ? observed : undefined,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  staticSiteName: string,
  observed: ObservedBasicAuth,
): StaticSiteBasicAuth["Attributes"] => ({
  staticSiteName,
  resourceGroup,
  applicableEnvironmentsMode:
    observed.properties?.applicableEnvironmentsMode ?? "",
  environments: [...(observed.properties?.environments ?? [])],
  secretState: observed.properties?.secretState,
});

const sameEnvironments = (
  desired: readonly string[],
  observed: readonly string[] | undefined,
) => {
  const a = [...desired].map((e) => e.toLowerCase()).sort();
  const b = [...(observed ?? [])].map((e) => e.toLowerCase()).sort();
  return a.length === b.length && a.every((e, i) => e === b[i]);
};

export const StaticSiteBasicAuthProvider = () =>
  Provider.succeed(StaticSiteBasicAuth, {
    stables: ["staticSiteName", "resourceGroup"],

    // The setting is removed with its static site.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.staticSiteName) !== lower(output.staticSiteName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const staticSiteName = output?.staticSiteName ?? olds?.staticSiteName;
      if (resourceGroup === undefined || staticSiteName === undefined) {
        return undefined;
      }
      const observed = yield* getBasicAuth(
        subscriptionId,
        resourceGroup,
        staticSiteName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, staticSiteName, observed);
      // A singleton without tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, staticSiteName } = news;
      const mode = news.applicableEnvironmentsMode ?? "AllEnvironments";
      const environments = news.environments ?? [];
      const password = reveal(news.password);
      const get = getBasicAuth(subscriptionId, resourceGroup, staticSiteName);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The password is write-only, so it is re-sent when the
      // observed mode/environments/secret source drift or the desired secret
      // changed.
      const secretState = password !== undefined ? "Password" : "SecretUrl";
      const drifted =
        observed === undefined ||
        observed.properties?.applicableEnvironmentsMode !== mode ||
        !sameEnvironments(environments, observed.properties?.environments) ||
        lower(observed.properties?.secretState) !== lower(secretState) ||
        (news.secretUrl !== undefined &&
          observed.properties?.secretUrl !== news.secretUrl) ||
        password !== reveal(olds?.password);
      if (drifted) {
        yield* web.StaticSitesCreateOrUpdateBasicAuth({
          subscriptionId,
          resourceGroupName: resourceGroup,
          name: staticSiteName,
          basicAuthName: "default",
          properties: {
            password,
            secretUrl: news.secretUrl,
            applicableEnvironmentsMode: mode,
            environments,
          },
        });
      }

      const final = yield* get;
      return final === undefined
        ? {
            staticSiteName,
            resourceGroup,
            applicableEnvironmentsMode: mode,
            environments,
            secretState,
          }
        : toAttrs(resourceGroup, staticSiteName, final);
    }),

    // There is no DELETE: protection is turned off by selecting no
    // environment.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.StaticSitesCreateOrUpdateBasicAuth({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.staticSiteName,
          basicAuthName: "default",
          properties: {
            applicableEnvironmentsMode: "SpecifiedEnvironments",
            environments: [],
          },
        }),
      );
      yield* waitUntilGone(
        `basic auth of ${output.staticSiteName}`,
        getBasicAuth(
          subscriptionId,
          output.resourceGroup,
          output.staticSiteName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Web.StaticSite"],
    },
  });
