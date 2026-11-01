/**
 * STACKIT service audit: the port of `scripts/audit-service.ts`.
 *
 * Reads a distilled service module, its catalog file and `packages/stackit`,
 * and prints the operations no resource or binding uses, plus the roles and
 * permissions the service's bindings grant.
 *
 * Usage:
 *   node scripts/audit-stackit-service.ts dns
 *   node scripts/audit-stackit-service.ts --json resource_manager
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

type Category = "resource-lifecycle" | "binding" | "event-source" | "internal";

const CATEGORIES: readonly Category[] = [
  "resource-lifecycle",
  "binding",
  "event-source",
  "internal",
];

interface OperationRow {
  operation: string;
  /** Categories from the catalog; empty means the catalog doesn't classify it. */
  categories: Category[];
  /** Files that call it as part of a resource (lifecycle or helper). */
  resources: string[];
  /** Files that call it from a binding layer. */
  bindings: string[];
}

/** Exported operations of a generated service module. */
const parseOperations = (source: string): string[] =>
  [...source.matchAll(/^export const (\w+):\s*(?:API\.)?(?:Paginated)?OperationMethod\b/gm)].map(
    (match) => match[1]!,
  );

/**
 * Categories per operation, from the catalog's operation tables. A row's first
 * cell names the operation, in either casing; a later cell holds the categories.
 */
const parseCatalog = (catalog: string): Map<string, Category[]> => {
  const rows = new Map<string, Category[]>();
  for (const line of catalog.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const name = /^`?(\w+)`?$/.exec(cells[0] ?? "")?.[1];
    if (name === undefined) continue;
    const category = cells
      .slice(1)
      .find((cell) => /^(?:resource-lifecycle|binding|event-source|internal)\b/.test(cell));
    if (category === undefined) continue;
    const key = name.toLowerCase();
    rows.set(key, [
      ...(rows.get(key) ?? []),
      ...CATEGORIES.filter((value) => category.includes(value)),
    ]);
  }
  return rows;
};

const isBindingFile = (file: string, source: string) =>
  /Http\.ts$/.test(file) || /withCredentials|makeHttpBinding|\w+HttpBinding\(/.test(source);

/** The local names a file imports a distilled service module under. */
const serviceAliases = (source: string, service: string): string[] =>
  [
    ...source.matchAll(
      new RegExp(
        `import (?:type )?\\* as (\\w+) from "@distilled\\.cloud/stackit/${service}"`,
        "g",
      ),
    ),
  ].map((match) => match[1]!);

/** `role: "..."` and `permissions: ["..."]` in a binding file. */
const parseGrants = (source: string): string[] => [
  ...[...source.matchAll(/\brole:\s*"([^"]+)"/g)].map((match) => `role ${match[1]}`),
  ...[...source.matchAll(/\bpermissions:\s*\[([^\]]*)\]/g)].flatMap((match) =>
    [...match[1]!.matchAll(/"([^"]+)"/g)].map((name) => `permission ${name[1]}`),
  ),
];

const audit = Effect.fn(function* (service: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const modulePath = path.join(
    root,
    "submodules/distilled/packages/stackit/src/services",
    `${service}.ts`,
  );
  const catalogPath = path.join(root, "processes/Stackit/catalog", `${service}.md`);
  const packagePath = path.join(root, "packages/stackit/src");

  const operations = parseOperations(yield* fs.readFileString(modulePath));
  const catalogExists = yield* fs.exists(catalogPath);
  const catalog = parseCatalog(catalogExists ? yield* fs.readFileString(catalogPath) : "");

  const rows = new Map<string, OperationRow>(
    operations.map((operation) => [
      operation,
      {
        operation,
        categories: catalog.get(operation.toLowerCase()) ?? [],
        resources: [],
        bindings: [],
      },
    ]),
  );

  const grants = new Set<string>();
  const entries = yield* fs.readDirectory(packagePath, { recursive: true });
  for (const entry of entries.filter((file) => file.endsWith(".ts"))) {
    const source = yield* fs.readFileString(path.join(packagePath, entry));
    const aliases = serviceAliases(source, service);
    if (aliases.length === 0) continue;
    const binding = isBindingFile(entry, source);
    if (binding) for (const grant of parseGrants(source)) grants.add(grant);
    for (const alias of aliases) {
      for (const match of source.matchAll(new RegExp(`\\b${alias}\\s*\\.\\s*(\\w+)`, "g"))) {
        const row = rows.get(match[1]!);
        if (row !== undefined) (binding ? row.bindings : row.resources).push(entry);
      }
    }
  }

  const all = [...rows.values()];
  const has = (row: OperationRow, category: Category) => row.categories.includes(category);
  return {
    service,
    catalog: catalogExists ? path.relative(root, catalogPath) : undefined,
    operations: all.length,
    unclassified: all.filter((row) => row.categories.length === 0).map((row) => row.operation),
    missingResource: all
      .filter((row) => has(row, "resource-lifecycle") && row.resources.length === 0)
      .map((row) => row.operation),
    missingBinding: all
      .filter((row) => has(row, "binding") && row.bindings.length === 0)
      .map((row) => row.operation),
    missingEventSource: all
      .filter((row) => has(row, "event-source") && row.resources.length + row.bindings.length === 0)
      .map((row) => row.operation),
    unused: all
      .filter(
        (row) =>
          !has(row, "internal") &&
          row.categories.length > 0 &&
          row.resources.length + row.bindings.length === 0,
      )
      .map((row) => row.operation),
    grants: [...grants].sort(),
  };
});

type Report = Effect.Success<ReturnType<typeof audit>>;

const section = (title: string, items: readonly string[]) =>
  items.length === 0 ? [] : [`${title} (${items.length}):`, ...items.map((item) => `  ${item}`)];

const format = (report: Report) =>
  [
    `${report.service}: ${report.operations} operations, catalog ${report.catalog ?? "MISSING"}`,
    ...section("Not classified in the catalog", report.unclassified),
    ...section("resource-lifecycle with no resource", report.missingResource),
    ...section("binding with no binding", report.missingBinding),
    ...section("event-source with no implementation", report.missingEventSource),
    ...section("Classified but used nowhere", report.unused),
    ...section("Granted by bindings", report.grants),
  ].join("\n");

const command = Command.make(
  "audit-stackit-service",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the report as JSON"),
      Flag.withDefault(false),
    ),
    service: Argument.String("service").pipe(
      Argument.withDescription("Distilled service module, e.g. dns, resource_manager"),
    ),
  },
  Effect.fn(function* ({ json, service }) {
    const report = yield* audit(service);
    yield* Console.log(json ? JSON.stringify(report, null, 2) : format(report));
  }),
).pipe(
  Command.withDescription(
    "Compare a distilled STACKIT service against its catalog and packages/stackit",
  ),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
