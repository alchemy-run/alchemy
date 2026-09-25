import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { AnnotationStore } from "./AnnotationStore.ts";
import type { ReferenceStore } from "./ReferenceStore.ts";
import type { RunGroup } from "./RunGroup.ts";
import type { SequenceStore } from "./SequenceStore.ts";
import type { VariantStore } from "./VariantStore.ts";
import type { Workflow } from "./Workflow.ts";

/**
 * Dashboard UI providers for AWS Omics resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const AnnotationStoreUI = UIProvider.succeed<AnnotationStore>(
  "AWS.Omics.AnnotationStore",
  {
    displayName: "HealthOmics Annotation Store",
    icon: "tags",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.annotationStoreId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.annotationStoreArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "format", value: ctx.props?.storeFormat },
    ],
  },
);

export const ReferenceStoreUI = UIProvider.succeed<ReferenceStore>(
  "AWS.Omics.ReferenceStore",
  {
    displayName: "HealthOmics Reference Store",
    icon: "book-open",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.referenceStoreId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.referenceStoreArn,
        mono: true,
        copy: true,
      },
      { label: "created", value: ctx.attrs?.creationTime },
    ],
  },
);

export const RunGroupUI = UIProvider.succeed<RunGroup>("AWS.Omics.RunGroup", {
  displayName: "HealthOmics Run Group",
  icon: "layers",
  color: "#01A88D",
  category: "ai",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.runGroupId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.runGroupArn, mono: true, copy: true },
    { label: "max cpus", value: ctx.props?.maxCpus },
    { label: "max runs", value: ctx.props?.maxRuns },
  ],
});

export const SequenceStoreUI = UIProvider.succeed<SequenceStore>(
  "AWS.Omics.SequenceStore",
  {
    displayName: "HealthOmics Sequence Store",
    icon: "scroll-text",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.sequenceStoreId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.sequenceStoreArn,
        mono: true,
        copy: true,
      },
      { label: "created", value: ctx.attrs?.creationTime },
    ],
  },
);

export const VariantStoreUI = UIProvider.succeed<VariantStore>(
  "AWS.Omics.VariantStore",
  {
    displayName: "HealthOmics Variant Store",
    icon: "git-branch",
    color: "#01A88D",
    category: "ai",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      {
        label: "id",
        value: ctx.attrs?.variantStoreId,
        mono: true,
        copy: true,
      },
      {
        label: "arn",
        value: ctx.attrs?.variantStoreArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      {
        label: "reference",
        value: ctx.props?.reference?.referenceArn,
        mono: true,
      },
    ],
  },
);

export const WorkflowUI = UIProvider.succeed<Workflow>("AWS.Omics.Workflow", {
  displayName: "HealthOmics Workflow",
  icon: "workflow",
  color: "#01A88D",
  category: "ai",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.name, copy: true },
    { label: "id", value: ctx.attrs?.workflowId, mono: true, copy: true },
    { label: "arn", value: ctx.attrs?.workflowArn, mono: true, copy: true },
    { label: "status", value: ctx.attrs?.status },
    { label: "engine", value: ctx.props?.engine },
  ],
});

export const ui = () =>
  Layer.mergeAll(
    AnnotationStoreUI,
    ReferenceStoreUI,
    RunGroupUI,
    SequenceStoreUI,
    VariantStoreUI,
    WorkflowUI,
  );
