import * as batch from "@distilled.cloud/azure/batch";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createBatchChildName } from "./Common.ts";

export interface ApplicationProps {
  /** Resource group of the Batch account. Changing it replaces the application. */
  resourceGroup: string;
  /** Name of the Batch account. Changing it replaces the application. */
  account: string;
  /**
   * Application name: 1-64 letters, digits, hyphens, and underscores,
   * unique within the account. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the application.
   */
  name?: string;
  /** Display name of the application. */
  displayName?: string;
  /**
   * Whether packages of the application may be overwritten using the same
   * version string.
   * @default Azure's default (`true`)
   */
  allowUpdates?: boolean;
  /**
   * Package version used when a pool or task references the application
   * without a version. Must name an existing package of the application, so
   * set it after the package is deployed.
   */
  defaultVersion?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "Azure.Batch.Application",
  ApplicationProps,
  {
    /** Name of the application. */
    applicationName: string;
    /** ARM resource ID of the application; reference it from pool `applicationPackages`. */
    applicationId: string;
    /** Name of the Batch account. */
    account: string;
    /** Resource group of the Batch account. */
    resourceGroup: string;
    /** Display name of the application. */
    displayName: string | undefined;
    /** Whether packages may be overwritten with the same version. */
    allowUpdates: boolean | undefined;
    /** Default package version. */
    defaultVersion: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Batch application — a named, versioned set of application packages
 * (zip files) that Batch deploys to compute nodes of pools and tasks that
 * reference it.
 *
 * @see https://learn.microsoft.com/azure/batch/batch-application-packages
 *
 * ### Creating an Application
 * **Example:** Application in a Batch account
 * ```typescript
 * const app = yield* Azure.Batch.Application("renderer", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   displayName: "Frame renderer",
 *   allowUpdates: false,
 * });
 * ```
 *
 * **Example:** Pin the default version once a package exists
 * ```typescript
 * const app = yield* Azure.Batch.Application("renderer", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   defaultVersion: "1.0.0",
 * });
 * ```
 *
 * @resource
 */
export const Application = Resource<Application>("Azure.Batch.Application");

type ObservedApplication = batch.GetApplicationResponse;

const getApplication = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  applicationName: string,
) =>
  orUndefinedIfNotFound(
    batch.GetApplication({
      subscriptionId,
      resourceGroupName,
      accountName,
      applicationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  app: ObservedApplication,
): Application["Attributes"] => ({
  applicationName: name,
  applicationId: app.id ?? "",
  account,
  resourceGroup,
  displayName: app.properties?.displayName,
  allowUpdates: app.properties?.allowUpdates,
  defaultVersion: app.properties?.defaultVersion,
  tags: userTags(app.tags),
});

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: ["applicationName", "applicationId", "account", "resourceGroup"],

    // Applications are deleted with their Batch account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.applicationName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.applicationName ??
        olds?.name ??
        (yield* createBatchChildName(id));
      const observed = yield* getApplication(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Batch");
      const { resourceGroup, account } = news;
      const name =
        news.name ??
        output?.applicationName ??
        (yield* createBatchChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        applicationName: name,
      };
      const get = getApplication(subscriptionId, resourceGroup, account, name);

      // Observe.
      let observed = yield* get;

      // Ensure: the PUT is a synchronous create.
      if (observed === undefined) {
        observed = yield* batch.CreateApplication({
          ...where,
          tags,
          properties: {
            displayName: news.displayName,
            allowUpdates: news.allowUpdates,
          },
        });
      }

      // Sync mutable properties against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: batch.ApplicationProperties = {};
      if (
        news.displayName !== undefined &&
        props.displayName !== news.displayName
      ) {
        changed.displayName = news.displayName;
      }
      if (
        news.allowUpdates !== undefined &&
        props.allowUpdates !== news.allowUpdates
      ) {
        changed.allowUpdates = news.allowUpdates;
      }
      if (
        news.defaultVersion !== undefined &&
        props.defaultVersion !== news.defaultVersion
      ) {
        changed.defaultVersion = news.defaultVersion;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* batch.UpdateApplication({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
      }

      const fresh = yield* waitForProvisioned(
        `batch application ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        batch.DeleteApplication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.account,
          applicationName: output.applicationName,
        }),
      );
      yield* waitUntilGone(
        `batch application ${output.applicationName}`,
        getApplication(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.applicationName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Batch.Account", "Azure.Resources.ResourceGroup"],
    },
  });
