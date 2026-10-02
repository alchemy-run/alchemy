import * as kusto from "@distilled.cloud/azure/azure_kusto";
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
import {
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  whileClusterBusy,
} from "./common.ts";

export interface SandboxCustomImageProps {
  /** Resource group of the cluster. Changing it replaces the image. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the image. */
  cluster: string;
  /**
   * Image name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the image.
   */
  name?: string;
  /**
   * Language of the image. Changing it replaces the image.
   * @default "Python"
   */
  language?: "Python";
  /**
   * Language version, e.g. `3.10.8`. Set either `languageVersion` or
   * `baseImageName`.
   */
  languageVersion?: string;
  /**
   * Base image to extend, e.g. `Python3_10_8` or another custom image's
   * name. Set either `languageVersion` or `baseImageName`.
   */
  baseImageName?: string;
  /**
   * Contents of a pip `requirements.txt` with the packages to install.
   */
  requirementsFileContent?: string;
}

export interface SandboxCustomImage extends Resource<
  "Azure.Kusto.SandboxCustomImage",
  SandboxCustomImageProps,
  {
    /** Name of the image. */
    sandboxCustomImageName: string;
    /** ARM resource ID of the image. */
    sandboxCustomImageId: string;
    /** Cluster that owns the image. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Language of the image. */
    language: string;
    /** Language version, if set. */
    languageVersion: string | undefined;
    /** Base image, if set. */
    baseImageName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A custom Python sandbox image for an Azure Data Explorer (Kusto)
 * cluster: a language version or base image plus extra pip packages, used
 * by the `python()` plugin. The cluster must have the Python language
 * extension enabled. Building an image takes several minutes.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/language-extensions#create-a-custom-image
 *
 * ### Custom Python Images
 * **Example:** Python image with extra packages
 * ```typescript
 * const cluster = yield* Azure.Kusto.Cluster("adx", {
 *   resourceGroup: group.resourceGroupName,
 *   languageExtensions: [{ name: "PYTHON", imageName: "Python3_10_8" }],
 * });
 * const image = yield* Azure.Kusto.SandboxCustomImage("ml", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   languageVersion: "3.10.8",
 *   requirementsFileContent: "scikit-learn==1.3.0\n",
 * });
 * ```
 *
 * @resource
 */
export const SandboxCustomImage = Resource<SandboxCustomImage>(
  "Azure.Kusto.SandboxCustomImage",
);

const getImage = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  sandboxCustomImageName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetSandboxCustomImage({
      subscriptionId,
      resourceGroupName,
      clusterName,
      sandboxCustomImageName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  image: kusto.GetSandboxCustomImageResponse,
): SandboxCustomImage["Attributes"] => ({
  sandboxCustomImageName: name,
  sandboxCustomImageId: image.id ?? "",
  cluster,
  resourceGroup,
  language: image.properties?.language ?? "",
  languageVersion: image.properties?.languageVersion,
  baseImageName: image.properties?.baseImageName,
});

export const SandboxCustomImageProvider = () =>
  Provider.succeed(SandboxCustomImage, {
    stables: [
      "sandboxCustomImageName",
      "sandboxCustomImageId",
      "cluster",
      "resourceGroup",
    ],

    // Images live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.cluster !== output.cluster ||
        (news.name !== undefined &&
          news.name !== output.sandboxCustomImageName) ||
        (output.language !== "" &&
          (news.language ?? "Python") !== output.language)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.sandboxCustomImageName ??
        olds?.name ??
        (yield* createKustoChildName(id));
      const observed = yield* getImage(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return output !== undefined ||
        (yield* isClusterOwnedByStack(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ??
        output?.sandboxCustomImageName ??
        (yield* createKustoChildName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        sandboxCustomImageName: name,
      };
      const properties: kusto.SandboxCustomImageProperties = {
        language: news.language ?? "Python",
        languageVersion: news.languageVersion,
        baseImageName: news.baseImageName,
        requirementsFileContent: news.requirementsFileContent,
      };
      const get = getImage(subscriptionId, resourceGroup, cluster, name);
      // Image builds take several minutes.
      const waitReady = waitForProvisioned(
        `kusto sandbox custom image ${name}`,
        get,
        (i) => i.properties?.provisioningState,
        { interval: "15 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* kusto
          .SandboxCustomImagesCreateOrUpdate({ ...where, properties })
          .pipe(Effect.retry(whileClusterBusy));
      }
      observed = yield* waitReady;

      // Sync version, base image, and requirements against observed state.
      const props = observed.properties;
      if (
        (news.languageVersion !== undefined &&
          props?.languageVersion !== news.languageVersion) ||
        (news.baseImageName !== undefined &&
          props?.baseImageName !== news.baseImageName) ||
        (news.requirementsFileContent !== undefined &&
          props?.requirementsFileContent !== news.requirementsFileContent)
      ) {
        yield* kusto
          .UpdateSandboxCustomImage({ ...where, properties })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, cluster, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteSandboxCustomImage({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.cluster,
            sandboxCustomImageName: output.sandboxCustomImageName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `kusto sandbox custom image ${output.sandboxCustomImageName}`,
        getImage(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.sandboxCustomImageName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
