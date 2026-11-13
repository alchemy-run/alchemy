import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import * as udf from "@distilled.cloud/clickhouse-cloud/udf";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { zipFiles } from "alchemy/Util/zip";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { OperationFailed } from "../Errors.ts";
import { isGeneratedName, physicalName } from "../internal/Names.ts";
import { pollUntil } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

/** One argument of the function. */
export interface UdfArgument {
  /** Argument name; required for the `Native` and `JSONEachRow` formats. */
  name: string;
  /** ClickHouse type, e.g. `UInt64`, `String`. */
  type: string;
}

export interface FunctionProps {
  /**
   * SQL name of the function, unique in the organization. If omitted, a
   * unique name is generated from the stack, stage and logical ID (with
   * `_` for `-`). Changing it replaces the function.
   */
  functionName?: string;
  /**
   * Directory with the function's code. For `python3.11`, `main.py` at its
   * root (plus a `requirements.txt` if needed); for `native`, Linux
   * binaries at `amd64/main` and `arm64/main`. Hidden files and
   * `__pycache__` are left out. A change of any file publishes a new
   * version.
   */
  source: string;
  /** How the code runs. */
  runtime: "python3.11" | "native";
  /**
   * `executable` starts a process per block of rows; `executable_pool`
   * keeps `poolSize` processes running.
   * @default "executable"
   */
  type?: "executable" | "executable_pool";
  /** The function's arguments, in order. */
  arguments: UdfArgument[];
  /** ClickHouse type of the result. */
  returnType: string;
  /** Name of the result column, for formats that name columns. */
  returnName?: string;
  /** How rows travel over stdin/stdout, e.g. `TabSeparated` (default), `JSONEachRow`. */
  format?: string;
  /** `basic` (no network) or `netenable` (outbound network allowed). */
  sandboxType?: "basic" | "netenable";
  /** Milliseconds to wait for the process's output. */
  commandReadTimeout?: number;
  /** Milliseconds to wait while writing the process's input. */
  commandWriteTimeout?: number;
  /** Memory limit of each process, in MiB. */
  memoryLimitMib?: number;
  /** Whether ClickHouse sends a row count before each block. */
  sendChunkHeader?: boolean;
  /** Whether the same arguments always give the same result (results may be cached). */
  deterministic?: boolean;
  /** Processes kept running (`executable_pool` only). */
  poolSize?: number;
  /** Maximum seconds one command may run (`executable_pool` only). */
  maxCommandExecutionTime?: number;
}

export interface FunctionAttributes {
  /** Organization ID. */
  organizationId: string;
  /** SQL name of the function. */
  functionName: string;
  /** Latest version. */
  version: number;
  /** Build state of the latest version: `ready` once deploy returns. */
  status: string;
  /** Sandbox runtime version. */
  sandboxVersion: string;
  /** SHA-256 of the source archive of the latest version. */
  sourceHash: string;
  /** When the function was created. */
  createdAt: string;
  /** When the latest version was created. */
  updatedAt: string;
}

export type Function = Resource<
  "ClickHouseCloud.Udf.Function",
  FunctionProps,
  FunctionAttributes,
  never,
  Providers
>;

/**
 * An executable user-defined function: your Python or native code, called
 * from SQL like a built-in function, running sandboxed next to each
 * replica of the services it is attached to (see
 * `ClickHouseCloud.Udf.Attachment`).
 *
 * Deploy zips `source`, uploads it, and waits until ClickHouse has built
 * the version (`ready`); a build that fails fails the deploy with the
 * build error. Any change of the code or the configuration publishes a new
 * version under the same name: versions don't inherit settings, so the
 * props are the whole configuration. Destroying the function deletes every
 * version and detaches it from every service. Functions have no tags, so a
 * generated name is the ownership marker.
 * @see https://clickhouse.com/docs/cloud/features/user-defined-functions
 *
 * ### Writing a Function
 * **Example:** A Python function; `./udfs/is_business_hours/main.py` reads
 * a value per line from stdin and writes `0` or `1` per line to stdout
 * ```typescript
 * const isBusinessHours = yield* ClickHouseCloud.Udf.Function("IsBusinessHours", {
 *   functionName: "isBusinessHours",
 *   source: "./udfs/is_business_hours",
 *   runtime: "python3.11",
 *   arguments: [{ name: "ts", type: "DateTime" }],
 *   returnType: "UInt8",
 * });
 * ```
 *
 * **Example:** A pool of long-running processes
 * ```typescript
 * yield* ClickHouseCloud.Udf.Function("Embed", {
 *   source: "./udfs/embed",
 *   runtime: "python3.11",
 *   type: "executable_pool",
 *   poolSize: 4,
 *   arguments: [{ name: "text", type: "String" }],
 *   returnType: "Array(Float32)",
 *   format: "JSONEachRow",
 *   sandboxType: "netenable",
 *   memoryLimitMib: 1024,
 * });
 * ```
 *
 * :::caution
 * Changing `functionName` replaces the function: SQL calling the old name
 * fails once it is deleted.
 * :::
 *
 * @resource
 * @product UDF
 */
export const Function = Resource<Function>("ClickHouseCloud.Udf.Function");

/** A generated function name: SQL identifiers can't hold `-`. */
const functionNameOf = (id: string, name: string | undefined, existing?: string) =>
  name !== undefined || existing !== undefined
    ? Effect.succeed((name ?? existing)!)
    : Effect.map(physicalName(id), (generated) => generated.replaceAll("-", "_"));

const isGeneratedFunctionName = (name: string) => isGeneratedName(name.replaceAll("_", "-"));

/** Zip `dir` the way ClickHouse expects: paths relative to it, no hidden files or caches. */
const zipSource = Effect.fn(function* (dir: string) {
  const entries = yield* Effect.promise(() =>
    readdir(dir, { recursive: true, withFileTypes: true }),
  );
  const files: Array<{ path: string; content: Uint8Array }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    const path = relative(dir, full).split(sep).join("/");
    if (path.split("/").some((part) => part.startsWith(".") || part === "__pycache__")) continue;
    files.push({ path, content: yield* Effect.promise(() => readFile(full)) });
  }
  const archive = yield* zipFiles(files);
  return { archive, hash: createHash("sha256").update(archive).digest("hex") };
});

/** The version request: every setting, so nothing is inherited from the last version. */
const versionBody = (props: FunctionProps, uploadId: string): udf.UdfVersionCreateRequest => ({
  uploadId,
  type: props.type ?? "executable",
  runtime: props.runtime,
  arguments: props.arguments,
  returnType: props.returnType,
  returnName: props.returnName,
  format: props.format,
  sandboxType: props.sandboxType,
  commandReadTimeout: props.commandReadTimeout,
  commandWriteTimeout: props.commandWriteTimeout,
  memoryLimitMib: props.memoryLimitMib,
  sendChunkHeader: props.sendChunkHeader,
  deterministic: props.deterministic,
  ...((props.type ?? "executable") === "executable_pool"
    ? { poolSize: props.poolSize, maxCommandExecutionTime: props.maxCommandExecutionTime }
    : {}),
});

/** Whether the observed version runs with the declared configuration. */
const sameConfig = (observed: udf.Udf, props: FunctionProps) =>
  observed.type === (props.type ?? "executable") &&
  observed.runtime === props.runtime &&
  deepEqual(observed.arguments, props.arguments) &&
  observed.returnType === props.returnType &&
  (props.returnName === undefined || observed.returnName === props.returnName) &&
  (props.format === undefined || observed.format === props.format) &&
  (props.sandboxType === undefined || observed.sandboxType === props.sandboxType) &&
  (props.commandReadTimeout === undefined ||
    observed.commandReadTimeout === props.commandReadTimeout) &&
  (props.commandWriteTimeout === undefined ||
    observed.commandWriteTimeout === props.commandWriteTimeout) &&
  (props.memoryLimitMib === undefined || observed.memoryLimitMib === props.memoryLimitMib) &&
  (props.sendChunkHeader === undefined || observed.sendChunkHeader === props.sendChunkHeader) &&
  (props.deterministic === undefined || observed.deterministic === props.deterministic) &&
  (props.poolSize === undefined || observed.poolSize === props.poolSize) &&
  (props.maxCommandExecutionTime === undefined ||
    observed.maxCommandExecutionTime === props.maxCommandExecutionTime);

const toAttributes = (
  organizationId: string,
  fn: udf.Udf,
  sourceHash: string,
): FunctionAttributes => ({
  organizationId,
  functionName: fn.functionName,
  version: fn.version,
  status: fn.status,
  sandboxVersion: fn.sandboxVersion,
  sourceHash,
  createdAt: fn.createdAt,
  updatedAt: fn.updatedAt,
});

const getFunction = (organizationId: string, functionName: string) =>
  udf
    .getUdf({ organizationId, functionName })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** Upload an archive and return its upload ID; one upload per create or version attempt. */
const upload = Effect.fn(function* (organizationId: string, archive: Uint8Array) {
  const session = yield* udf.createUdfUploadUrl({ organizationId });
  const uploadUrl =
    typeof session.uploadUrl === "string"
      ? session.uploadUrl
      : Redacted.value(session.uploadUrl as Redacted.Redacted<string>);
  // A presigned URL the API handed back, used as is.
  const response = yield* HttpClient.execute(
    HttpClientRequest.put(uploadUrl).pipe(
      HttpClientRequest.bodyUint8Array(archive, "application/zip"),
    ),
  ).pipe(Effect.provide(FetchHttpClient.layer));
  if (response.status >= 300) {
    return yield* new OperationFailed({
      kind: "UDF source upload",
      id: session.uploadId,
      state: String(response.status),
      detail: yield* response.text,
    });
  }
  return session.uploadId;
});

const waitBuilt = (
  organizationId: string,
  functionName: string,
  session: { note: (m: string) => Effect.Effect<void> },
) =>
  pollUntil({
    kind: "UDF",
    id: functionName,
    waitingFor: "ready",
    read: getFunction(organizationId, functionName),
    state: (fn) => fn?.status,
    done: (fn): fn is udf.Udf => fn?.status === "ready",
    failed: (fn) =>
      fn === undefined
        ? "deleted while building"
        : fn.status === "error"
          ? (fn.error ?? "build failed")
          : undefined,
    session,
    budget: Duration.minutes(20),
    interval: Duration.seconds(10),
  });

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.succeed({
      stables: ["organizationId", "functionName", "createdAt"],
      // Attachments go first so their waits stay meaningful.
      nuke: { dependsOn: ["ClickHouseCloud.Udf.Attachment"] },
      list: Effect.fn(function* () {
        const organizationId = yield* currentOrganizationId;
        const all = yield* udf.listUdfs.items({ organizationId }).pipe(Stream.runCollect);
        return Array.from(all)
          .filter((fn) => isGeneratedFunctionName(fn.functionName))
          .map((fn) => toAttributes(organizationId, fn, ""));
      }),
      diff: Effect.fn(function* ({ id, news, olds, output }) {
        if (!isResolved(news) || olds === undefined || output === undefined) return undefined;
        const name = yield* functionNameOf(id, news.functionName, output.functionName);
        if (name !== output.functionName) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const name = yield* functionNameOf(id, olds?.functionName, output?.functionName);
        const observed = yield* getFunction(organizationId, name);
        if (observed === undefined) return undefined;
        const attrs = toAttributes(organizationId, observed, output?.sourceHash ?? "");
        if (output !== undefined) return attrs;
        const generated = yield* functionNameOf(id, undefined);
        return name === generated ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const functionName = yield* functionNameOf(id, news.functionName, output?.functionName);
        const { archive, hash } = yield* zipSource(news.source);

        // Observe
        let observed = yield* getFunction(organizationId, functionName);
        if (observed?.status === "building") {
          observed = yield* waitBuilt(organizationId, functionName, session);
        }

        // Ensure
        if (observed === undefined) {
          yield* session.note(`Uploading UDF ${functionName}...`);
          const uploadId = yield* upload(organizationId, archive);
          yield* udf.createUdf({
            organizationId,
            body: { ...versionBody(news, uploadId), functionName },
          });
          const built = yield* waitBuilt(organizationId, functionName, session);
          return toAttributes(organizationId, built, hash);
        }

        // Sync: a new version when the code or the configuration changed.
        // A version that failed to build is never current.
        if (
          observed.status === "ready" &&
          hash === output?.sourceHash &&
          sameConfig(observed, news)
        ) {
          return toAttributes(organizationId, observed, hash);
        }
        yield* session.note(`Publishing a new version of UDF ${functionName}...`);
        const uploadId = yield* upload(organizationId, archive);
        yield* udf.createUdfVersion({
          organizationId,
          functionName,
          body: versionBody(news, uploadId),
        });
        const built = yield* waitBuilt(organizationId, functionName, session);
        return toAttributes(organizationId, built, hash);
      }),
      delete: Effect.fn(function* ({ output, session }) {
        const { organizationId, functionName } = output;
        if ((yield* getFunction(organizationId, functionName)) === undefined) return;
        // Versions still building can't be deleted.
        yield* waitBuilt(organizationId, functionName, session).pipe(
          Effect.catchTag("ClickHouseCloud.OperationFailed", () => Effect.void),
        );
        yield* udf
          .deleteUdf({ organizationId, functionName })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* pollUntil({
          kind: "UDF",
          id: functionName,
          waitingFor: "deleted",
          read: getFunction(organizationId, functionName),
          state: (fn) => fn?.status,
          done: (fn): fn is undefined => fn === undefined,
          session,
          budget: Duration.minutes(10),
          interval: Duration.seconds(10),
        });
      }),
    }),
  );
