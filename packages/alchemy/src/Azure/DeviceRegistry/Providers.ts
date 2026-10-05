import * as Layer from "effect/Layer";
import { Asset, AssetProvider } from "./Asset.ts";
import {
  AssetEndpointProfile,
  AssetEndpointProfileProvider,
} from "./AssetEndpointProfile.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { NamespaceAsset, NamespaceAssetProvider } from "./NamespaceAsset.ts";
import { NamespaceDevice, NamespaceDeviceProvider } from "./NamespaceDevice.ts";
import { Schema, SchemaProvider } from "./Schema.ts";
import { SchemaRegistry, SchemaRegistryProvider } from "./SchemaRegistry.ts";
import { SchemaVersion, SchemaVersionProvider } from "./SchemaVersion.ts";

export const resources = [
  Asset,
  AssetEndpointProfile,
  Namespace,
  NamespaceAsset,
  NamespaceDevice,
  Schema,
  SchemaRegistry,
  SchemaVersion,
];
export const layers = () =>
  Layer.mergeAll(
    AssetProvider(),
    AssetEndpointProfileProvider(),
    NamespaceProvider(),
    NamespaceAssetProvider(),
    NamespaceDeviceProvider(),
    SchemaProvider(),
    SchemaRegistryProvider(),
    SchemaVersionProvider(),
  );
