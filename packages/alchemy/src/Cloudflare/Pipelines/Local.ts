import { Pipelines } from "@alchemy.run/cloudflare-runtime/core/bindings";
import * as Effect from "effect/Effect";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import { deepEqual, isResolved } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  generateLocalId,
  isLocalId,
  LOCAL_ENTRY_URL,
  LocalRuntimeState,
} from "../LocalRuntime.ts";
import { Stream, type StreamProps, type StreamAttributes } from "./Stream.ts";
import { Sink, type SinkProps, type SinkAttributes } from "./Sink.ts";
import {
  Pipeline,
  type PipelineProps,
  type PipelineAttributes,
} from "./Pipeline.ts";

export interface LocalStream {
  props: StreamProps;
  attributes: StreamAttributes;
}
export interface LocalSink {
  props: SinkProps;
  attributes: SinkAttributes;
}
export interface LocalPipeline {
  props: PipelineProps;
  attributes: PipelineAttributes;
}

const localName = (id: string) =>
  createPhysicalName({ id, lowercase: true, delimiter: "_" }).pipe(
    Effect.map((name) => name.replaceAll(/[^a-zA-Z0-9_]/g, "_")),
  );
const unsupported = (message: string) =>
  Effect.fail(
    new Error(
      `Local Pipelines: ${message}. Use Alchemy.remote() for this configuration.`,
    ),
  );

const validateStream = (props: StreamProps) =>
  Effect.gen(function* () {
    if (props.http?.enabled || props.http?.authentication || props.http?.cors)
      return yield* unsupported(
        "HTTP ingestion is not implemented; native Worker send is supported",
      );
    for (const field of props.schema?.fields ?? []) {
      if (
        field.metadataKey ||
        ![
          "int32",
          "int64",
          "float32",
          "float64",
          "bool",
          "string",
          "json",
        ].includes(field.type)
      )
        return yield* unsupported(
          `schema field ${field.name} uses unsupported ${field.metadataKey ? "metadata extraction" : field.type}`,
        );
    }
    if (props.format?.timestampFormat || props.format?.decimalEncoding)
      return yield* unsupported(
        "timestamp/decimal input conversion is not implemented",
      );
  });

const validateSink = (props: SinkProps) =>
  Effect.gen(function* () {
    if (props.type !== "r2")
      return yield* unsupported(
        "R2 Data Catalog/Iceberg sinks are not implemented",
      );
    if (!isLocalId(props.config.bucket))
      return yield* unsupported(
        "local sinks require a local R2 Bucket resource",
      );
    if (props.format?.type === "parquet")
      return yield* unsupported("Parquet output is not implemented");
    if (
      props.format?.timestampFormat ||
      props.format?.decimalEncoding ||
      props.schema?.fields?.length
    )
      return yield* unsupported(
        "sink schema/timestamp/decimal conversion is not implemented",
      );
    if (props.config.rollingPolicy)
      return yield* unsupported(
        "timed/size file rolling is not implemented; local send flushes one JSON file per batch",
      );
    if (
      props.config.fileNaming?.strategy &&
      props.config.fileNaming.strategy !== "uuid_v7"
    )
      return yield* unsupported("only UUIDv7 file naming is implemented");
    if (
      props.config.partitioning?.timePattern
        ?.replace(/%[YmdHMS%]/g, "")
        .includes("%")
    )
      return yield* unsupported(
        "partition patterns only support %Y %m %d %H %M %S and %%",
      );
  });

const restartPipelinesWorkers = Effect.gen(function* () {
  const state = yield* LocalRuntimeState;
  for (const [worker, streams] of state.pipelineWorkerStreams) {
    if (!streams.length) continue;
    const hook = MutableHashMap.get(state.workerRestarts, worker);
    if (Option.isSome(hook)) yield* hook.value;
  }
});

export const StreamProviderLocal = () =>
  RpcProvider.effect(
    Stream,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const state = yield* LocalRuntimeState;
      return {
        stables: ["streamId", "accountId", "name", "createdAt"],
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return;
          if (!output) return { action: "update" };
          if (!isLocalId(output.streamId)) return { action: "replace" };
          if (
            (news.name ?? output.name) !== output.name ||
            !deepEqual(news.schema, olds?.schema) ||
            !deepEqual(news.format, olds?.format)
          )
            return { action: "replace" };
          if (!deepEqual(news, olds)) return { action: "update" };
          MutableHashMap.set(state.pipelineStreams, output.streamId, {
            props: news,
            attributes: output,
          });
          return { action: "noop" };
        }),
        read: Effect.fn(function* ({ output }) {
          return output
            ? MutableHashMap.get(state.pipelineStreams, output.streamId).pipe(
                Option.map((s) => s.attributes),
                Option.getOrUndefined,
              )
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          yield* validateStream(news);
          const { accountId } = yield* yield* CloudflareEnvironment;
          const now = new Date().toISOString();
          const attributes: StreamAttributes = {
            streamId:
              output?.streamId && isLocalId(output.streamId)
                ? output.streamId
                : generateLocalId(),
            name: news.name ?? output?.name ?? (yield* localName(id)),
            accountId,
            endpoint: undefined,
            httpEnabled: false,
            httpAuthentication: false,
            corsOrigins: undefined,
            workerBindingEnabled: news.workerBinding?.enabled ?? true,
            version: (output?.version ?? 0) + 1,
            createdAt: output?.createdAt ?? now,
            modifiedAt: now,
          };
          MutableHashMap.set(state.pipelineStreams, attributes.streamId, {
            props: news,
            attributes,
          });
          yield* restartPipelinesWorkers;
          return attributes;
        }),
        delete: Effect.fn(function* ({ output }) {
          MutableHashMap.remove(state.pipelineStreams, output.streamId);
          yield* restartPipelinesWorkers;
        }),
      };
    }),
  );

export const SinkProviderLocal = () =>
  RpcProvider.effect(
    Sink,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const state = yield* LocalRuntimeState;
      return {
        stables: ["sinkId", "accountId", "name", "createdAt"],
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return;
          if (!output) return { action: "update" };
          if (!isLocalId(output.sinkId) || !deepEqual(news, olds))
            return { action: "replace" };
          MutableHashMap.set(state.pipelineSinks, output.sinkId, {
            props: news,
            attributes: output,
          });
          return { action: "noop" };
        }),
        read: Effect.fn(function* ({ output }) {
          return output
            ? MutableHashMap.get(state.pipelineSinks, output.sinkId).pipe(
                Option.map((s) => s.attributes),
                Option.getOrUndefined,
              )
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          yield* validateSink(news);
          const { accountId } = yield* yield* CloudflareEnvironment;
          const now = new Date().toISOString();
          const attributes: SinkAttributes = {
            sinkId:
              output?.sinkId && isLocalId(output.sinkId)
                ? output.sinkId
                : generateLocalId(),
            name: news.name ?? output?.name ?? (yield* localName(id)),
            accountId,
            type: news.type,
            format: news.format ?? { type: "json" },
            bucket: news.config.bucket,
            path: news.type === "r2" ? news.config.path : undefined,
            createdAt: output?.createdAt ?? now,
            modifiedAt: now,
          };
          MutableHashMap.set(state.pipelineSinks, attributes.sinkId, {
            props: news,
            attributes,
          });
          yield* restartPipelinesWorkers;
          return attributes;
        }),
        delete: Effect.fn(function* ({ output }) {
          MutableHashMap.remove(state.pipelineSinks, output.sinkId);
          yield* restartPipelinesWorkers;
        }),
      };
    }),
  );

export const PipelineProviderLocal = () =>
  RpcProvider.effect(
    Pipeline,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const state = yield* LocalRuntimeState;
      return {
        stables: ["pipelineId", "accountId", "name", "createdAt"],
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return;
          if (!output) return { action: "update" };
          if (!isLocalId(output.pipelineId) || !deepEqual(news, olds))
            return { action: "replace" };
          MutableHashMap.set(state.pipelines, output.pipelineId, {
            props: news,
            attributes: output,
          });
          return { action: "noop" };
        }),
        read: Effect.fn(function* ({ output }) {
          return output
            ? MutableHashMap.get(state.pipelines, output.pipelineId).pipe(
                Option.map((s) => s.attributes),
                Option.getOrUndefined,
              )
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const queries = yield* Effect.try({
            try: () => Pipelines.parsePipelineSql(news.sql),
            catch: (error) =>
              error instanceof Error ? error : new Error(String(error)),
          });
          for (const query of queries) {
            const stream = [
              ...MutableHashMap.values(state.pipelineStreams),
            ].find((s) => s.attributes.name === query.stream);
            const sink = [...MutableHashMap.values(state.pipelineSinks)].find(
              (s) => s.attributes.name === query.sink,
            );
            if (!stream || !sink)
              return yield* unsupported(
                `SQL references missing local stream ${query.stream} or sink ${query.sink}; interpolate their name outputs to declare dependencies`,
              );
            const columns = stream.props.schema?.fields?.map(
              (f) => f.sqlName ?? f.name,
            );
            if (columns?.length)
              for (const field of [
                ...(query.columns === "*"
                  ? []
                  : query.columns.map((c) => c.field)),
                ...(query.where ? [query.where.field] : []),
              ])
                if (!columns.includes(field))
                  return yield* unsupported(
                    `SQL references unknown stream field ${field}`,
                  );
          }
          const { accountId } = yield* yield* CloudflareEnvironment;
          const now = new Date().toISOString();
          const attributes: PipelineAttributes = {
            pipelineId:
              output?.pipelineId && isLocalId(output.pipelineId)
                ? output.pipelineId
                : generateLocalId(),
            name: news.name ?? output?.name ?? (yield* localName(id)),
            accountId,
            sql: news.sql,
            status: "active",
            createdAt: output?.createdAt ?? now,
            modifiedAt: now,
          };
          MutableHashMap.set(state.pipelines, attributes.pipelineId, {
            props: news,
            attributes,
          });
          yield* restartPipelinesWorkers;
          return attributes;
        }),
        delete: Effect.fn(function* ({ output }) {
          MutableHashMap.remove(state.pipelines, output.pipelineId);
          yield* restartPipelinesWorkers;
        }),
      };
    }),
  );
