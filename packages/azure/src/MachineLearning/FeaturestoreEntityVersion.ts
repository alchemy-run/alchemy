import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  versionProvider,
  type AssetVersionAttributes,
  type AssetVersionProps,
  type VersionOps,
  workspacePath,
} from "./internal.ts";

export interface FeaturestoreIndexColumn {
  /** Column name. */
  columnName: string;
  /** Column data type. */
  dataType: "String" | "Integer" | "Long" | "Float" | "Double" | "Binary" | "Datetime" | "Boolean";
}

export interface FeaturestoreEntityVersionProps extends AssetVersionProps {
  /** Index columns of the entity. Changing them replaces the version. */
  indexColumns: FeaturestoreIndexColumn[];
  /** Lifecycle stage label of the version (e.g. `Development`). */
  stage?: string;
}

export interface FeaturestoreEntityVersion extends Resource<
  "Azure.MachineLearning.FeaturestoreEntityVersion",
  FeaturestoreEntityVersionProps,
  AssetVersionAttributes,
  never,
  Providers
> {}

/**
 * A feature store entity version in an Azure Machine Learning `FeatureStore`
 * workspace
 * (`Microsoft.MachineLearningServices/workspaces/featurestoreEntities/versions`)
 * — an immutable set of index columns that feature sets join on. Azure
 * creates the {@link FeaturestoreEntityContainer} named by `name` if it does
 * not exist; declare one to manage its description and tags.
 *
 * Versions are immutable: only the description, tags, archive flag, and
 * stage update in place.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `name`, `version`, or any content
 * prop replaces the version. When `name` and `version` stay the same, the
 * old version is deleted before the new one is created.
 * :::
 *
 * @see https://learn.microsoft.com/azure/machine-learning/concept-what-is-managed-feature-store
 *
 * ### Registering a Feature store entity version
 * **Example:** Feature store entity version in a workspace
 * ```typescript
 * const account = yield* Azure.MachineLearning.FeaturestoreEntityVersion("account-v1", {
 *   workspace: featureStore.workspaceName,
 *   name: "account",
 *   version: "1",
 *   indexColumns: [{ columnName: "accountID", dataType: "String" }],
 * });
 * ```
 *
 * @resource
 */
export const FeaturestoreEntityVersion = GroupedResource<FeaturestoreEntityVersion>(
  "Azure.MachineLearning.FeaturestoreEntityVersion",
);

const ops: VersionOps<FeaturestoreEntityVersionProps> = {
  get: (s) => ml.GetFeaturestoreEntityVersion({ ...workspacePath(s), version: s.version }),
  put: (s, body, news) =>
    ml.FeaturestoreEntityVersionsCreateOrUpdate({
      ...workspacePath(s),
      version: s.version,
      properties: {
        ...body,
        indexColumns: news.indexColumns,
      },
    }),
  delete: (s) => ml.DeleteFeaturestoreEntityVersion({ ...workspacePath(s), version: s.version }),
  stageOf: (news) => news.stage,
};

export const FeaturestoreEntityVersionProvider = () =>
  Provider.succeed(
    FeaturestoreEntityVersion,
    versionProvider("feature store entity version", ops, { workspaceOnly: true }),
  );
