import * as Layer from "effect/Layer";
import {
  AdvancedPlatformMetrics,
  AdvancedPlatformMetricsProvider,
} from "./AdvancedPlatformMetrics.ts";
import {
  BlobAccessPointConfiguration,
  BlobAccessPointConfigurationProvider,
} from "./BlobAccessPointConfiguration.ts";
import { BlobContainer, BlobContainerProvider } from "./BlobContainer.ts";
import { BlobInventoryPolicy, BlobInventoryPolicyProvider } from "./BlobInventoryPolicy.ts";
import { BlobServiceProperties, BlobServicePropertiesProvider } from "./BlobServiceProperties.ts";
import { Connector, ConnectorProvider } from "./Connector.ts";
import { ContextCache, ContextCacheProvider } from "./ContextCache.ts";
import { ContextCacheContainer, ContextCacheContainerProvider } from "./ContextCacheContainer.ts";
import { DataShare, DataShareProvider } from "./DataShare.ts";
import { EncryptionScope, EncryptionScopeProvider } from "./EncryptionScope.ts";
import { FileServiceProperties, FileServicePropertiesProvider } from "./FileServiceProperties.ts";
import { FileShare, FileShareProvider } from "./FileShare.ts";
import { ImmutabilityPolicy, ImmutabilityPolicyProvider } from "./ImmutabilityPolicy.ts";
import { LocalUser, LocalUserProvider } from "./LocalUser.ts";
import { ManagementPolicy, ManagementPolicyProvider } from "./ManagementPolicy.ts";
import {
  ObjectReplicationPolicy,
  ObjectReplicationPolicyProvider,
} from "./ObjectReplicationPolicy.ts";
import {
  PrivateEndpointConnection,
  PrivateEndpointConnectionProvider,
} from "./PrivateEndpointConnection.ts";
import { Queue, QueueProvider } from "./Queue.ts";
import {
  QueueServiceProperties,
  QueueServicePropertiesProvider,
} from "./QueueServiceProperties.ts";
import { StorageAccount, StorageAccountProvider } from "./StorageAccount.ts";
import { StorageTaskAssignment, StorageTaskAssignmentProvider } from "./StorageTaskAssignment.ts";
import { Table, TableProvider } from "./Table.ts";
import {
  TableServiceProperties,
  TableServicePropertiesProvider,
} from "./TableServiceProperties.ts";

export const resources = [
  AdvancedPlatformMetrics,
  BlobAccessPointConfiguration,
  BlobContainer,
  BlobInventoryPolicy,
  BlobServiceProperties,
  Connector,
  ContextCache,
  ContextCacheContainer,
  DataShare,
  EncryptionScope,
  FileServiceProperties,
  FileShare,
  ImmutabilityPolicy,
  LocalUser,
  ManagementPolicy,
  ObjectReplicationPolicy,
  PrivateEndpointConnection,
  Queue,
  QueueServiceProperties,
  StorageAccount,
  StorageTaskAssignment,
  Table,
  TableServiceProperties,
];
export const layers = () =>
  Layer.mergeAll(
    AdvancedPlatformMetricsProvider(),
    BlobAccessPointConfigurationProvider(),
    BlobContainerProvider(),
    BlobInventoryPolicyProvider(),
    BlobServicePropertiesProvider(),
    ConnectorProvider(),
    ContextCacheProvider(),
    ContextCacheContainerProvider(),
    DataShareProvider(),
    EncryptionScopeProvider(),
    FileServicePropertiesProvider(),
    FileShareProvider(),
    ImmutabilityPolicyProvider(),
    LocalUserProvider(),
    ManagementPolicyProvider(),
    ObjectReplicationPolicyProvider(),
    PrivateEndpointConnectionProvider(),
    QueueProvider(),
    QueueServicePropertiesProvider(),
    StorageAccountProvider(),
    StorageTaskAssignmentProvider(),
    TableProvider(),
    TableServicePropertiesProvider(),
  );
