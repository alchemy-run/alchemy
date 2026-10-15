import {
  asEffectOrStream,
  decodeRpcResponseStream,
  decodeRpcResult,
  encodeRpcResponseStream,
} from "alchemy/Rpc";
import { decodeResult, encodeResult } from "alchemy/WorkflowEncoding";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Workflow } from "effect/workflow";
import { packQueueSinkBatches } from "../../../packages/alchemy/src/Cloudflare/Queues/QueueSinkBatch";

export const harness = "cloudflare-cpu-v1";
export const maximumOperations = 20_000;
export const binaryChunkBytes = 16 * 1024;
export const maximumBinaryChunks = 2048;

const queueMessage = { text: "hé🙂".repeat(14_000) };

/** Production queue packing only; excludes queue transport and delivery. */
export const queuePacking = (count: number) =>
  Effect.sync(() => {
    const bodies = Array.from({ length: count }, () => queueMessage);
    const batches = packQueueSinkBatches(bodies);
    let checksum = 0;
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index]!;
      if (batch.length !== Math.min(2, count - index * 2)) {
        throw new Error("Queue packing changed batch boundaries");
      }
      for (const message of batch) {
        if (message !== queueMessage) throw new Error("Queue packing changed a message");
        checksum += message.text.length;
      }
    }
    return { checksum, batches: batches.length, messageBytes: 98_111 };
  });

// Deliberately named Effect.fn: the workload exercises per-operation span
// creation even when no tracing exporter is configured on the Worker.
const step = Effect.fn("cloudflareCpu.step")(function* (value: number) {
  return yield* Effect.succeed(value + 1);
});

export const effectOperations = (count: number) =>
  Effect.gen(function* () {
    let checksum = 0;
    for (let index = 0; index < count; index++) {
      checksum += yield* step(index);
    }
    return checksum;
  });

// Exercise the public wrapper used by RPC stubs on ordinary value methods.
// It deliberately does not make network calls: every request performs exactly
// `count` wrapper constructions, value executions, and result decodes.
export const rpcShape = (count: number) =>
  Effect.gen(function* () {
    let checksum = 0;
    for (let index = 0; index < count; index++) {
      const wrapped = asEffectOrStream(Effect.succeed(index + 1));
      const value = yield* wrapped;
      const decoded = yield* decodeRpcResult(value);
      if (typeof decoded !== "number") {
        return yield* Effect.die(new Error("RPC workload did not return a number"));
      }
      checksum += decoded;
    }
    return checksum;
  });

const WorkflowResult = Schema.Struct({
  id: Schema.String,
  items: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.Number })),
});

const codecWorkflow = Workflow.make("CpuCodecBenchmark", {
  payload: { id: Schema.String },
  success: WorkflowResult,
  idempotencyKey: ({ id }) => id,
});

const result = {
  id: "a",
  items: Array.from({ length: 10 }, (_, value) => ({ name: `item-${value}`, value })),
};
const resultExit = Exit.succeed(result);

// The same workflow instance is reused across all requests, as in an engine.
// Exercise the actual production result codec, including its schema derivation.
export const workflowCodec = (count: number) =>
  Effect.gen(function* () {
    let checksum = 0;
    for (let index = 0; index < count; index++) {
      const encoded = yield* encodeResult(codecWorkflow, resultExit);
      const decoded = yield* decodeResult(codecWorkflow, encoded);
      if (Exit.isFailure(decoded.exit)) {
        return yield* Effect.die(new Error("Workflow codec returned a failed exit"));
      }
      const value = decoded.exit.value as typeof result;
      if (
        value.id !== result.id ||
        value.items.length !== 10 ||
        value.items.reduce((sum, item) => sum + item.name.length, 0) !== 60
      ) {
        return yield* Effect.die(new Error("Workflow codec changed the result"));
      }
      checksum += value.items.reduce((sum, item) => sum + item.value, 0);
    }
    return checksum;
  });

const binaryChunk = Uint8Array.from({ length: binaryChunkBytes }, (_, index) => index % 256);

/** Production NDJSON/base64 codec: count chunks, bounded to 32 MiB decoded. */
export const rpcBinary = (count: number) =>
  (
    encodeRpcResponseStream(
      Stream.fromIterable({
        *[Symbol.iterator]() {
          for (let index = 0; index < count; index++) yield binaryChunk;
        },
      }),
    ) as unknown as Stream.Stream<Uint8Array>
  ).pipe(
    // This fixture is context-free; the encoder's public signature erases R.
    decodeRpcResponseStream,
    Stream.runFold(
      () => ({ chunks: 0, bytes: 0, checksum: 0 }),
      (result, chunk: unknown) => {
        if (!(chunk instanceof Uint8Array) || chunk.length !== binaryChunkBytes) {
          throw new Error("RPC binary codec changed the chunk type or length");
        }
        for (let index = 0; index < chunk.length; index++) {
          if (chunk[index] !== index % 256) {
            throw new Error("RPC binary codec changed the chunk contents");
          }
          result.checksum += chunk[index]!;
        }
        result.chunks++;
        result.bytes += chunk.length;
        return result;
      },
    ),
  );

/** Production JSON record codec, including line splitting and record decoding. */
export const rpcRecords = (count: number) =>
  (
    encodeRpcResponseStream(
      Stream.fromIterable({
        *[Symbol.iterator]() {
          for (let index = 0; index < count; index++) {
            yield {
              index,
              name: `record-${index}`,
              detail: { active: index % 2 === 0, values: [index, index + 1, index + 2] },
            };
          }
        },
      }),
    ) as unknown as Stream.Stream<Uint8Array>
  ).pipe(
    // This fixture is context-free; the encoder's public signature erases R.
    decodeRpcResponseStream,
    Stream.runFold(
      () => ({ records: 0, checksum: 0 }),
      (result, record: unknown) => {
        const index = result.records;
        if (typeof record !== "object" || record === null) {
          throw new Error("RPC record codec changed the record type");
        }
        const value = record as {
          index: number;
          name: string;
          detail: { active: boolean; values: number[] };
        };
        if (
          value.index !== index ||
          value.name !== `record-${index}` ||
          value.detail?.active !== (index % 2 === 0) ||
          value.detail.values.length !== 3 ||
          value.detail.values.some((item, offset) => item !== index + offset)
        ) {
          throw new Error("RPC record codec changed the record contents or order");
        }
        result.records++;
        result.checksum += value.index + value.detail.values.reduce((sum, item) => sum + item, 0);
        return result;
      },
    ),
  );
