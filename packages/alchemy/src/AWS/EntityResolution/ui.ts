import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { IdMappingWorkflow } from "./IdMappingWorkflow.ts";
import type { IdNamespace } from "./IdNamespace.ts";
import type { MatchingWorkflow } from "./MatchingWorkflow.ts";
import type { SchemaMapping } from "./SchemaMapping.ts";

/**
 * Dashboard UI providers for AWS Entity Resolution resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** Entity Resolution brand color (AWS Machine Learning teal). */
const ENTITY_RESOLUTION_COLOR = "#01A88D";

export const IdMappingWorkflowUI = UIProvider.succeed<IdMappingWorkflow>(
  "AWS.EntityResolution.IdMappingWorkflow",
  {
    displayName: "Entity Resolution ID Mapping Workflow",
    icon: "workflow",
    color: ENTITY_RESOLUTION_COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.workflowName,
    facts: (ctx) => [
      { label: "workflow", value: ctx.attrs?.workflowName, copy: true },
      { label: "arn", value: ctx.attrs?.workflowArn, mono: true, copy: true },
      { label: "description", value: ctx.props?.description },
      { label: "role", value: ctx.props?.roleArn, mono: true },
    ],
  },
);

export const IdNamespaceUI = UIProvider.succeed<IdNamespace>(
  "AWS.EntityResolution.IdNamespace",
  {
    displayName: "Entity Resolution ID Namespace",
    icon: "layers",
    color: ENTITY_RESOLUTION_COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.idNamespaceName,
    facts: (ctx) => [
      { label: "namespace", value: ctx.attrs?.idNamespaceName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.idNamespaceArn,
        mono: true,
        copy: true,
      },
      { label: "type", value: ctx.props?.type },
      { label: "role", value: ctx.props?.roleArn, mono: true },
    ],
  },
);

export const MatchingWorkflowUI = UIProvider.succeed<MatchingWorkflow>(
  "AWS.EntityResolution.MatchingWorkflow",
  {
    displayName: "Entity Resolution Matching Workflow",
    icon: "merge",
    color: ENTITY_RESOLUTION_COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.workflowName,
    facts: (ctx) => [
      { label: "workflow", value: ctx.attrs?.workflowName, copy: true },
      { label: "arn", value: ctx.attrs?.workflowArn, mono: true, copy: true },
      {
        label: "resolution type",
        value: ctx.props?.resolutionTechniques?.resolutionType,
      },
      { label: "role", value: ctx.props?.roleArn, mono: true },
    ],
  },
);

export const SchemaMappingUI = UIProvider.succeed<SchemaMapping>(
  "AWS.EntityResolution.SchemaMapping",
  {
    displayName: "Entity Resolution Schema Mapping",
    icon: "table",
    color: ENTITY_RESOLUTION_COLOR,
    category: "ai",
    summary: (ctx) => ctx.attrs?.schemaName,
    facts: (ctx) => [
      { label: "schema", value: ctx.attrs?.schemaName, copy: true },
      { label: "arn", value: ctx.attrs?.schemaArn, mono: true, copy: true },
      { label: "fields", value: ctx.props?.mappedInputFields?.length },
      { label: "description", value: ctx.props?.description },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    IdMappingWorkflowUI,
    IdNamespaceUI,
    MatchingWorkflowUI,
    SchemaMappingUI,
  );
