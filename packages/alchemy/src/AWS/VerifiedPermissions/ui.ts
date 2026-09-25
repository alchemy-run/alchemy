import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { IdentitySource } from "./IdentitySource.ts";
import type { Policy } from "./Policy.ts";
import type { PolicyStore } from "./PolicyStore.ts";
import type { PolicyStoreAlias } from "./PolicyStoreAlias.ts";
import type { PolicyTemplate } from "./PolicyTemplate.ts";
import type { Schema } from "./Schema.ts";

/**
 * Dashboard UI providers for AWS Verified Permissions resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Security, Identity & Compliance brand red. */
const COLOR = "#DD344C";

export const PolicyStoreUI = UIProvider.succeed<PolicyStore>(
  "AWS.VerifiedPermissions.PolicyStore",
  {
    displayName: "Verified Permissions Policy Store",
    icon: "shield",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.policyStoreId,
    facts: (ctx) => [
      {
        label: "store",
        value: ctx.attrs?.policyStoreId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.policyStoreArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const PolicyUI = UIProvider.succeed<Policy>(
  "AWS.VerifiedPermissions.Policy",
  {
    displayName: "Verified Permissions Policy",
    icon: "scroll-text",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.policyId,
    facts: (ctx) => [
      { label: "policy", value: ctx.attrs?.policyId, mono: true, copy: true },
      { label: "store", value: ctx.attrs?.policyStoreId, mono: true },
    ],
  },
);

export const PolicyStoreAliasUI = UIProvider.succeed<PolicyStoreAlias>(
  "AWS.VerifiedPermissions.PolicyStoreAlias",
  {
    displayName: "Verified Permissions Policy Store Alias",
    icon: "tag",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.aliasName,
    facts: (ctx) => [
      { label: "alias", value: ctx.attrs?.aliasName, copy: true },
      { label: "arn", value: ctx.attrs?.aliasArn, mono: true, copy: true },
      { label: "store", value: ctx.attrs?.policyStoreId, mono: true },
    ],
  },
);

export const PolicyTemplateUI = UIProvider.succeed<PolicyTemplate>(
  "AWS.VerifiedPermissions.PolicyTemplate",
  {
    displayName: "Verified Permissions Policy Template",
    icon: "file-text",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.policyTemplateId,
    facts: (ctx) => [
      {
        label: "template",
        value: ctx.attrs?.policyTemplateId,
        mono: true,
        copy: true,
      },
      { label: "store", value: ctx.attrs?.policyStoreId, mono: true },
    ],
  },
);

export const SchemaUI = UIProvider.succeed<Schema>(
  "AWS.VerifiedPermissions.Schema",
  {
    displayName: "Verified Permissions Schema",
    icon: "code",
    color: COLOR,
    category: "security",
    summary: (ctx) => ctx.attrs?.policyStoreId,
    facts: (ctx) => [
      {
        label: "store",
        value: ctx.attrs?.policyStoreId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const IdentitySourceUI = UIProvider.succeed<IdentitySource>(
  "AWS.VerifiedPermissions.IdentitySource",
  {
    displayName: "Verified Permissions Identity Source",
    icon: "share-2",
    color: COLOR,
    category: "auth",
    summary: (ctx) => ctx.attrs?.identitySourceId,
    facts: (ctx) => [
      {
        label: "identity source",
        value: ctx.attrs?.identitySourceId,
        mono: true,
        copy: true,
      },
      { label: "store", value: ctx.attrs?.policyStoreId, mono: true },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    PolicyStoreUI,
    PolicyUI,
    PolicyStoreAliasUI,
    PolicyTemplateUI,
    SchemaUI,
    IdentitySourceUI,
  );
