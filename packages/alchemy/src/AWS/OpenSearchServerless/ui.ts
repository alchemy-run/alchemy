import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AccessPolicy } from "./AccessPolicy.ts";
import type { Collection } from "./Collection.ts";
import type { CollectionGroup } from "./CollectionGroup.ts";
import type { LifecyclePolicy } from "./LifecyclePolicy.ts";
import type { SecurityConfig } from "./SecurityConfig.ts";
import type { SecurityPolicy } from "./SecurityPolicy.ts";
import type { VpcEndpoint } from "./VpcEndpoint.ts";

/**
 * Dashboard UI providers for AWS OpenSearchServerless resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Analytics (OpenSearch Serverless) brand purple. */
const COLOR = "#8C4FFF";

export const CollectionUI = UIProvider.succeed<Collection>(
  "AWS.OpenSearchServerless.Collection",
  {
    displayName: "OpenSearch Serverless Collection",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.collectionName,
    link: (ctx) => ctx.attrs?.collectionEndpoint,
    facts: (ctx) => [
      { label: "collection", value: ctx.attrs?.collectionName, copy: true },
      { label: "id", value: ctx.attrs?.collectionId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.collectionArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.attrs?.type },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "endpoint",
        value: ctx.attrs?.collectionEndpoint,
        mono: true,
        copy: true,
      },
      { label: "dashboard", value: ctx.attrs?.dashboardEndpoint, mono: true },
      { label: "kms key", value: ctx.attrs?.kmsKeyArn, mono: true },
    ],
  },
);

export const CollectionGroupUI = UIProvider.succeed<CollectionGroup>(
  "AWS.OpenSearchServerless.CollectionGroup",
  {
    displayName: "OpenSearch Serverless Collection Group",
    icon: "boxes",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.collectionGroupName,
    facts: (ctx) => [
      { label: "group", value: ctx.attrs?.collectionGroupName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.collectionGroupId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.collectionGroupArn,
        mono: true,
        copy: true,
      },
      { label: "standby replicas", value: ctx.attrs?.standbyReplicas },
      { label: "collections", value: ctx.attrs?.numberOfCollections },
    ],
  },
);

export const AccessPolicyUI = UIProvider.succeed<AccessPolicy>(
  "AWS.OpenSearchServerless.AccessPolicy",
  {
    displayName: "OpenSearch Serverless Access Policy",
    icon: "shield-check",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyName, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "version", value: ctx.attrs?.policyVersion, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const SecurityPolicyUI = UIProvider.succeed<SecurityPolicy>(
  "AWS.OpenSearchServerless.SecurityPolicy",
  {
    displayName: "OpenSearch Serverless Security Policy",
    icon: "shield",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyName, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "version", value: ctx.attrs?.policyVersion, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const LifecyclePolicyUI = UIProvider.succeed<LifecyclePolicy>(
  "AWS.OpenSearchServerless.LifecyclePolicy",
  {
    displayName: "OpenSearch Serverless Lifecycle Policy",
    icon: "clock",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.policyName,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyName, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "version", value: ctx.attrs?.policyVersion, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const SecurityConfigUI = UIProvider.succeed<SecurityConfig>(
  "AWS.OpenSearchServerless.SecurityConfig",
  {
    displayName: "OpenSearch Serverless Security Config",
    icon: "fingerprint",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.configName,
    facts: (ctx) => [
      { label: "config", value: ctx.attrs?.configName, copy: true },
      { label: "id", value: ctx.attrs?.configId, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "version", value: ctx.attrs?.configVersion, mono: true },
      { label: "description", value: ctx.attrs?.description },
    ],
  },
);

export const VpcEndpointUI = UIProvider.succeed<VpcEndpoint>(
  "AWS.OpenSearchServerless.VpcEndpoint",
  {
    displayName: "OpenSearch Serverless VPC Endpoint",
    icon: "network",
    color: COLOR,
    category: "network",
    summary: (ctx) => ctx.attrs?.endpointName,
    facts: (ctx) => [
      { label: "endpoint", value: ctx.attrs?.endpointName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.vpcEndpointId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "vpc", value: ctx.props?.vpcId, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    CollectionUI,
    CollectionGroupUI,
    AccessPolicyUI,
    SecurityPolicyUI,
    LifecyclePolicyUI,
    SecurityConfigUI,
    VpcEndpointUI,
  );
