import * as Layer from "effect/Layer";
import {
  AdvancedPlatformMetrics,
  AdvancedPlatformMetricsProvider,
} from "./AdvancedPlatformMetrics.ts";
import { BlobContainer, BlobContainerProvider } from "./BlobContainer.ts";
import {
  BlobInventoryPolicy,
  BlobInventoryPolicyProvider,
} from "./BlobInventoryPolicy.ts";
import {
  BlobServiceProperties,
  BlobServicePropertiesProvider,
} from "./BlobServiceProperties.ts";
import { EncryptionScope, EncryptionScopeProvider } from "./EncryptionScope.ts";
import {
  FileServiceProperties,
  FileServicePropertiesProvider,
} from "./FileServiceProperties.ts";
import { FileShare, FileShareProvider } from "./FileShare.ts";
import { LocalUser, LocalUserProvider } from "./LocalUser.ts";
import {
  ManagementPolicy,
  ManagementPolicyProvider,
} from "./ManagementPolicy.ts";
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
import { Table, TableProvider } from "./Table.ts";
import {
  TableServiceProperties,
  TableServicePropertiesProvider,
} from "./TableServiceProperties.ts";

export const resources = [
  AdvancedPlatformMetrics,
  BlobContainer,
  BlobInventoryPolicy,
  BlobServiceProperties,
  EncryptionScope,
  FileServiceProperties,
  FileShare,
  LocalUser,
  ManagementPolicy,
  ObjectReplicationPolicy,
  PrivateEndpointConnection,
  Queue,
  QueueServiceProperties,
  StorageAccount,
  Table,
  TableServiceProperties,
];
export const layers = () =>
  Layer.mergeAll(
    AdvancedPlatformMetricsProvider(),
    BlobContainerProvider(),
    BlobInventoryPolicyProvider(),
    BlobServicePropertiesProvider(),
    EncryptionScopeProvider(),
    FileServicePropertiesProvider(),
    FileShareProvider(),
    LocalUserProvider(),
    ManagementPolicyProvider(),
    ObjectReplicationPolicyProvider(),
    PrivateEndpointConnectionProvider(),
    QueueProvider(),
    QueueServicePropertiesProvider(),
    StorageAccountProvider(),
    TableProvider(),
    TableServicePropertiesProvider(),
  );
