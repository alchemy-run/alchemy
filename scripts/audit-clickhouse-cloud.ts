/**
 * ClickHouse Cloud beta-endpoint audit.
 *
 * ClickHouse marks some Cloud API operations Beta in its OpenAPI spec
 * (`x-badges: [{ name: "Beta" }]`; "the API contract is stable, and no
 * breaking changes are expected"). A resource or binding is beta when any
 * operation its own files call is: this script derives that set and checks
 * that each such resource or binding says so in its JSDoc with one line,
 *
 *   Uses ClickHouse Cloud API endpoints marked Beta: `opA`, `opB`.
 *
 * and that no other one carries the line. `--fix` writes the lines.
 *
 * Operations are matched to the spec by method and path, read from the
 * distilled SDK's own HTTP traits. A file's operations are the SDK calls in
 * the file itself and its `…Http.ts` / `…Live.ts` implementation; polling
 * done through `internal/` helpers (service state) is not counted.
 *
 * Usage:
 *   node scripts/audit-clickhouse-cloud.ts --spec <distilled>/packages/clickhouse-cloud/specs/.local/specs/openapi.json
 *   node scripts/audit-clickhouse-cloud.ts --spec … --fix
 *   node scripts/audit-clickhouse-cloud.ts --spec … --json
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SDK_SERVICES = "submodules/distilled/packages/clickhouse-cloud/src/services";
const PROVIDER_SRC = "packages/clickhouse-cloud/src";
const NOTE = "Uses ClickHouse Cloud API endpoints marked Beta:";

class AuditFailed extends Data.TaggedError("AuditFailed")<{ readonly problems: string[] }> {
  override get message() {
    return `Beta labels out of date (run with --fix):\n${this.problems.join("\n")}`;
  }
}

class SpecUnreadable extends Data.TaggedError("SpecUnreadable")<{
  readonly spec: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Cannot read the ClickHouse Cloud OpenAPI spec at ${this.spec}`;
  }
}

interface Owner {
  /** The resource's or binding's own file, relative to the provider source. */
  readonly file: string;
  /** Beta operations its files call, sorted. */
  readonly beta: string[];
}

/** `METHOD /path` of every operation the spec badges Beta. */
const betaEndpoints = Effect.fn(function* (spec: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(spec);
  const doc = yield* Effect.try({
    try: () => JSON.parse(text) as { paths: Record<string, Record<string, unknown>> },
    catch: (cause) => new SpecUnreadable({ spec, cause }),
  });
  const beta = new Set<string>();
  for (const [route, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const badges = (op as { "x-badges"?: Array<{ name?: string }> } | undefined)?.["x-badges"];
      if (badges?.some((b) => b.name === "Beta")) beta.add(`${method.toUpperCase()} ${route}`);
    }
  }
  return beta;
});

/**
 * SDK operation name -> `METHOD /path`, from the SDK: each operation's input
 * schema (`input: __S(n, __cK, j)`) is case `j` of builder `__cK`, whose
 * `T.Http({ method, uri })` trait names the endpoint.
 */
const sdkEndpoints = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const endpoints = new Map<string, string>();
  for (const name of yield* fs.readDirectory(SDK_SERVICES)) {
    if (!name.endsWith(".ts") || name === "index.ts") continue;
    const content = yield* fs.readFileString(path.join(SDK_SERVICES, name));
    const builders = new Map<string, string>();
    for (const m of content.matchAll(/^function (__c\d+)\(j: number\): any \{\n([\s\S]*?)^\}/gm)) {
      builders.set(m[1]!, m[2]!);
    }
    for (const m of content.matchAll(
      /^export const ([a-z][a-zA-Z0-9]*): API\.(?:Paginated)?OperationMethod<[\s\S]*?input: __S\(\s*\d+,\s*(__c\d+),\s*(\d+),?\s*\)/gm,
    )) {
      const body = builders.get(m[2]!) ?? "";
      const at = body.indexOf(`case ${m[3]}:`);
      const next = body.indexOf("    case ", at + 1);
      const block = body.slice(at, next < 0 ? undefined : next);
      const http = /T\.Http\(\{\s*method: "(\w+)",\s*uri: "([^"]+)"/.exec(block);
      if (http) endpoints.set(m[1]!, `${http[1]} ${http[2]}`);
    }
  }
  return endpoints;
});

/** The resource or binding file a source file implements (`XHttp.ts` -> `X.ts`). */
const ownerOf = (file: string) => file.replace(/(Http|Live)\.ts$/, ".ts");

const audit = Effect.fn(function* (spec: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const beta = yield* betaEndpoints(spec);
  const endpoints = yield* sdkEndpoints();
  const betaOps = [...endpoints].filter(([, endpoint]) => beta.has(endpoint)).map(([op]) => op);
  const matched = new Set(endpoints.values());
  const unmatched = [...beta].filter((endpoint) => !matched.has(endpoint));
  if (unmatched.length > 0) {
    return yield* new AuditFailed({
      problems: unmatched.map((endpoint) => `no SDK operation for Beta endpoint ${endpoint}`),
    });
  }
  const files = (yield* fs.readDirectory(PROVIDER_SRC, { recursive: true }))
    .filter((f) => f.endsWith(".ts") && f.includes("/") && !f.startsWith("internal/"))
    .filter((f) => !f.endsWith("/index.ts") && !f.endsWith("/internal.ts"))
    .sort();
  const owners = new Map<string, Set<string>>();
  for (const file of files) {
    const content = yield* fs.readFileString(path.join(PROVIDER_SRC, file));
    const owner = ownerOf(file);
    const set = owners.get(owner) ?? new Set<string>();
    for (const op of betaOps) if (new RegExp(`\\.${op}\\b`).test(content)) set.add(op);
    owners.set(owner, set);
  }
  return [...owners].map(([file, ops]): Owner => ({ file, beta: [...ops].sort() }));
});

/** The JSDoc line for an owner's beta operations. */
const noteFor = (ops: string[]) => ` * ${NOTE} ${ops.map((op) => `\`${op}\``).join(", ")}.`;

/** Insert, replace or drop the note in the JSDoc block that carries `@resource`/`@binding`. */
const relabel = (content: string, ops: string[]) => {
  const lines = content.split("\n");
  const existing = lines.findIndex((line) => line.startsWith(` * ${NOTE}`));
  if (existing >= 0) {
    // The note and the blank JSDoc line after it.
    lines.splice(existing, lines[existing + 1] === " *" ? 2 : 1);
  }
  if (ops.length > 0) {
    const tag = lines.findIndex((line) =>
      /^ \* @(resource|binding|layer|eventsource)\b/.test(line),
    );
    if (tag < 0) return undefined;
    lines.splice(tag, 0, ...noteFor(ops).split("\n"), " *");
  }
  return lines.join("\n");
};

const command = Command.make(
  "audit-clickhouse-cloud",
  {
    spec: Flag.String("spec").pipe(
      Flag.withDescription("Path to ClickHouse's Cloud OpenAPI spec (openapi.json)"),
    ),
    fix: Flag.Boolean("fix").pipe(
      Flag.withDescription("Write the beta notes into the JSDoc"),
      Flag.withDefault(false),
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print every resource and binding with its beta operations as JSON"),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* ({ spec, fix, json }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const owners = yield* audit(spec);
    if (json) yield* Console.log(JSON.stringify(owners, null, 2));
    const problems: string[] = [];
    for (const { file, beta } of owners) {
      const target = path.join(PROVIDER_SRC, file);
      const content = yield* fs.readFileString(target);
      const updated = relabel(content, beta);
      if (updated === undefined) {
        problems.push(`${file}: no @resource/@binding tag to put the note before`);
        continue;
      }
      if (updated === content) continue;
      if (fix) yield* fs.writeFileString(target, updated);
      else
        problems.push(
          `${file}: ${beta.length > 0 ? noteFor(beta).slice(3) : "no beta note expected"}`,
        );
    }
    const labelled = owners.filter((o) => o.beta.length > 0);
    if (!json) {
      yield* Console.log(
        `${labelled.length} of ${owners.length} resources and bindings call Beta endpoints${fix ? " (labels written)" : ""}`,
      );
    }
    if (problems.length > 0) return yield* new AuditFailed({ problems });
  }),
).pipe(
  Command.withDescription(
    "Check that ClickHouse Cloud resources and bindings calling Beta endpoints say so in their JSDoc",
  ),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
