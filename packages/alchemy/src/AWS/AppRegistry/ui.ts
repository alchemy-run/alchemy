import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Application } from "./Application.ts";
import type { AttributeGroup } from "./AttributeGroup.ts";
import type { AttributeGroupAssociation } from "./AttributeGroupAssociation.ts";
import type { ResourceAssociation } from "./ResourceAssociation.ts";

/**
 * Dashboard UI providers for AWS AppRegistry resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS Management & Governance (AppRegistry) brand pink. */
const COLOR = "#E7157B";

export const ApplicationUI = UIProvider.succeed<Application>(
  "AWS.AppRegistry.Application",
  {
    displayName: "AppRegistry Application",
    icon: "boxes",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.applicationName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.applicationName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.applicationId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.applicationArn,
        mono: true,
        copy: true,
      },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const AttributeGroupUI = UIProvider.succeed<AttributeGroup>(
  "AWS.AppRegistry.AttributeGroup",
  {
    displayName: "AppRegistry Attribute Group",
    icon: "tags",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.attributeGroupName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.attributeGroupName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.attributeGroupId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.attributeGroupArn,
        mono: true,
        copy: true,
      },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const AttributeGroupAssociationUI =
  UIProvider.succeed<AttributeGroupAssociation>(
    "AWS.AppRegistry.AttributeGroupAssociation",
    {
      displayName: "AppRegistry Attribute Group Association",
      icon: "link",
      color: COLOR,
      category: "config",
      summary: (ctx) => ctx.attrs?.attributeGroupId,
      facts: (ctx) => [
        {
          label: "application id",
          value: ctx.attrs?.applicationId,
          mono: true,
          copy: true,
        },
        {
          label: "application arn",
          value: ctx.attrs?.applicationArn,
          mono: true,
        },
        {
          label: "attribute group id",
          value: ctx.attrs?.attributeGroupId,
          mono: true,
          copy: true,
        },
        {
          label: "attribute group arn",
          value: ctx.attrs?.attributeGroupArn,
          mono: true,
        },
      ],
    },
  );

export const ResourceAssociationUI = UIProvider.succeed<ResourceAssociation>(
  "AWS.AppRegistry.ResourceAssociation",
  {
    displayName: "AppRegistry Resource Association",
    icon: "share-2",
    color: COLOR,
    category: "config",
    summary: (ctx) => ctx.attrs?.resourceName,
    facts: (ctx) => [
      { label: "resource", value: ctx.attrs?.resourceName, copy: true },
      {
        label: "resource arn",
        value: ctx.attrs?.resourceArn,
        mono: true,
        copy: true,
      },
      { label: "resource type", value: ctx.attrs?.resourceType },
      {
        label: "application id",
        value: ctx.attrs?.applicationId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ApplicationUI,
    AttributeGroupUI,
    AttributeGroupAssociationUI,
    ResourceAssociationUI,
  );
