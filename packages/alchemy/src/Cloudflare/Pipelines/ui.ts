import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LegacyPipeline } from "./LegacyPipeline.ts";
import type { Pipeline } from "./Pipeline.ts";
import type { Sink } from "./Sink.ts";
import type { Stream } from "./Stream.ts";

/**
 * Dashboard UI providers for Cloudflare Pipelines resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no Cloudflare SDK code reaches the dashboard bundle.
 */
export const StreamUI = UIProvider.succeed<Stream>(
  "Cloudflare.Pipelines.Stream",
  {
    displayName: "Pipelines Stream",
    icon: "waves",
    color: "#F6821F",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) => ctx.attrs?.endpoint,
    facts: (ctx) => [
      { label: "stream", value: ctx.attrs?.name, mono: true, copy: true },
      {
        label: "stream id",
        value: ctx.attrs?.streamId,
        mono: true,
        copy: true,
      },
      {
        label: "endpoint",
        value: ctx.attrs?.endpoint,
        href: ctx.attrs?.endpoint,
        copy: true,
      },
      { label: "http enabled", value: ctx.attrs?.httpEnabled },
      { label: "http auth", value: ctx.attrs?.httpAuthentication },
      { label: "worker binding", value: ctx.attrs?.workerBindingEnabled },
      { label: "version", value: ctx.attrs?.version },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const PipelineUI = UIProvider.succeed<Pipeline>(
  "Cloudflare.Pipelines.Pipeline",
  {
    displayName: "Pipeline",
    icon: "workflow",
    color: "#F6821F",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "pipeline", value: ctx.attrs?.name, mono: true, copy: true },
      {
        label: "pipeline id",
        value: ctx.attrs?.pipelineId,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "sql", value: ctx.attrs?.sql, mono: true },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const SinkUI = UIProvider.succeed<Sink>("Cloudflare.Pipelines.Sink", {
  displayName: "Pipelines Sink",
  icon: "archive",
  color: "#F6821F",
  category: "storage",
  summary: (ctx) => ctx.attrs?.name,
  facts: (ctx) => [
    { label: "sink", value: ctx.attrs?.name, mono: true, copy: true },
    { label: "sink id", value: ctx.attrs?.sinkId, mono: true, copy: true },
    { label: "type", value: ctx.attrs?.type },
    { label: "bucket", value: ctx.attrs?.bucket, mono: true },
    { label: "path", value: ctx.attrs?.path, mono: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true, copy: true },
  ],
});

export const LegacyPipelineUI = UIProvider.succeed<LegacyPipeline>(
  "Cloudflare.Pipelines.LegacyPipeline",
  {
    displayName: "Legacy Pipeline",
    icon: "history",
    color: "#F6821F",
    category: "eventing",
    summary: (ctx) => ctx.attrs?.name,
    link: (ctx) => ctx.attrs?.endpoint,
    facts: (ctx) => [
      { label: "pipeline", value: ctx.attrs?.name, mono: true, copy: true },
      {
        label: "pipeline id",
        value: ctx.attrs?.pipelineId,
        mono: true,
        copy: true,
      },
      {
        label: "endpoint",
        value: ctx.attrs?.endpoint,
        href: ctx.attrs?.endpoint,
        copy: true,
      },
      { label: "bucket", value: ctx.attrs?.bucket, mono: true },
      { label: "version", value: ctx.attrs?.version },
      {
        label: "account",
        value: ctx.attrs?.accountId,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(StreamUI, PipelineUI, SinkUI, LegacyPipelineUI);
