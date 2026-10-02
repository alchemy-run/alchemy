import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { lower, matchesDesired, reveal, siteWhere } from "./common.ts";

/** A volume mounted into a site container. */
export interface SiteContainerVolumeMount {
  /** Sub-path of the shared volume. */
  volumeSubPath: string;
  /** Path the volume is mounted at inside the container. */
  containerMountPath: string;
  /** Optional data written into the volume (e.g. a config file). */
  data?: string;
  /**
   * Mount the volume read-only.
   * @default false
   */
  readOnly?: boolean;
}

/** An environment variable whose value comes from an app setting. */
export interface SiteContainerEnvironmentVariable {
  /** Variable name inside the container. */
  name: string;
  /** Name of the app setting that holds the value. */
  value: string;
}

export interface SiteContainerProps {
  /** Resource group of the app. Changing it replaces the container. */
  resourceGroup: string;
  /**
   * Name of the Linux web app. The app must run with
   * `siteConfig.linuxFxVersion: "SITECONTAINERS"`. Changing it replaces the
   * container.
   */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the container.
   * @default the production slot
   */
  slot?: string;
  /**
   * Name of the container. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the container.
   */
  name?: string;
  /** Image reference, e.g. `mcr.microsoft.com/appsvc/staticsite:latest`. */
  image: string;
  /**
   * Whether this is the main container that receives HTTP traffic. Exactly
   * one container of an app is the main container; others are sidecars.
   */
  isMain: boolean;
  /** Port the container listens on, e.g. `"8080"`. */
  targetPort?: string;
  /** Command that overrides the image's entrypoint. */
  startUpCommand?: string;
  /**
   * How App Service authenticates to the registry.
   * @default "Anonymous"
   */
  authType?:
    | "Anonymous"
    | "UserCredentials"
    | "SystemIdentity"
    | "UserAssigned";
  /** Registry user name (`UserCredentials`). */
  userName?: string;
  /**
   * Registry password (`UserCredentials`). Azure never returns it, so a
   * change is detected against the previous deploy's value.
   */
  passwordSecret?: string | Redacted.Redacted<string>;
  /** Client ID of the user-assigned identity used to pull (`UserAssigned`). */
  userManagedIdentityClientId?: string;
  /** Volumes mounted into the container. */
  volumeMounts?: SiteContainerVolumeMount[];
  /** Environment variables that reference app settings by name. */
  environmentVariables?: SiteContainerEnvironmentVariable[];
  /**
   * Expose all app settings and connection strings to the container.
   * @default Azure's default (`true`)
   */
  inheritAppSettingsAndConnectionStrings?: boolean;
}

export interface SiteContainer extends Resource<
  "Azure.Web.SiteContainer",
  SiteContainerProps,
  {
    /** Name of the container. */
    containerName: string;
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if the container is slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** ARM resource ID of the container. */
    siteContainerId: string;
    /** Image reference. */
    image: string;
    /** Whether this is the main container. */
    isMain: boolean;
    /** Port the container listens on. */
    targetPort: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A container of a Linux App Service app running in sidecar mode
 * (`Microsoft.Web/sites/sitecontainers`).
 *
 * The app must be created with `siteConfig.linuxFxVersion: "SITECONTAINERS"`.
 * One container is the main container that receives HTTP traffic; the
 * others run as sidecars on the same host and share `localhost`.
 *
 * @see https://learn.microsoft.com/azure/app-service/overview-sidecar
 *
 * ### Main Container
 * **Example:** Public image as the main container
 * ```typescript
 * const app = yield* Azure.Web.WebApp("site", {
 *   resourceGroup: group.resourceGroupName,
 *   serverFarmId: plan.appServicePlanId,
 *   siteConfig: { linuxFxVersion: "SITECONTAINERS" },
 * });
 * const main = yield* Azure.Web.SiteContainer("main", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   image: "mcr.microsoft.com/appsvc/staticsite:latest",
 *   targetPort: "80",
 *   isMain: true,
 * });
 * ```
 *
 * ### Sidecars
 * **Example:** OpenTelemetry collector sidecar
 * ```typescript
 * const collector = yield* Azure.Web.SiteContainer("otel", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   image: "otel/opentelemetry-collector:latest",
 *   targetPort: "4317",
 *   isMain: false,
 *   environmentVariables: [{ name: "API_KEY", value: "OTEL_API_KEY" }],
 * });
 * ```
 *
 * @resource
 */
export const SiteContainer = Resource<SiteContainer>("Azure.Web.SiteContainer");

const createContainerName = (id: string) =>
  createPhysicalName({ id, maxLength: 32, lowercase: true });

const getContainer = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  containerName: string,
) => {
  const where = {
    ...siteWhere(subscriptionId, resourceGroup, siteName),
    containerName,
  };
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.GetWebAppSiteContainer(where)
      : web.GetWebAppSiteContainerSlot({ ...where, slot }),
  );
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  containerName: string,
  observed: web.GetWebAppSiteContainerResponse,
) => ({
  containerName,
  siteName,
  slot,
  resourceGroup,
  siteContainerId: observed.id ?? "",
  image: observed.properties?.image ?? "",
  isMain: observed.properties?.isMain ?? false,
  targetPort: observed.properties?.targetPort,
});

export const SiteContainerProvider = () =>
  Provider.succeed(SiteContainer, {
    stables: [
      "containerName",
      "siteName",
      "slot",
      "resourceGroup",
      "siteContainerId",
    ],

    // Containers are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.containerName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (!resourceGroup || !siteName) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const containerName =
        output?.containerName ?? olds?.name ?? (yield* createContainerName(id));
      const observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
        containerName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        siteName,
        slot,
        containerName,
        observed,
      );
      // Site containers carry no tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const containerName =
        news.name ?? output?.containerName ?? (yield* createContainerName(id));
      const password = reveal(news.passwordSecret);
      const desired = {
        image: news.image,
        isMain: news.isMain,
        targetPort: news.targetPort,
        startUpCommand: news.startUpCommand,
        authType: news.authType ?? "Anonymous",
        userName: news.userName,
        userManagedIdentityClientId: news.userManagedIdentityClientId,
        volumeMounts: news.volumeMounts,
        environmentVariables: news.environmentVariables,
        inheritAppSettingsAndConnectionStrings:
          news.inheritAppSettingsAndConnectionStrings,
      };

      // Observe.
      let observed = yield* getContainer(
        subscriptionId,
        resourceGroup,
        siteName,
        slot,
        containerName,
      );

      // Ensure + sync with one synchronous upsert. The registry password is
      // write-only, so its change is detected against the previous props.
      if (
        observed === undefined ||
        !matchesDesired(desired, observed.properties) ||
        password !== reveal(olds?.passwordSecret)
      ) {
        const where = {
          ...siteWhere(subscriptionId, resourceGroup, siteName),
          containerName,
          properties: { ...desired, passwordSecret: password },
        };
        observed =
          slot === undefined
            ? yield* web.WebAppsCreateOrUpdateSiteContainer(where)
            : yield* web.WebAppsCreateOrUpdateSiteContainerSlot({
                ...where,
                slot,
              });
      }
      return toAttrs(resourceGroup, siteName, slot, containerName, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
        containerName: output.containerName,
      };
      yield* ignoreNotFound(
        output.slot === undefined
          ? web.DeleteWebAppSiteContainer(where)
          : web.DeleteWebAppSiteContainerSlot({ ...where, slot: output.slot }),
      );
      yield* waitUntilGone(
        `site container ${output.containerName}`,
        getContainer(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slot,
          output.containerName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
