import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { nodeFileTrace } from "@vercel/nft";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { TraceInput } from "./Trace.ts";

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const inputPath = process.argv[2];
    const outputPath = process.argv[3];
    if (!inputPath || !outputPath)
      return yield* Effect.fail(new Error("Missing dependency trace paths"));
    const source = yield* fs.readFileString(inputPath);
    const input = yield* Effect.try(() => JSON.parse(source) as TraceInput);
    const result = yield* Effect.tryPromise(() =>
      nodeFileTrace(input.seeds, {
        base: input.base,
        processCwd: input.root,
        conditions: ["node", "production"],
        // Next's manifests already trace its runtime without dev bundlers.
        ignore: input.next
          ? (file) => file.replaceAll("\\", "/").includes("/node_modules/next/")
          : undefined,
        analysis: {
          emitGlobs: true,
          computeFileReferences: true,
          evaluatePureExpressions: true,
        },
      }),
    );
    yield* fs.writeFileString(outputPath, JSON.stringify([...result.fileList]));
  }).pipe(Effect.provide(NodeServices.layer)),
);
