import * as web from "@distilled.cloud/azure/web";
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
import { lower, matchesDesired, siteWhere } from "./common.ts";

export interface SourceControlProps {
  /** Resource group of the app. Changing it replaces the source control. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces it. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the source control.
   * @default the production slot
   */
  slot?: string;
  /** URL of the repository, e.g. `https://github.com/org/repo`. */
  repoUrl: string;
  /**
   * Branch to deploy.
   * @default "master"
   */
  branch?: string;
  /**
   * Pull the repository once per sync instead of registering a webhook.
   * Use it for public repositories the subscription has no OAuth token for.
   * @default true
   */
  isManualIntegration?: boolean;
  /**
   * Deploy through a GitHub Actions workflow instead of the Kudu build
   * service. Needs the subscription's GitHub token.
   * @default false
   */
  isGitHubAction?: boolean;
  /**
   * Allow rolling back to a previous deployment.
   * @default Azure's default (`false`)
   */
  deploymentRollbackEnabled?: boolean;
  /**
   * Whether the repository is Mercurial rather than Git.
   * @default false
   */
  isMercurial?: boolean;
  /** GitHub Actions workflow settings (with `isGitHubAction`). */
  gitHubActionConfiguration?: web.GitHubActionConfiguration;
}

export interface SourceControl extends Resource<
  "Azure.Web.SourceControl",
  SourceControlProps,
  {
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** URL of the repository. */
    repoUrl: string;
    /** Deployed branch. */
    branch: string | undefined;
    /** Whether the repository is pulled without a webhook. */
    isManualIntegration: boolean;
    /** Whether deployment runs through GitHub Actions. */
    isGitHubAction: boolean;
  },
  never,
  Providers
> {}

/**
 * Continuous deployment of an App Service app from a Git repository
 * (`Microsoft.Web/sites/sourcecontrols/web`). Each app has at most one.
 *
 * With manual integration (the default) App Service clones the public
 * repository and builds it once per sync; GitHub Actions integration
 * needs the subscription's GitHub token and is set up outside Alchemy.
 *
 * @see https://learn.microsoft.com/azure/app-service/deploy-continuous-deployment
 *
 * ### Deploying from a Repository
 * **Example:** Public GitHub repository
 * ```typescript
 * const source = yield* Azure.Web.SourceControl("source", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   repoUrl: "https://github.com/Azure-Samples/nodejs-docs-hello-world",
 *   branch: "main",
 * });
 * ```
 *
 * @resource
 */
export const SourceControl = Resource<SourceControl>("Azure.Web.SourceControl");

const getSourceControl = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
) => {
  const where = siteWhere(subscriptionId, resourceGroup, siteName);
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppSourceControl(where)
      : web.GetWebAppSourceControlSlot({ ...where, slot }),
  ).pipe(
    // An app without source control reports an empty configuration.
    Effect.map((observed) =>
      observed?.properties?.repoUrl ? observed : undefined,
    ),
  );
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  observed: web.GetWebAppSourceControlResponse,
) => ({
  siteName,
  slot,
  resourceGroup,
  repoUrl: observed.properties?.repoUrl ?? "",
  branch: observed.properties?.branch,
  isManualIntegration: observed.properties?.isManualIntegration ?? false,
  isGitHubAction: observed.properties?.isGitHubAction ?? false,
});

export const SourceControlProvider = () =>
  Provider.succeed(SourceControl, {
    stables: ["siteName", "slot", "resourceGroup"],

    // Source control is removed with its app.
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
      if (!resourceGroup || !siteName) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const observed = yield* getSourceControl(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, observed);
      // A singleton without tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const desired: web.SiteSourceControlProperties = {
        repoUrl: news.repoUrl,
        branch: news.branch ?? "master",
        isManualIntegration: news.isManualIntegration ?? true,
        isGitHubAction: news.isGitHubAction ?? false,
        deploymentRollbackEnabled: news.deploymentRollbackEnabled,
        isMercurial: news.isMercurial ?? false,
        gitHubActionConfiguration: news.gitHubActionConfiguration,
      };
      const where = siteWhere(subscriptionId, resourceGroup, siteName);
      const get = getSourceControl(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
      );

      // Observe.
      let observed = yield* get;

      // Sync. Microsoft.Web rejects any PUT/PATCH over a connected
      // repository ("Conflict with existing ScmType: ExternalGit"), so a
      // delta disconnects first and reconnects with the desired settings.
      if (
        observed !== undefined &&
        !matchesDesired(desired, observed.properties)
      ) {
        yield* ignoreNotFound(
          slot === undefined
            ? web.DeleteWebAppSourceControl(where)
            : web.DeleteWebAppSourceControlSlot({ ...where, slot }),
        );
        yield* waitUntilGone(`source control of ${siteName}`, get, {
          interval: "5 seconds",
          times: 24,
        });
        observed = undefined;
      }

      // Ensure. The PUT is long-running: it returns while the first clone
      // is still in progress.
      if (observed === undefined) {
        yield* slot === undefined
          ? web.WebAppsCreateOrUpdateSourceControl({
              ...where,
              properties: desired,
            })
          : web.WebAppsCreateOrUpdateSourceControlSlot({
              ...where,
              slot,
              properties: desired,
            });
      }

      const final = yield* waitForProvisioned(
        `source control of ${siteName}`,
        get,
        (current) =>
          matchesDesired(
            { repoUrl: desired.repoUrl, branch: desired.branch },
            current.properties,
          )
            ? undefined
            : "InProgress",
        { interval: "5 seconds", times: 36 },
      );
      return toAttrs(resourceGroup, siteName, slot, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = siteWhere(
        subscriptionId,
        output.resourceGroup,
        output.siteName,
      );
      yield* ignoreNotFound(
        output.slot === undefined
          ? web.DeleteWebAppSourceControl(where)
          : web.DeleteWebAppSourceControlSlot({ ...where, slot: output.slot }),
      );
      yield* waitUntilGone(
        `source control of ${output.siteName}`,
        getSourceControl(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slot,
        ),
        { interval: "5 seconds", times: 24 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
