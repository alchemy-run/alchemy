import * as app from "@distilled.cloud/azure/app";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fingerprint,
  isContainerAppOwnedByStack,
  lower,
  matchesDesired,
  reveal,
} from "./common.ts";

/** The source control of a container app is a singleton named `current`. */
const SOURCE_CONTROL_NAME = "current";

/** GitHub Actions workflow settings. */
export interface SourceControlGithubActions {
  /** Container registry the workflow pushes images to. */
  registryInfo?: {
    /** Registry server, e.g. `myregistry.azurecr.io`. */
    registryUrl?: string;
    /** Registry username. */
    registryUserName?: string;
    /** Registry password. */
    registryPassword?: string | Redacted.Redacted<string>;
  };
  /** Service principal the workflow deploys with. */
  azureCredentials?: {
    /** Client (application) ID. */
    clientId?: string;
    /** Client secret. */
    clientSecret?: string | Redacted.Redacted<string>;
    /** Tenant ID. */
    tenantId?: string;
    /** Subscription ID. */
    subscriptionId?: string;
    /** Kind of auth the workflow uses to deploy. */
    kind?: string;
  };
  /** Build context path in the repository. */
  contextPath?: string;
  /** One-time GitHub personal access token used to configure the repository. */
  githubPersonalAccessToken?: string | Redacted.Redacted<string>;
  /** Image name to build. */
  image?: string;
  /** `Image` or `Code`. */
  publishType?: string;
  /** Operating system of the build. */
  os?: string;
  /** Runtime stack (code builds). */
  runtimeStack?: string;
  /** Runtime version (code builds). */
  runtimeVersion?: string;
}

export interface SourceControlProps {
  /** Resource group of the container app. Changing it replaces the source control. */
  resourceGroup: string;
  /** Name of the container app. Changing it replaces the source control. */
  containerApp: string;
  /** GitHub repository URL. Changing it replaces the source control. */
  repoUrl: string;
  /** Branch that triggers deployments. */
  branch: string;
  /** GitHub Actions workflow settings. */
  githubActionConfiguration?: SourceControlGithubActions;
}

export interface SourceControl extends Resource<
  "Azure.ContainerApps.SourceControl",
  SourceControlProps,
  {
    /** ARM resource ID of the source control. */
    sourceControlId: string;
    /** Name of the container app. */
    containerApp: string;
    /** Resource group of the container app. */
    resourceGroup: string;
    /** Connected repository URL. */
    repoUrl: string | undefined;
    /** Deployment branch. */
    branch: string | undefined;
    /** State of the workflow setup. */
    operationState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Continuous deployment from GitHub for a container app
 * (`Microsoft.App/containerApps/sourcecontrols`). Azure commits a GitHub
 * Actions workflow to the repository that builds an image on every push
 * to the branch and deploys it as a new revision.
 *
 * The source control cannot be tagged; Alchemy treats it as owned when its
 * container app is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/github-actions
 *
 * ### GitHub Actions
 * **Example:** Build and deploy from `main`
 * ```typescript
 * yield* Azure.ContainerApps.SourceControl("ci", {
 *   resourceGroup: group.resourceGroupName,
 *   containerApp: api.containerAppName,
 *   repoUrl: "https://github.com/acme/api",
 *   branch: "main",
 *   githubActionConfiguration: {
 *     githubPersonalAccessToken: Redacted.make(pat),
 *     registryInfo: {
 *       registryUrl: registry.loginServer,
 *       registryUserName: registry.adminUsername,
 *       registryPassword: Redacted.make(registryPassword),
 *     },
 *     azureCredentials: {
 *       clientId: sp.clientId,
 *       clientSecret: Redacted.make(sp.secret),
 *       tenantId: sp.tenantId,
 *     },
 *     contextPath: "./",
 *     image: "acme/api",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SourceControl = Resource<SourceControl>(
  "Azure.ContainerApps.SourceControl",
);

const getSourceControl = (
  subscriptionId: string,
  resourceGroupName: string,
  containerAppName: string,
) =>
  orUndefinedIfNotFound(
    app.GetContainerAppsSourceControl({
      subscriptionId,
      resourceGroupName,
      containerAppName,
      sourceControlName: SOURCE_CONTROL_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  containerApp: string,
  observed: app.GetContainerAppsSourceControlResponse,
): SourceControl["Attributes"] => ({
  sourceControlId: observed.id ?? "",
  containerApp,
  resourceGroup,
  repoUrl: observed.properties?.repoUrl,
  branch: observed.properties?.branch,
  operationState: observed.properties?.operationState,
});

const toProperties = (
  props: SourceControlProps,
): app.SourceControlProperties => {
  const gh = props.githubActionConfiguration;
  return {
    repoUrl: props.repoUrl,
    branch: props.branch,
    githubActionConfiguration:
      gh === undefined
        ? undefined
        : {
            ...gh,
            registryInfo:
              gh.registryInfo === undefined
                ? undefined
                : {
                    ...gh.registryInfo,
                    registryPassword: reveal(gh.registryInfo.registryPassword),
                  },
            azureCredentials:
              gh.azureCredentials === undefined
                ? undefined
                : {
                    ...gh.azureCredentials,
                    clientSecret: reveal(gh.azureCredentials.clientSecret),
                  },
            githubPersonalAccessToken: reveal(gh.githubPersonalAccessToken),
          },
  };
};

/** Desired state Azure echoes back (secrets are never returned). */
const echoed = (properties: app.SourceControlProperties) => ({
  repoUrl: properties.repoUrl,
  branch: properties.branch,
  githubActionConfiguration:
    properties.githubActionConfiguration === undefined
      ? undefined
      : {
          contextPath: properties.githubActionConfiguration.contextPath,
          image: properties.githubActionConfiguration.image,
          os: properties.githubActionConfiguration.os,
          runtimeStack: properties.githubActionConfiguration.runtimeStack,
          runtimeVersion: properties.githubActionConfiguration.runtimeVersion,
        },
});

export const SourceControlProvider = () =>
  Provider.succeed(SourceControl, {
    stables: ["sourceControlId", "containerApp", "resourceGroup"],

    // Lives inside a container app; nuke removes it with the app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.containerApp !== output.containerApp ||
        lower(news.repoUrl) !== lower(output.repoUrl)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const containerApp = output?.containerApp ?? olds?.containerApp;
      if (resourceGroup === undefined || containerApp === undefined) {
        return undefined;
      }
      const observed = yield* getSourceControl(
        subscriptionId,
        resourceGroup,
        containerApp,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, containerApp, observed);
      return (yield* isContainerAppOwnedByStack(
        subscriptionId,
        resourceGroup,
        containerApp,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, containerApp } = news;
      const properties = toProperties(news);
      const get = getSourceControl(subscriptionId, resourceGroup, containerApp);
      const ready = waitForProvisioned(
        `source control of ${containerApp}`,
        get,
        (sc) => sc.properties?.operationState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* ready;

      // Ensure + sync: one full PUT (it rewrites the GitHub workflow),
      // skipped when the observed settings match and no secret changed.
      if (
        observed === undefined ||
        !matchesDesired(echoed(properties), observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        yield* app.ContainerAppsSourceControlsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          containerAppName: containerApp,
          sourceControlName: SOURCE_CONTROL_NAME,
          properties,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, containerApp, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteContainerAppsSourceControl({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          containerAppName: output.containerApp,
          sourceControlName: SOURCE_CONTROL_NAME,
        }),
      );
      yield* waitUntilGone(
        `source control of ${output.containerApp}`,
        getSourceControl(
          subscriptionId,
          output.resourceGroup,
          output.containerApp,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
