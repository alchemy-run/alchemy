import * as Layer from "effect/Layer";
import { Asset, AssetProvider } from "./Asset.ts";
import { AssetEndpointProfile, AssetEndpointProfileProvider } from "./AssetEndpointProfile.ts";
import { CertificateAuthority, CertificateAuthorityProvider } from "./CertificateAuthority.ts";
import { CertificatePolicy, CertificatePolicyProvider } from "./CertificatePolicy.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { NamespaceAsset, NamespaceAssetProvider } from "./NamespaceAsset.ts";
import { NamespaceDevice, NamespaceDeviceProvider } from "./NamespaceDevice.ts";
import { RegistryDevice, RegistryDeviceProvider } from "./RegistryDevice.ts";
import { Schema, SchemaProvider } from "./Schema.ts";
import { SchemaRegistry, SchemaRegistryProvider } from "./SchemaRegistry.ts";
import { SchemaVersion, SchemaVersionProvider } from "./SchemaVersion.ts";

export const resources = [
  Asset,
  AssetEndpointProfile,
  CertificateAuthority,
  CertificatePolicy,
  Namespace,
  NamespaceAsset,
  NamespaceDevice,
  RegistryDevice,
  Schema,
  SchemaRegistry,
  SchemaVersion,
];
export const layers = () =>
  Layer.mergeAll(
    AssetProvider(),
    AssetEndpointProfileProvider(),
    CertificateAuthorityProvider(),
    CertificatePolicyProvider(),
    NamespaceProvider(),
    NamespaceAssetProvider(),
    NamespaceDeviceProvider(),
    RegistryDeviceProvider(),
    SchemaProvider(),
    SchemaRegistryProvider(),
    SchemaVersionProvider(),
  );
