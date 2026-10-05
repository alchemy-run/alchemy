import * as desktopvirtualization from "@distilled.cloud/azure/desktopvirtualization";
import * as Effect from "effect/Effect";
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
import { getApplicationGroup } from "./ApplicationGroup.ts";
import { createAvdName, deltaOf, ownedByStage } from "./Common.ts";

export interface ApplicationProps {
  /**
   * Resource group of the application group. Changing it replaces the
   * application.
   */
  resourceGroup: string;
  /**
   * Name of the `RemoteApp` application group that publishes the
   * application. Changing it replaces the application.
   */
  applicationGroup: string;
  /**
   * Application name, 3-24 letters, digits, `@`, `.`, `-`, `_`, or spaces.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the application.
   */
  name?: string;
  /**
   * `InBuilt` publishes an executable installed on the session hosts;
   * `MsixApplication` publishes an app from an MSIX package. Changing it
   * replaces the application.
   * @default "InBuilt"
   */
  applicationType?: "InBuilt" | "MsixApplication";
  /** Path of the executable on the session hosts, e.g. `C:\Windows\System32\notepad.exe`. */
  filePath?: string;
  /**
   * Whether the client may pass command line arguments: never, optionally,
   * or always (`commandLineArguments`).
   */
  commandLineSetting: "DoNotAllow" | "Allow" | "Require";
  /** Command line arguments passed to the application. */
  commandLineArguments?: string;
  /** Display name shown to users. */
  friendlyName?: string;
  /** Description of the application. */
  description?: string;
  /** Whether the application appears in the RD Web Access portal. */
  showInPortal?: boolean;
  /** Path of the icon file on the session hosts. */
  iconPath?: string;
  /** Index of the icon inside `iconPath`. */
  iconIndex?: number;
  /** Package family name of an MSIX application. */
  msixPackageFamilyName?: string;
  /** Application ID inside the MSIX package. */
  msixPackageApplicationId?: string;
}

export interface Application extends Resource<
  "Azure.DesktopVirtualization.Application",
  ApplicationProps,
  {
    /** Name of the application. */
    applicationName: string;
    /** ARM resource ID of the application. */
    applicationId: string;
    /** Resource group of the application group. */
    resourceGroup: string;
    /** Name of the application group. */
    applicationGroup: string;
    /** Application type. */
    applicationType: string;
    /** Internal object ID of the application. */
    objectId: string | undefined;
    /** Hash of the application's icon. */
    iconHash: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A RemoteApp application published by an Azure Virtual Desktop
 * `RemoteApp` application group. The executable must exist on the host
 * pool's session hosts for users to launch it; the application object
 * itself is metadata and can be created before any session host exists.
 *
 * Applications have no tags; Alchemy treats an application as owned when
 * its application group carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/virtual-desktop/manage-app-groups
 *
 * ### Publishing an Application
 * **Example:** Publish Notepad
 * ```typescript
 * const notepad = yield* Azure.DesktopVirtualization.Application("notepad", {
 *   resourceGroup: group.resourceGroupName,
 *   applicationGroup: apps.applicationGroupName,
 *   filePath: "C:\\Windows\\System32\\notepad.exe",
 *   commandLineSetting: "DoNotAllow",
 *   friendlyName: "Notepad",
 * });
 * ```
 *
 * **Example:** Require command line arguments
 * ```typescript
 * const edge = yield* Azure.DesktopVirtualization.Application("intranet", {
 *   resourceGroup: group.resourceGroupName,
 *   applicationGroup: apps.applicationGroupName,
 *   filePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
 *   commandLineSetting: "Require",
 *   commandLineArguments: "https://intranet.contoso.com",
 * });
 * ```
 *
 * @resource
 */
export const Application = Resource<Application>(
  "Azure.DesktopVirtualization.Application",
);

type ObservedApplication = desktopvirtualization.GetApplicationResponse;

const getApplication = (
  subscriptionId: string,
  resourceGroupName: string,
  applicationGroupName: string,
  applicationName: string,
) =>
  orUndefinedIfNotFound(
    desktopvirtualization.GetApplication({
      subscriptionId,
      resourceGroupName,
      applicationGroupName,
      applicationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  applicationGroup: string,
  name: string,
  app: ObservedApplication,
): Application["Attributes"] => ({
  applicationName: name,
  applicationId: app.id ?? "",
  resourceGroup,
  applicationGroup,
  applicationType: app.properties?.applicationType ?? "InBuilt",
  objectId: app.properties?.objectId,
  iconHash: app.properties?.iconHash,
});

const desiredProperties = (news: ApplicationProps) => ({
  filePath: news.filePath,
  commandLineSetting: news.commandLineSetting,
  commandLineArguments: news.commandLineArguments,
  friendlyName: news.friendlyName,
  description: news.description,
  showInPortal: news.showInPortal,
  iconPath: news.iconPath,
  iconIndex: news.iconIndex,
  msixPackageFamilyName: news.msixPackageFamilyName,
  msixPackageApplicationId: news.msixPackageApplicationId,
});

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: [
      "applicationName",
      "applicationId",
      "resourceGroup",
      "applicationGroup",
      "applicationType",
      "objectId",
    ],

    // Applications are removed with their application group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.applicationGroup.toLowerCase() !==
          output.applicationGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.applicationName.toLowerCase()) ||
        (news.applicationType ?? "InBuilt").toLowerCase() !==
          output.applicationType.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const applicationGroup =
        output?.applicationGroup ?? olds?.applicationGroup;
      if (resourceGroup === undefined || applicationGroup === undefined) {
        return undefined;
      }
      const name =
        output?.applicationName ?? olds?.name ?? (yield* createAvdName(id, 24));
      const observed = yield* getApplication(
        subscriptionId,
        resourceGroup,
        applicationGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, applicationGroup, name, observed);
      const parent = yield* getApplicationGroup(
        subscriptionId,
        resourceGroup,
        applicationGroup,
      );
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.DesktopVirtualization",
      );
      const { resourceGroup, applicationGroup } = news;
      const name =
        news.name ?? output?.applicationName ?? (yield* createAvdName(id, 24));
      const desired = desiredProperties(news);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        applicationGroupName: applicationGroup,
        applicationName: name,
      };

      // Observe.
      let observed: ObservedApplication | undefined = yield* getApplication(
        subscriptionId,
        resourceGroup,
        applicationGroup,
        name,
      );

      if (observed === undefined) {
        // Ensure: the PUT is synchronous.
        observed = yield* desktopvirtualization.ApplicationsCreateOrUpdate({
          ...request,
          properties: {
            ...desired,
            applicationType: news.applicationType ?? "InBuilt",
          },
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const delta = deltaOf(desired, observed.properties);
        if (delta !== undefined) {
          observed = yield* desktopvirtualization.UpdateApplication({
            ...request,
            properties: delta,
          });
        }
      }

      return toAttrs(resourceGroup, applicationGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        desktopvirtualization.DeleteApplication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          applicationGroupName: output.applicationGroup,
          applicationName: output.applicationName,
        }),
      );
      yield* waitUntilGone(
        `application ${output.applicationName}`,
        getApplication(
          subscriptionId,
          output.resourceGroup,
          output.applicationGroup,
          output.applicationName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DesktopVirtualization.ApplicationGroup",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
