import * as Layer from "effect/Layer";
import { Cluster, ClusterProvider } from "./Cluster.ts";
import { DataExport, DataExportProvider } from "./DataExport.ts";
import { DataSource, DataSourceProvider } from "./DataSource.ts";
import { LinkedService, LinkedServiceProvider } from "./LinkedService.ts";
import { LinkedStorageAccount, LinkedStorageAccountProvider } from "./LinkedStorageAccount.ts";
import { Query, QueryProvider } from "./Query.ts";
import { QueryPack, QueryPackProvider } from "./QueryPack.ts";
import { SavedSearch, SavedSearchProvider } from "./SavedSearch.ts";
import { StorageInsightConfig, StorageInsightConfigProvider } from "./StorageInsightConfig.ts";
import { SummaryRule, SummaryRuleProvider } from "./SummaryRule.ts";
import { Table, TableProvider } from "./Table.ts";
import { Workspace, WorkspaceProvider } from "./Workspace.ts";

export const resources = [
  Cluster,
  DataExport,
  DataSource,
  LinkedService,
  LinkedStorageAccount,
  Query,
  QueryPack,
  SavedSearch,
  StorageInsightConfig,
  SummaryRule,
  Table,
  Workspace,
];
export const layers = () =>
  Layer.mergeAll(
    ClusterProvider(),
    DataExportProvider(),
    DataSourceProvider(),
    LinkedServiceProvider(),
    LinkedStorageAccountProvider(),
    QueryProvider(),
    QueryPackProvider(),
    SavedSearchProvider(),
    StorageInsightConfigProvider(),
    SummaryRuleProvider(),
    TableProvider(),
    WorkspaceProvider(),
  );
