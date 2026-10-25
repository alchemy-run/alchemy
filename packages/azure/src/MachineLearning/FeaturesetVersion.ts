import * as ml from "@distilled.cloud/azure/machinelearningservices";
import type { MaterializationSettings } from "@distilled.cloud/azure/machinelearningservices";
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

/** Offline/online materialization of a feature set (schedule, compute, store type). */
export type FeaturesetMaterializationSettings = MaterializationSettings;

/**
 * Azure drops `properties` and ignores the archive flag on feature store
 * versions, and limits `tags` to 3 with keys of letters, digits, `.`, `-`,
 * and `_`.
 */
export interface FeaturesetVersionProps extends Omit<
  AssetVersionProps,
  "properties" | "isArchived"
> {
  /**
   * Path of the feature set specification folder (the folder holding
   * `FeatureSetSpec.yaml`), e.g.
   * `https://<account>.blob.core.windows.net/<container>/featuresets/transactions/spec`.
   * Changing it replaces the version.
   */
  specificationPath: string;
  /**
   * Feature store entities the features join on, as
   * `azureml:<entity>:<version>` references. Changing them replaces the
   * version.
   * @default none
   */
  entities?: string[];
  /**
   * Materialization settings (schedule, compute, store type). Changing them
   * replaces the version.
   * @default none
   */
  materializationSettings?: FeaturesetMaterializationSettings;
  /**
   * Lifecycle stage label of the version (e.g. `Development`).
   * @default none
   */
  stage?: string;
}

export interface FeaturesetVersion extends Resource<
  "Azure.MachineLearning.FeaturesetVersion",
  FeaturesetVersionProps,
  AssetVersionAttributes,
  never,
  Providers
> {}

/**
 * A feature set version in an Azure Machine Learning `FeatureStore`
 * workspace
 * (`Microsoft.MachineLearningServices/workspaces/featuresets/versions`) — an
 * immutable feature set specification (source, transformation, features)
 * joined on feature store entities. Azure creates the
 * {@link FeaturesetContainer} named by `name` if it does not exist.
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
 * prop replaces the version. When `name` and `version` stay the same, the
 * old version is deleted before the new one is created.
 * :::
 *
 * ### Registering a Feature set version
 * **Example:** Feature set version in a workspace
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
 * const transactions = yield* Azure.MachineLearning.FeaturesetVersion("transactions-v1", {
 *   workspace: featureStore.workspaceName,
 *   name: "transactions",
 *   version: "1",
 *   specificationPath: `https://${storage.storageAccountName}.blob.core.windows.net/featurestore/featuresets/transactions/spec`,
 *   entities: ["azureml:account:1"],
 * });
 * ```
 *
 * @resource
 */
export const FeaturesetVersion = GroupedResource<FeaturesetVersion>(
  "Azure.MachineLearning.FeaturesetVersion",
);

const ops: VersionOps<FeaturesetVersionProps> = {
  get: (s) => ml.GetFeaturesetVersion({ ...workspacePath(s), version: s.version }),
  put: (s, body, news) =>
    ml.FeaturesetVersionsCreateOrUpdate({
      ...workspacePath(s),
      version: s.version,
      properties: {
        ...body,
        specification: { path: news.specificationPath },
        entities: news.entities,
        materializationSettings: news.materializationSettings,
      },
    }),
  delete: (s) => ml.DeleteFeaturesetVersion({ ...workspacePath(s), version: s.version }),
  stageOf: (news) => news.stage,
};

export const FeaturesetVersionProvider = () =>
  Provider.succeed(
    FeaturesetVersion,
    versionProvider("feature set version", ops, {
      workspaceOnly: true,
      untaggedInWorkspace: true,
    }),
  );
