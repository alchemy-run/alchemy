#!/usr/bin/env bun
/**
 * Benchmark the actual Lambda-style runtime bundle produced for the AWS example.
 *
 * This script intentionally mirrors the settings used by `AWS.Lambda.Function`
 * with the `rolldown` bundler, then compares import variants to understand
 * barrel tree-shaking behavior.
 *
 * Usage: bun scripts/bundle-benchmark.ts
 */

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { rolldown } from "rolldown";

const ROOT = resolve(import.meta.dirname!, "..");
const EXAMPLE_DIR = resolve(ROOT, "examples/aws");
const SRC_DIR = resolve(EXAMPLE_DIR, "src");
const JOB_FUNCTION = resolve(SRC_DIR, "JobFunction.ts");
const JOB_STORAGE = resolve(SRC_DIR, "JobStorage.ts");
const OUT_DIR = resolve(EXAMPLE_DIR, ".bundle-benchmark");

const S3_OPS = [
  "AbortMultipartUpload",
  "CompleteMultipartUpload",
  "CopyObject",
  "CreateMultipartUpload",
  "DeleteObject",
  "GetObject",
  "HeadObject",
  "ListObjectsV2",
  "PutObject",
  "UploadPart",
] as const;

type S3Op = (typeof S3_OPS)[number];

interface Variant {
  name: string;
  description: string;
  createMain(): { path: string; cleanup(): void };
}

interface ModuleEntry {
  path: string;
  size: number;
}

interface Result {
  variant: string;
  description: string;
  rawSize: number;
  gzipSize: number;
  mapSize: number;
  modules: ModuleEntry[];
  s3Ops: Record<S3Op, boolean>;
}

interface MicroResult {
  name: string;
  rawSize: number;
  gzipSize: number;
  s3Ops: Record<S3Op, boolean>;
}

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

const measureFile = (filePath: string) => {
  const content = readFileSync(filePath);
  return {
    rawSize: content.length,
    gzipSize: gzipSync(content).length,
  };
};

const relativeFromRoot = (path: string) =>
  relative(ROOT, path).replaceAll("\\", "/");

const shortModulePath = (path: string) =>
  relativeFromRoot(path)
    .replace(/^node_modules\//, "")
    .replace(/^examples\/aws\//, "examples/aws/")
    .replace(/^alchemy-effect\//, "alchemy-effect/")
    .replace(/\/dist\/esm\//, "/")
    .replace(/\/dist\/cjs\//, "/")
    .replace(/\.(ts|tsx|js|mjs)$/, "");

const createVariantFile = (
  name: string,
  replacements: Array<[string, string]>,
): { path: string; cleanup(): void } => {
  const original = readFileSync(JOB_FUNCTION, "utf8");
  let contents = original;
  for (const [search, replace] of replacements) {
    contents = contents.replace(search, replace);
  }
  const path = resolve(SRC_DIR, `__bundle-benchmark.${name}.ts`);
  writeFileSync(path, contents);
  return {
    path,
    cleanup() {
      rmSync(path, { force: true });
    },
  };
};

const createDirectFilesVariant = (): { path: string; cleanup(): void } => {
  const storageOriginal = readFileSync(JOB_STORAGE, "utf8");
  const storagePath = resolve(
    SRC_DIR,
    "__bundle-benchmark.direct-files.JobStorage.ts",
  );
  const storageContents = storageOriginal
    .replace(
      'import * as S3 from "alchemy-effect/AWS/S3";',
      'import { Bucket } from "../../../alchemy-effect/src/AWS/S3/Bucket.ts";\nimport { GetObject } from "../../../alchemy-effect/src/AWS/S3/GetObject.ts";\nimport { PutObject } from "../../../alchemy-effect/src/AWS/S3/PutObject.ts";',
    )
    .replace("bucket: S3.Bucket;", "bucket: Bucket;")
    .replace('yield* S3.Bucket("JobsBucket")', 'yield* Bucket("JobsBucket")')
    .replace(
      "yield* S3.GetObject.bind(bucket)",
      "yield* GetObject.bind(bucket)",
    )
    .replace(
      "yield* S3.PutObject.bind(bucket)",
      "yield* PutObject.bind(bucket)",
    );
  writeFileSync(storagePath, storageContents);

  const mainOriginal = readFileSync(JOB_FUNCTION, "utf8");
  const mainPath = resolve(
    SRC_DIR,
    "__bundle-benchmark.direct-files.JobFunction.ts",
  );
  const mainContents = mainOriginal
    .replace(
      'import { AWS, RemovalPolicy } from "alchemy-effect";',
      'import { BucketEventSource } from "../../../alchemy-effect/src/AWS/Lambda/BucketEventSource.ts";\nimport { Function, type FunctionProps } from "../../../alchemy-effect/src/AWS/Lambda/Function.ts";\nimport { HttpServer } from "../../../alchemy-effect/src/AWS/Lambda/HttpServer.ts";\nimport { notifications } from "../../../alchemy-effect/src/AWS/S3/BucketNotifications.ts";\nimport { GetObjectLive } from "../../../alchemy-effect/src/AWS/S3/GetObject.ts";\nimport { PutObjectLive } from "../../../alchemy-effect/src/AWS/S3/PutObject.ts";\nimport { Queue } from "../../../alchemy-effect/src/AWS/SQS/Queue.ts";\nimport { QueueSink, QueueSinkLive } from "../../../alchemy-effect/src/AWS/SQS/QueueSink.ts";\nimport { SendMessageBatchLive } from "../../../alchemy-effect/src/AWS/SQS/SendMessageBatch.ts";\nimport * as RemovalPolicy from "alchemy-effect/RemovalPolicy";',
    )
    .replace(
      'import { JobStorage, JobStorageLive } from "./JobStorage.ts";',
      'import { JobStorage, JobStorageLive } from "./__bundle-benchmark.direct-files.JobStorage.ts";',
    )
    .replace('AWS.SQS.Queue("JobsQueue")', 'Queue("JobsQueue")')
    .replace("AWS.SQS.QueueSink.bind(queue)", "QueueSink.bind(queue)")
    .replace("AWS.S3.notifications(bucket)", "notifications(bucket)")
    .replace(
      "as const satisfies AWS.Lambda.FunctionProps;",
      "as const satisfies FunctionProps;",
    )
    .replace("AWS.Lambda.BucketEventSource", "BucketEventSource")
    .replace("AWS.Lambda.HttpServer", "HttpServer")
    .replace("AWS.SQS.QueueSinkLive", "QueueSinkLive")
    .replace("AWS.S3.GetObjectLive", "GetObjectLive")
    .replace("AWS.S3.PutObjectLive", "PutObjectLive")
    .replace("AWS.SQS.SendMessageBatchLive", "SendMessageBatchLive")
    .replace('AWS.Lambda.Function("JobFunction")', 'Function("JobFunction")');
  writeFileSync(mainPath, mainContents);

  return {
    path: mainPath,
    cleanup() {
      rmSync(mainPath, { force: true });
      rmSync(storagePath, { force: true });
    },
  };
};

const variants: Variant[] = [
  {
    name: "root-barrel",
    description: `import { AWS, RemovalPolicy } from "alchemy-effect"`,
    createMain: () => ({
      path: JOB_FUNCTION,
      cleanup() {},
    }),
  },
  {
    name: "aws-subpath",
    description:
      'import * as AWS from "alchemy-effect/AWS" + import * as RemovalPolicy from "alchemy-effect/RemovalPolicy"',
    createMain: () =>
      createVariantFile("aws-subpath", [
        [
          'import { AWS, RemovalPolicy } from "alchemy-effect";',
          'import * as AWS from "alchemy-effect/AWS";\nimport * as RemovalPolicy from "alchemy-effect/RemovalPolicy";',
        ],
      ]),
  },
  {
    name: "service-subpaths",
    description:
      'import * as S3 from "alchemy-effect/AWS/S3" + sibling AWS service subpaths',
    createMain: () =>
      createVariantFile("service-subpaths", [
        [
          'import { AWS, RemovalPolicy } from "alchemy-effect";',
          'import * as AWSLambda from "alchemy-effect/AWS/Lambda";\nimport * as S3 from "alchemy-effect/AWS/S3";\nimport * as SQS from "alchemy-effect/AWS/SQS";\nimport * as RemovalPolicy from "alchemy-effect/RemovalPolicy";',
        ],
        ['AWS.SQS.Queue("JobsQueue")', 'SQS.Queue("JobsQueue")'],
        ["AWS.SQS.QueueSink.bind(queue)", "SQS.QueueSink.bind(queue)"],
        ["AWS.S3.notifications(bucket)", "S3.notifications(bucket)"],
        [
          "as const satisfies AWS.Lambda.FunctionProps;",
          "as const satisfies AWSLambda.FunctionProps;",
        ],
        ["AWS.Lambda.BucketEventSource", "AWSLambda.BucketEventSource"],
        ["AWS.Lambda.HttpServer", "AWSLambda.HttpServer"],
        ["AWS.SQS.QueueSinkLive", "SQS.QueueSinkLive"],
        ["AWS.S3.GetObjectLive", "S3.GetObjectLive"],
        ["AWS.S3.PutObjectLive", "S3.PutObjectLive"],
        ["AWS.SQS.SendMessageBatchLive", "SQS.SendMessageBatchLive"],
        [
          'AWS.Lambda.Function("JobFunction")',
          'AWSLambda.Function("JobFunction")',
        ],
      ]),
  },
  {
    name: "direct-files",
    description: "direct file imports lower bound",
    createMain: () => createDirectFilesVariant(),
  },
];

async function buildVariant(variant: Variant): Promise<Result> {
  const dir = join(OUT_DIR, variant.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const main = variant.createMain();
  try {
    const entry = join(dir, "__entry.ts");
    const importPath = relative(dirname(entry), main.path).replaceAll(
      "\\",
      "/",
    );
    writeFileSync(
      entry,
      `import { default as handler } from ${JSON.stringify(importPath.startsWith(".") ? importPath : `./${importPath}`)};
import * as Effect from "effect/Effect";
export default await Effect.runPromise(handler);
`,
    );

    const outfile = join(dir, "output.js");
    const bundle = await rolldown({
      input: entry,
      platform: "node",
      external: ["@aws-sdk/*", "@smithy/*", "cloudflare:workers"],
      treeshake: {
        moduleSideEffects: false,
        unknownGlobalSideEffects: false,
        propertyReadSideEffects: false,
        propertyWriteSideEffects: false,
      },
      optimization: {
        inlineConst: { mode: "all", pass: 3 },
      },
      experimental: {
        lazyBarrel: true,
      },
      resolve: {
        extensions: [".ts", ".js", ".mjs"],
        conditionNames: ["bun", "import", "default"],
        mainFields: ["module", "main"],
      },
    });

    const { output } = await bundle.write({
      file: outfile,
      format: "esm",
      sourcemap: true,
      externalLiveBindings: false,
      minify: {
        compress: {
          target: "es2022",
          maxIterations: 10,
          treeshake: {
            propertyReadSideEffects: false,
            unknownGlobalSideEffects: false,
          },
        },
        mangle: { toplevel: true },
      },
    });
    await bundle.close();

    const { rawSize, gzipSize } = measureFile(outfile);
    const mapSize = statSync(`${outfile}.map`).size;
    const code = readFileSync(outfile, "utf8");

    const modules: ModuleEntry[] = [];
    for (const chunk of output) {
      if (chunk.type === "chunk" && chunk.modules) {
        for (const [path, info] of Object.entries(chunk.modules)) {
          modules.push({ path, size: info.renderedLength });
        }
      }
    }

    const s3Ops = Object.fromEntries(
      S3_OPS.map((op) => [op, new RegExp(`\\b${op}Request\\b`).test(code)]),
    ) as Record<S3Op, boolean>;

    return {
      variant: variant.name,
      description: variant.description,
      rawSize,
      gzipSize,
      mapSize,
      modules,
      s3Ops,
    };
  } finally {
    main.cleanup();
  }
}

async function buildMicroEntry(
  name: string,
  source: string,
): Promise<MicroResult> {
  const dir = join(OUT_DIR, `micro-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "__entry.ts");
  const outfile = join(dir, "output.js");
  writeFileSync(entry, source);

  const bundle = await rolldown({
    input: entry,
    platform: "node",
    external: ["@aws-sdk/*", "@smithy/*", "cloudflare:workers"],
    treeshake: {
      moduleSideEffects: false,
      unknownGlobalSideEffects: false,
      propertyReadSideEffects: false,
      propertyWriteSideEffects: false,
    },
    optimization: {
      inlineConst: { mode: "all", pass: 3 },
    },
    experimental: {
      lazyBarrel: true,
    },
    resolve: {
      extensions: [".ts", ".js", ".mjs"],
      conditionNames: ["bun", "import", "default"],
      mainFields: ["module", "main"],
    },
  });

  try {
    await bundle.write({
      file: outfile,
      format: "esm",
      sourcemap: true,
      externalLiveBindings: false,
      minify: {
        compress: {
          target: "es2022",
          maxIterations: 10,
          treeshake: {
            propertyReadSideEffects: false,
            unknownGlobalSideEffects: false,
          },
        },
        mangle: { toplevel: true },
      },
    });
  } finally {
    await bundle.close();
  }

  const { rawSize, gzipSize } = measureFile(outfile);
  const code = readFileSync(outfile, "utf8");
  const s3Ops = Object.fromEntries(
    S3_OPS.map((op) => [op, new RegExp(`\\b${op}Request\\b`).test(code)]),
  ) as Record<S3Op, boolean>;

  return { name, rawSize, gzipSize, s3Ops };
}

const topModules = (modules: ModuleEntry[], count = 15) =>
  [...modules].sort((a, b) => b.size - a.size).slice(0, count);

const uniqueAlchemyModules = (current: Result, baseline: Result) => {
  const baselinePaths = new Set(
    baseline.modules
      .filter((m) => m.size > 0)
      .map((m) => shortModulePath(m.path)),
  );
  return current.modules
    .filter((m) => m.size > 0)
    .filter((m) => m.path.includes("/alchemy-effect/"))
    .filter((m) => !baselinePaths.has(shortModulePath(m.path)))
    .sort((a, b) => b.size - a.size);
};

function printSizeTable(results: Result[]) {
  console.log("\n" + "═".repeat(88));
  console.log("  RESULTS");
  console.log("═".repeat(88) + "\n");
  console.log(
    "  " +
      "Variant".padEnd(16) +
      "Raw".padStart(12) +
      "Gzip".padStart(12) +
      "Map".padStart(12) +
      "Delta".padStart(12),
  );
  console.log("  " + "─".repeat(64));
  const baseline = results[0]!;
  for (const result of results) {
    const delta =
      result === baseline
        ? "baseline"
        : `${(((result.rawSize - baseline.rawSize) / baseline.rawSize) * 100).toFixed(1)}%`;
    console.log(
      "  " +
        result.variant.padEnd(16) +
        formatBytes(result.rawSize).padStart(12) +
        formatBytes(result.gzipSize).padStart(12) +
        formatBytes(result.mapSize).padStart(12) +
        delta.padStart(12),
    );
  }
}

function printS3Table(results: Result[]) {
  console.log("\n" + "═".repeat(88));
  console.log("  S3 OPERATIONS PRESENT IN RUNTIME BUNDLE");
  console.log("═".repeat(88) + "\n");
  const header =
    "  " +
    "Operation".padEnd(28) +
    results.map((r) => r.variant.padStart(16)).join("");
  console.log(header);
  console.log("  " + "─".repeat(28 + 16 * results.length));
  for (const op of S3_OPS) {
    const row =
      "  " +
      op.padEnd(28) +
      results.map((r) => (r.s3Ops[op] ? "present" : "-").padStart(16)).join("");
    console.log(row);
  }
}

function printTopModules(results: Result[]) {
  for (const result of results) {
    console.log("\n" + "═".repeat(88));
    console.log(`  TOP MODULES — ${result.variant}`);
    console.log("═".repeat(88) + "\n");
    console.log(`  ${result.description}\n`);
    const pathWidth = 64;
    console.log("  " + "Module".padEnd(pathWidth) + "Size".padStart(12));
    console.log("  " + "─".repeat(pathWidth + 12));
    for (const mod of topModules(result.modules)) {
      const short = shortModulePath(mod.path);
      const display =
        short.length > pathWidth - 2
          ? "…" + short.slice(-(pathWidth - 3))
          : short;
      console.log(
        "  " + display.padEnd(pathWidth) + formatBytes(mod.size).padStart(12),
      );
    }
  }
}

function printUniqueAlchemyComparison(results: Result[]) {
  if (results.length < 2) return;
  const baseline = results[results.length - 1]!;
  const current = results[0]!;
  const unique = uniqueAlchemyModules(current, baseline).slice(0, 20);
  console.log("\n" + "═".repeat(88));
  console.log(
    `  ALCHEMY MODULES UNIQUE TO ${current.variant.toUpperCase()} VS ${baseline.variant.toUpperCase()}`,
  );
  console.log("═".repeat(88) + "\n");
  if (unique.length === 0) {
    console.log("  None.\n");
    return;
  }
  const pathWidth = 64;
  console.log("  " + "Module".padEnd(pathWidth) + "Size".padStart(12));
  console.log("  " + "─".repeat(pathWidth + 12));
  for (const mod of unique) {
    const short = shortModulePath(mod.path);
    const display =
      short.length > pathWidth - 2
        ? "…" + short.slice(-(pathWidth - 3))
        : short;
    console.log(
      "  " + display.padEnd(pathWidth) + formatBytes(mod.size).padStart(12),
    );
  }
}

function printMicroResults(results: MicroResult[]) {
  console.log("\n" + "═".repeat(88));
  console.log("  MICRO ENTRIES");
  console.log("═".repeat(88) + "\n");
  console.log(
    "  " + "Entry".padEnd(20) + "Raw".padStart(12) + "Gzip".padStart(12),
  );
  console.log("  " + "─".repeat(44));
  for (const result of results) {
    console.log(
      "  " +
        result.name.padEnd(20) +
        formatBytes(result.rawSize).padStart(12) +
        formatBytes(result.gzipSize).padStart(12),
    );
  }

  console.log("\n" + "═".repeat(88));
  console.log("  MICRO S3 OPERATIONS");
  console.log("═".repeat(88) + "\n");
  const header =
    "  " +
    "Operation".padEnd(28) +
    results.map((r) => r.name.padStart(20)).join("");
  console.log(header);
  console.log("  " + "─".repeat(28 + 20 * results.length));
  for (const op of S3_OPS) {
    const row =
      "  " +
      op.padEnd(28) +
      results.map((r) => (r.s3Ops[op] ? "present" : "-").padStart(20)).join("");
    console.log(row);
  }
}

async function main() {
  console.log("Lambda Bundle Benchmark — actual rolldown deploy settings\n");
  console.log(`  Example: ${EXAMPLE_DIR}`);
  console.log(`  Output:  ${OUT_DIR}\n`);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const results: Result[] = [];
  for (const variant of variants) {
    process.stdout.write(`  ${variant.name.padEnd(16)} ... `);
    const result = await buildVariant(variant);
    results.push(result);
    console.log(
      `${formatBytes(result.rawSize).padStart(10)} raw  ${formatBytes(result.gzipSize).padStart(10)} gzip  ${formatBytes(result.mapSize).padStart(10)} map`,
    );
  }

  printSizeTable(results);
  printS3Table(results);
  printTopModules(results);
  printUniqueAlchemyComparison(results);
  const microResults = await Promise.all([
    buildMicroEntry(
      "bucket-provider",
      'import { BucketProvider } from "../../../../alchemy-effect/src/AWS/S3/Bucket.ts";\nconsole.log(BucketProvider);\n',
    ),
    buildMicroEntry(
      "get-object-live",
      'import { GetObjectLive } from "../../../../alchemy-effect/src/AWS/S3/GetObject.ts";\nconsole.log(GetObjectLive);\n',
    ),
    buildMicroEntry(
      "put-object-live",
      'import { PutObjectLive } from "../../../../alchemy-effect/src/AWS/S3/PutObject.ts";\nconsole.log(PutObjectLive);\n',
    ),
    buildMicroEntry(
      "distilled-get-object",
      'import { getObject } from "distilled-aws/s3";\nconsole.log(getObject);\n',
    ),
    buildMicroEntry(
      "distilled-put-object",
      'import { putObject } from "distilled-aws/s3";\nconsole.log(putObject);\n',
    ),
  ]);
  printMicroResults(microResults);
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
