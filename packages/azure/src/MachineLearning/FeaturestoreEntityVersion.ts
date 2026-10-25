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

/**
 * Azure drops `properties` and ignores the archive flag on feature store
 * versions, and limits `tags` to 3 with keys of letters, digits, `.`, `-`,
 * and `_`.
 */
export interface FeaturestoreEntityVersionProps extends Omit<
  AssetVersionProps,
  "properties" | "isArchived"
> {
  /** Index columns of the entity. Changing them replaces the version. */
  indexColumns: FeaturestoreIndexColumn[];
  /**
   * Lifecycle stage label of the version (e.g. `Development`).
   * @default none
   */
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
 * not exist.
 *
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/concept-what-is-managed-feature-store).
 *
 * Versions are immutable: only the description, tags, and stage update in
 * place. Azure accepts at most 3 tags with keys of letters, digits, `.`,
 * `-`, and `_`, which rules out Alchemy's `alchemy::*` ownership tags, so
 * the feature store workspace's stack/stage tags mark Alchemy ownership.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `name`, `version`, or any content
 * prop replaces the version. Azure never reuses a deleted version id, so
 * bump `version` when the content changes: at the same `name` and
 * `version` the old version is deleted and the new one is rejected
 * ("Asset ... was deleted").
 * :::
 *
 * ### Registering a Feature store entity version
 * **Example:** Feature store entity version in a workspace
 * ```typescript
 * // An existing Application Insights component for workspace telemetry.
 * const insightsId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/monitoring/providers/Microsoft.Insights/components/ml-insights";
 * const storage = yield* Azure.Storage.StorageAccount("artifacts");
 * const vault = yield* Azure.KeyVault.Vault("secrets", { enableRbacAuthorization: false });
 * const featureStore = yield* Azure.MachineLearning.Workspace("featureStore", {
 *   kind: "FeatureStore",
 *   storageAccount: storage.storageAccountId,
 *   keyVault: vault.vaultId,
 *   applicationInsights: insightsId,
 * });
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
    versionProvider("feature store entity version", ops, {
      workspaceOnly: true,
      untaggedInWorkspace: true,
    }),
  );
