import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Namespace } from "./Namespace.ts";
import type { Workgroup } from "./Workgroup.ts";

/**
 * Dashboard UI providers for AWS RedshiftServerless resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

const COLOR = "#C925D1";

export const NamespaceUI = UIProvider.succeed<Namespace>(
  "AWS.RedshiftServerless.Namespace",
  {
    displayName: "Redshift Serverless Namespace",
    icon: "database",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.namespaceName,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.namespaceName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.namespaceId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.namespaceArn,
        mono: true,
        copy: true,
      },
      { label: "db name", value: ctx.attrs?.dbName },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "admin secret",
        value: ctx.attrs?.adminPasswordSecretArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const WorkgroupUI = UIProvider.succeed<Workgroup>(
  "AWS.RedshiftServerless.Workgroup",
  {
    displayName: "Redshift Serverless Workgroup",
    icon: "cpu",
    color: COLOR,
    category: "database",
    summary: (ctx) => ctx.attrs?.workgroupName,
    facts: (ctx) => [
      { label: "workgroup", value: ctx.attrs?.workgroupName, copy: true },
      {
        label: "id",
        value: ctx.attrs?.workgroupId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.workgroupArn,
        mono: true,
        copy: true,
      },
      { label: "namespace", value: ctx.attrs?.namespaceName, mono: true },
      { label: "status", value: ctx.attrs?.status },
      { label: "endpoint", value: ctx.attrs?.endpointAddress, mono: true },
      { label: "port", value: ctx.attrs?.endpointPort },
    ],
  },
);

export const ui = () => Layer.mergeAll(NamespaceUI, WorkgroupUI);
