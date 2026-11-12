/**
 * Starburst Galaxy operation coverage audit.
 *
 * Galaxy's port of `audit-service.ts`: lists every operation in the
 * distilled Starburst Galaxy SDK, per service, and reports which provider
 * files (resources, bindings, helpers) call it. An operation no provider
 * file calls must carry a reason in `UNUSED`; one with neither fails the
 * audit, so a new SDK operation can't go unnoticed at a wave boundary.
 *
 * Usage:
 *   node scripts/audit-starburst-galaxy.ts
 *   node scripts/audit-starburst-galaxy.ts --json
 *   node scripts/audit-starburst-galaxy.ts --service data_quality
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const SDK_SERVICES = "submodules/distilled/packages/starburst-galaxy/src/services";
const PROVIDER_SRC = "packages/starburst-galaxy/src";

/**
 * SDK operations no provider file calls, with the reason. Keyed
 * `<service>.<operation>`; the catalog files under
 * `processes/StarburstGalaxy/catalog` carry the same classification.
 */
const UNUSED: Record<string, string> = {
  "user.createUser":
    "out of scope: Galaxy has no user delete, so a created user could never be destroyed",
  "role.listRoleGrants":
    "internal: RoleGrant reads the principal's direct grants (getRole, getUser, the group list); this lists a role's grantees, transitive ones included",
  "discovery.deleteCatalogMetadata":
    "internal: CatalogMetadata resets its contacts with one PATCH, the same call that sets them",
  "discovery.deleteCatalogSchema":
    "internal: SchemaMetadata resets description, contacts and links with one PATCH, the same call that sets them",
  "discovery.deleteCatalogSchemaTable":
    "internal: TableMetadata resets description, contacts and links with one PATCH, the same call that sets them",
  "live_table.listBriefLiveTables":
    "internal: LiveTable observes through listLiveTables, which carries the fields the brief list drops",
  "live_table.updateLiveTableSchema":
    "blocked: the SDK's NewJsonSchema column items lost their discriminated arms (typed `{ typeKey: string }`), and no writable lakehouse is available to test a JSON transform table",
  "data_domain.reassignDataDomainDataProducts":
    "internal: a DataProduct's dataDomainId moves it; the bulk reassignment is a console action",
  "data_product.getDataProductDataDomain":
    "internal: DataProduct reads its domain ID from getDataProduct",
};

class AuditFailed extends Data.TaggedError("AuditFailed")<{
  readonly unaccounted: string[];
  readonly stale: string[];
}> {
  override get message() {
    return [
      this.unaccounted.length > 0 &&
        `Operations with no caller and no UNUSED reason: ${this.unaccounted.join(", ")}`,
      this.stale.length > 0 &&
        `UNUSED entries for operations that are called or no longer exist: ${this.stale.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

interface OperationCoverage {
  readonly service: string;
  readonly operation: string;
  readonly callers: string[];
  readonly unused?: string;
}

/** Every `.ts` file under a directory, relative to it. */
const sourceFiles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(root, { recursive: true });
  const files: Array<{ file: string; content: string }> = [];
  for (const entry of entries.filter((name) => name.endsWith(".ts")).sort()) {
    files.push({ file: entry, content: yield* fs.readFileString(path.join(root, entry)) });
  }
  return files;
});

const audit = Effect.fn(function* (only: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = (yield* fs.readDirectory(SDK_SERVICES))
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .map((name) => name.replace(/\.ts$/, ""))
    .filter((name) => only === undefined || name === only)
    .sort();
  const provider = yield* sourceFiles(PROVIDER_SRC);

  const coverage: OperationCoverage[] = [];
  for (const service of services) {
    const content = yield* fs.readFileString(path.join(SDK_SERVICES, `${service}.ts`));
    for (const match of content.matchAll(
      /^export const ([a-z][a-zA-Z0-9]*): API\.(?:Paginated)?OperationMethod</gm,
    )) {
      const operation = match[1]!;
      const call = new RegExp(`\\.${operation}\\b`);
      const callers = provider.filter(({ content }) => call.test(content)).map(({ file }) => file);
      const unused = callers.length > 0 ? undefined : UNUSED[`${service}.${operation}`];
      coverage.push({ service, operation, callers, ...(unused ? { unused } : {}) });
    }
  }
  return coverage;
});

const formatReport = (coverage: OperationCoverage[]) => {
  const lines: string[] = [];
  const byService = Map.groupBy(coverage, (op) => op.service);
  for (const [service, ops] of byService) {
    const called = ops.filter((op) => op.callers.length > 0).length;
    lines.push(`${service} (${called}/${ops.length} called)`);
    for (const op of ops) {
      if (op.callers.length > 0) lines.push(`  ✓ ${op.operation}: ${op.callers.join(", ")}`);
      else if (op.unused) lines.push(`  ○ ${op.operation}: ${op.unused}`);
      else lines.push(`  ✗ ${op.operation}: no caller and no reason`);
    }
  }
  const called = coverage.filter((op) => op.callers.length > 0).length;
  const unused = coverage.filter((op) => op.callers.length === 0 && op.unused).length;
  lines.push(
    "",
    `${coverage.length} operations: ${called} called, ${unused} unused with a reason, ${coverage.length - called - unused} unaccounted`,
  );
  return lines.join("\n");
};

const command = Command.make(
  "audit-starburst-galaxy",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the coverage as JSON"),
      Flag.withDefault(false),
    ),
    service: Flag.String("service").pipe(
      Flag.withDescription("Audit one SDK service, e.g. data_quality"),
      Flag.optional,
    ),
  },
  Effect.fn(function* ({ json, service }) {
    const coverage = yield* audit(service.pipe(Option.getOrUndefined));
    yield* Console.log(json ? JSON.stringify(coverage, null, 2) : formatReport(coverage));
    const unaccounted = coverage
      .filter((op) => op.callers.length === 0 && !op.unused)
      .map((op) => `${op.service}.${op.operation}`);
    const listed = new Set(
      coverage.filter((op) => op.callers.length === 0).map((op) => `${op.service}.${op.operation}`),
    );
    const stale = Option.isSome(service)
      ? []
      : Object.keys(UNUSED).filter((key) => !listed.has(key));
    if (unaccounted.length > 0 || stale.length > 0) {
      return yield* new AuditFailed({ unaccounted, stale });
    }
  }),
).pipe(
  Command.withDescription(
    "Report which distilled Starburst Galaxy operations the provider calls, and why the rest are unused",
  ),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
