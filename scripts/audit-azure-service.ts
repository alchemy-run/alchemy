#!/usr/bin/env bun
/**
 * Azure service audit — the Azure port of `scripts/audit-service.ts`.
 *
 * Classifies every operation of every distilled Azure service module as
 * `resource-lifecycle | binding | event-source | internal`, maps each ARM
 * resource type to the Alchemy resources that call its operations, and
 * (with `--data-plane`) classifies the operations of Azure's data-plane
 * Swagger specs, which distilled does not generate yet.
 *
 * Usage:
 *   bun scripts/audit-azure-service.ts                  # summary of every service
 *   bun scripts/audit-azure-service.ts storage keyvault # selected services
 *   bun scripts/audit-azure-service.ts --json           # machine-readable report
 *   bun scripts/audit-azure-service.ts --data-plane <azure-rest-api-specs checkout>
 *   bun scripts/audit-azure-service.ts --write processes/Azure/catalog
 *
 * `--data-plane` reads `specification/<service>/data-plane/<group>/stable/<version>/*.json`
 * (latest stable version per group). `--write` writes one `<service>.md` per
 * distilled service, `data-plane.md`, `audit.json`, and `INDEX.md`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Category = "resource-lifecycle" | "binding" | "event-source" | "internal";

interface ArmOperation {
  name: string;
  method: string;
  uri: string;
  category: Category;
  reason: string;
  armType: string | undefined;
  usedBy: string[];
}

interface ArmType {
  armType: string;
  service: string;
  putOp: string | undefined;
  ops: string[];
  alchemyTypes: string[];
  status: "implemented" | "missing" | "out-of-scope";
  reason: string;
}

interface DataPlaneOperation {
  service: string;
  group: string;
  version: string;
  operationId: string;
  method: string;
  path: string;
  category: Category;
  reason: string;
  binding: string | undefined;
}

const repo = path.resolve(import.meta.dirname, "..");
const distilledServices = path.join(repo, "submodules/distilled/packages/azure/src/services");
const alchemySrc = path.join(repo, "packages/azure/src");
const alchemyTests = path.join(repo, "packages/integration-tests/test/Azure");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const asJson = args.includes("--json");
if (asJson) args.splice(args.indexOf("--json"), 1);
const dataPlaneRoot = flag("--data-plane");
const writeDir = flag("--write");
const selected = args;

// ============ Distilled ARM operations ============

const parseService = (file: string) => {
  const text = fs.readFileSync(file, "utf8");
  const http = new Map<string, { method: string; uri: string }>();
  const re =
    /T\.Http\(\{\s*method: "(\w+)",\s*uri: "([^"]+)"[\s\S]*?\.annotate\(\{\s*identifier:\s*"(\w+)",?\s*\}\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    // A request schema can be shared; the last annotation before the identifier wins.
    const lastHttp = m[0].lastIndexOf("T.Http({");
    const inner = m[0].slice(lastHttp).match(/method: "(\w+)",\s*uri: "([^"]+)"/);
    http.set(m[3]!, { method: inner?.[1] ?? m[1]!, uri: inner?.[2] ?? m[2]! });
  }
  const ops: { name: string; method: string; uri: string }[] = [];
  const opRe = /^export const (\w+): API\.OperationMethod<\s*(\w+),/gm;
  while ((m = opRe.exec(text))) {
    const h = http.get(m[2]!);
    ops.push({ name: m[1]!, method: h?.method ?? "?", uri: h?.uri ?? "?" });
  }
  return ops;
};

/** `Microsoft.Storage/storageAccounts/blobServices` from an ARM URI. */
const armTypeOf = (uri: string): string | undefined => {
  const i = uri.lastIndexOf("/providers/");
  if (i === -1) {
    // Subscription-level ARM paths (`/subscriptions/{id}/resourcegroups/{name}`).
    const rest = uri
      .replace(/^\/subscriptions\/\{[^}]+\}\/?/, "")
      .split("/")
      .filter(Boolean);
    if (rest.length === 0 || rest[0]!.startsWith("{")) return undefined;
    const types: string[] = [];
    for (let s = 0; s < rest.length; s += 2) types.push(rest[s]!);
    return ["Microsoft.Resources", ...types].join("/");
  }
  const segments = uri.slice(i + "/providers/".length).split("/");
  const namespace = segments[0];
  if (!namespace || namespace.startsWith("{")) return undefined;
  const types: string[] = [];
  for (let s = 1; s < segments.length; s += 2) types.push(segments[s]!);
  return [namespace, ...types].join("/");
};

/** True when the URI addresses one instance (ends with a name segment). */
const isInstancePath = (uri: string) => {
  const i = uri.lastIndexOf("/providers/");
  if (i === -1) {
    const rest = uri
      .replace(/^\/subscriptions\/\{[^}]+\}\/?/, "")
      .split("/")
      .filter(Boolean);
    return rest.length >= 2 && rest.length % 2 === 0;
  }
  const segments = uri.slice(i + "/providers/".length).split("/");
  return segments.length >= 3 && segments.length % 2 === 1;
};

const INTERNAL_RULES: [RegExp, string][] = [
  [/\/providers\/Microsoft\.[\w.]+\/operations$/i, "API metadata (operation list)"],
  [
    /\/(operationResults|operationStatuses|operationsStatus|operationStatus|asyncOperations|operationresults|azureAsyncOperation)(\/|$)/i,
    "long-running-operation polling",
  ],
  [/\/locations\/\{[^}]+\}\/operations?\//i, "long-running-operation polling"],
  [/\/check\w*Availability\w*$/i, "name validation (used inside reconcile)"],
  [/\/(usages|skus|availableSkus|capabilities|quotas|locations)$/i, "read-only platform metadata"],
  [/\/(whatIf|validate\w*)$/i, "validation or what-if preview"],
];

const CREDENTIAL_ACTION =
  /^(list|get|regenerate|rotate|reset)\w*(Keys?|Secrets?|Credentials?|ConnectionStrings?|Passwords?|Tokens?|Sas\w*|SharedAccess\w*|Certificates?)$/i;

/** POST actions application code calls at runtime (AWS treats `StartInstances`, `RunTask`, `StartExecution` as bindings). */
const RUNTIME_ACTION =
  /^(start|stop|restart|run|execute|trigger|cancel|resume|suspend|pause|purge|flush|publish|query|refresh|sync|backup|restore|failover|deallocate|powerOff|redeploy|reboot|send|invoke|upload|download|import|export|scale|abort|retry|rerun|replay|wake|hibernate|reset|swap|clear)/i;

const classifyArm = (method: string, uri: string): { category: Category; reason: string } => {
  for (const [re, reason] of INTERNAL_RULES) {
    if (re.test(uri)) return { category: "internal", reason };
  }
  if (/\/eventSubscriptions(\/|$)/i.test(uri)) {
    return {
      category: "event-source",
      reason: "Event Grid subscription delivers events to a runtime",
    };
  }
  if (method === "POST") {
    const action = uri.split("/").pop() ?? "";
    if (CREDENTIAL_ACTION.test(action)) {
      return {
        category: "internal",
        reason: "credential export; bindings authenticate with Entra ID role assignments",
      };
    }
    if (/^(list|get)/i.test(action)) {
      return { category: "internal", reason: "read-only report (POST list/get)" };
    }
    if (RUNTIME_ACTION.test(action)) {
      return { category: "binding", reason: "runtime action on the resource" };
    }
    return {
      category: "internal",
      reason:
        "administrative action (upgrade, migrate, validate, register, ...); not called by application code",
    };
  }
  if (
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "GET" ||
    method === "HEAD"
  ) {
    return { category: "resource-lifecycle", reason: isInstancePath(uri) ? "instance" : "list" };
  }
  return { category: "internal", reason: `unparsed operation (${method})` };
};

// ============ Alchemy usage ============

const walk = (dir: string, out: string[] = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
};

const alchemyFiles = walk(alchemySrc);
/** `${service}.${Op}` → alchemy files calling it. */
const usage = new Map<string, Set<string>>();
/** alchemy file → resource types declared there. */
const declaredTypes = new Map<string, string[]>();
const bindingServices: { name: string; file: string }[] = [];
for (const file of alchemyFiles) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(repo, file);
  const types = [
    ...text.matchAll(/=\s*(?:Grouped)?Resource<\w+>\(\s*"(Azure\.[\w.]+)"/g),
    ...text.matchAll(/Platform\((\w+TypeId)/g),
  ].map((m) => m[1]!);
  if (types.length > 0) declaredTypes.set(rel, types);
  for (const m of text.matchAll(/Binding\.Service<\w+>\(\s*"(Azure\.[\w.]+)"/g)) {
    bindingServices.push({ name: m[1]!, file: rel });
  }
  for (const imp of text.matchAll(
    /import \* as (\w+) from "@distilled\.cloud\/azure\/([\w-]+)"/g,
  )) {
    const [, alias, service] = imp;
    for (const call of text.matchAll(new RegExp(`\\b${alias}\\s*\\.\\s*(\\w+)\\b`, "g"))) {
      const key = `${service}.${call[1]}`;
      if (!usage.has(key)) usage.set(key, new Set());
      usage.get(key)!.add(rel);
    }
  }
}

const testFiles = new Set(walk(alchemyTests).map((f) => path.relative(alchemyTests, f)));
const hasTest = (alchemyType: string) => {
  const [, service, name] = alchemyType.split(".");
  return testFiles.has(`${service}/${name}.test.ts`);
};

// ============ Scope rules for ARM types no resource implements ============

const OUT_OF_SCOPE: [RegExp, string][] = [
  [/privateEndpointConnections$/i, "approval object; managed from Network.PrivateEndpoint"],
  [/privateLinkResources$/i, "read-only platform metadata"],
  [/^Microsoft\.AwsConnector\//i, "read-only mirror of AWS inventory"],
  [
    /^Microsoft\.(Billing|BillingBenefits|Capacity|Commerce|Consumption\/reservation|Reservations|Marketplace\w*|MarketplaceOrdering|Subscription|Support|Quota|CostManagement\/(exports|views|scheduledActions)?.*Benefit)/i,
    "billing, subscription, quota, or support object",
  ],
  [/^Microsoft\.(DataBox|DataBoxEdge|EdgeOrder)\//i, "hardware order"],
  [
    /^Microsoft\.(AppPlatform|CustomerInsights|TimeSeriesInsights|DataLakeAnalytics|DataLakeStore|StorageCache|StoragePool|LabServices|Orbital|Scheduler|MachineLearning\/|DevSpaces|DBforPostgreSQL\/serverGroupsv2|DBforMySQL\/servers|DBforPostgreSQL\/servers|DBforMariaDB)/i,
    "retired or closed to new customers",
  ],
  [
    /\/(jobs|runs|executions|incidents|remediations|migrations|imports|exports)$/i,
    "data-plane or run record, not desired state",
  ],
  [
    /\/(updateRuns|scriptExecutions|privilegedJobs|sourceControlSyncJobs|packetCaptures|reachabilityAnalysisRuns|consoles|dryruns|applyUpdates|deployments|backups|backupsV2|commits)$/i,
    "action or run record, not desired state",
  ],
  [/privateEndpointConnectionProxies$/i, "approval object; managed from Network.PrivateEndpoint"],
  [/^Microsoft\.GcpConnector\//i, "read-only mirror of GCP inventory"],
  [
    /^Microsoft\.(ConnectedVMwarevSphere|ScVmm|OffAzure|AzureArcData|NetworkCloud|ManagedNetworkFabric|AzureStack|VMwareCloudSimple|BareMetalInfrastructure|HybridContainerService|AzureStackHCI)\//i,
    "needs external systems or hardware (vCenter, SCVMM, Arc machines, on-premises racks)",
  ],
  [
    /^Microsoft\.Network\/expressRouteCrossConnections/i,
    "owned by the ExpressRoute connectivity provider",
  ],
  [/^Microsoft\.(Contoso|Widget)\//i, "sample API"],
  [/^Microsoft\.ProviderHub\//i, "resource-provider authoring; needs Microsoft partner onboarding"],
  [/^Microsoft\.(Portal|PortalServices)\//i, "portal user settings (end-user data)"],
  [/^Microsoft\.(ComputeLimit)\//i, "billing, subscription, quota, or support object"],
  [
    /^Microsoft\.(CostManagement|SoftwarePlan|WindowsIoT)\//i,
    "billing, subscription, quota, or support object",
  ],
  [
    /\/(agreements|commitmentPlans|accountAssociations|quotaTiers|costs)$/i,
    "billing, subscription, quota, or support object",
  ],
  [
    /^Microsoft\.SecurityInsights\/(bookmarks|incidents|threatIntelligence)/i,
    "Sentinel content (end-user data)",
  ],
  [
    /^Microsoft\.SecurityAndCompliance\//i,
    "closed or allow-listed preview (M365 compliance private links)",
  ],
  [/^Microsoft\.DelegatedNetwork\//i, "closed or allow-listed preview"],
  [
    /^Microsoft\.(Cdn\/profiles\/endpoints|Cdn\/cdnWebApplicationFirewallPolicies|Network\/frontDoors|Network\/NetworkExperimentProfiles|Logic\/integrationServiceEnvironments|Maps\/accounts\/creators|AzurePlaywrightService|HealthcareApis\/services|DataCatalog|PowerBI\/workspaceCollections|ContainerService\/containerServices|Automation\/automationAccounts\/(python2Packages|softwareUpdateConfigurations))/i,
    "retired or closed to new customers",
  ],
  [/^Microsoft\.AzureActiveDirectory\//i, "retired or closed to new customers (Azure AD B2C)"],
  [/^Microsoft\.Features\//i, "subscription setting (preview feature registration)"],
  [
    /^Microsoft\.Resources\/(tags|dataBoundaries|deploymentStacksWhatIfResults)$/i,
    "duplicate of per-resource tags, tenant setting, or what-if result",
  ],
  [/^Microsoft\.Web\/(publishingUsers|sourcecontrols)$/i, "user-level credentials or OAuth tokens"],
  [/^Microsoft\.Help\//i, "action, not desired state"],
  [/^Microsoft\.Network\/firstPartyServiceTags$/i, "Microsoft first-party only"],
];

// ============ Build the report ============

const services = fs
  .readdirSync(distilledServices)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .map((f) => f.replace(/\.ts$/, ""))
  .filter((s) => selected.length === 0 || selected.includes(s))
  .sort();

const report = services.map((service) => {
  const ops: ArmOperation[] = parseService(path.join(distilledServices, `${service}.ts`)).map(
    (op) => {
      const { category, reason } = classifyArm(op.method, op.uri);
      return {
        ...op,
        category,
        reason,
        armType: armTypeOf(op.uri),
        usedBy: [...(usage.get(`${service}.${op.name}`) ?? [])],
      };
    },
  );
  const types = new Map<string, ArmType>();
  for (const op of ops) {
    if (op.category !== "resource-lifecycle" && op.category !== "event-source") continue;
    if (op.armType === undefined) continue;
    const t =
      types.get(op.armType) ??
      ({
        armType: op.armType,
        service,
        putOp: undefined,
        ops: [],
        alchemyTypes: [],
        status: "missing",
        reason: "",
      } satisfies ArmType);
    t.ops.push(op.name);
    if (op.method === "PUT" && isInstancePath(op.uri)) t.putOp ??= op.name;
    for (const file of op.usedBy) {
      for (const type of declaredTypes.get(file) ?? []) {
        if (!t.alchemyTypes.includes(type)) t.alchemyTypes.push(type);
      }
    }
    types.set(op.armType, t);
  }
  // Only types with a PUT are deployable resources; the rest are read-only views.
  const resourceTypes = [...types.values()].filter((t) => t.putOp !== undefined);
  for (const t of resourceTypes) {
    if (t.alchemyTypes.length > 0) {
      t.status = "implemented";
      t.reason = t.alchemyTypes.every(hasTest) ? "tested" : "no test file for every resource";
      continue;
    }
    const rule = OUT_OF_SCOPE.find(([re]) => re.test(t.armType));
    if (rule) {
      t.status = "out-of-scope";
      t.reason = rule[1];
    } else {
      t.status = "missing";
      t.reason = "no Alchemy resource calls its operations";
    }
  }
  const bindingOps = ops.filter((o) => o.category === "binding");
  return { service, ops, resourceTypes, bindingOps };
});

// ============ Data plane ============

const EXISTING_DATA_PLANE_BINDINGS: [RegExp, string][] = [
  [/^QueueStorage\|.*(Messages_Enqueue|EnqueueMessage)/i, "Azure.Storage.QueueSend"],
  [
    /^QueueStorage\|.*(Messages_Dequeue|DequeueMessages|MessageId_Delete|DeleteMessage)/i,
    "Azure.Storage.QueueReceive",
  ],
  [
    /^BlobStorage\|.*(Blob_Download|Blob_GetProperties|Container_ListBlobFlatSegment|DownloadBlob|GetBlobProperties|ListBlobFlatSegment)/i,
    "Azure.Storage.BlobContainerRead",
  ],
  [
    /^BlobStorage\|.*(BlockBlob_Upload|Blob_Delete|UploadBlockBlob|DeleteBlob)$/i,
    "Azure.Storage.BlobContainerWrite",
  ],
  [/^Secrets\|GetSecret$/i, "Azure.KeyVault.SecretRead"],
];

const OUT_OF_SCOPE_GROUPS: [RegExp, string][] = [
  [/^(contosowidgetmanager|widget)\|/, "sample spec"],
  [/^(datalake-analytics|datalake-store|timeseriesinsights)\|/, "retired service"],
  [
    /^cognitiveservices\|(LUIS|Personalizer|AnomalyDetector|MetricsAdvisor|ContentModerator|FormRecognizer|ComputerVision|TextAnalytics|Face)/,
    "retired or superseded by a newer data plane",
  ],
  [/^keyvault\|Legacy/, "superseded api-version of the Key Vault data planes"],
  [/^keyvault\|SecretsStorage/, "Key Vault managed storage account keys (deprecated feature)"],
  [/^imds\|/, "instance metadata: a credentials provider in distilled, not a binding"],
  [/^machinelearningservices\|/, "ML workspace run records (end-user data)"],
  [/^purview\|/, "data-governance catalog content (end-user data)"],
  [/^marketplacecatalog\|/, "marketplace catalog (billing/marketplace)"],
  [/^servicefabric\|/, "cluster management API of self-hosted Service Fabric"],
];

const dataPlane: DataPlaneOperation[] = [];
const dataPlaneGroups: {
  service: string;
  group: string;
  version: string;
  ops: number;
  scope: string;
}[] = [];
if (dataPlaneRoot) {
  const specRoot = path.join(dataPlaneRoot, "specification");
  const re = /^specification\/([^/]+)\/data-plane\/(.+?)\/stable\/([^/]+)\/([^/]+\.json)$/;
  const latest = new Map<string, { version: string; files: string[] }>();
  for (const file of walkJson(specRoot)) {
    const rel = path.relative(dataPlaneRoot, file);
    const m = rel.match(re);
    if (!m || rel.includes("/examples/")) continue;
    const key = `${m[1]}|${m[2]}`;
    const cur = latest.get(key);
    if (!cur || m[3]! > cur.version) latest.set(key, { version: m[3]!, files: [file] });
    else if (m[3] === cur.version) cur.files.push(file);
  }
  for (const [key, { version, files: all }] of [...latest].sort()) {
    // Storage ships a hand-written and a TypeSpec-generated (`generated_*`) copy.
    const files = all.some((f) => !path.basename(f).startsWith("generated_"))
      ? all.filter((f) => !path.basename(f).startsWith("generated_"))
      : all;
    const [service, group] = key.split("|") as [string, string];
    const scope = OUT_OF_SCOPE_GROUPS.find(([re]) => re.test(key))?.[1] ?? "in scope";
    let count = 0;
    for (const file of files) {
      const doc = JSON.parse(fs.readFileSync(file, "utf8")) as {
        paths?: Record<string, Record<string, { operationId?: string }>>;
        "x-ms-paths"?: Record<string, Record<string, { operationId?: string }>>;
      };
      for (const [p, methods] of Object.entries({ ...doc.paths, ...doc["x-ms-paths"] })) {
        for (const [method, op] of Object.entries(methods)) {
          if (!op || typeof op !== "object" || !("operationId" in op)) continue;
          const operationId = op.operationId ?? `${method} ${p}`;
          count++;
          const existing = EXISTING_DATA_PLANE_BINDINGS.find(([re]) =>
            re.test(`${group}|${operationId}`),
          )?.[1];
          const isServiceAdmin =
            /ServiceProperties|ServiceStats|GetAccountInfo|UserDelegationKey/i.test(operationId);
          dataPlane.push({
            service,
            group,
            version,
            operationId,
            method: method.toUpperCase(),
            path: p,
            category: scope !== "in scope" || isServiceAdmin ? "internal" : "binding",
            reason:
              scope !== "in scope"
                ? scope
                : isServiceAdmin
                  ? "account-level settings, configured through the ARM resource"
                  : "data-plane operation",
            binding: existing,
          });
        }
      }
    }
    dataPlaneGroups.push({ service, group, version, ops: count, scope });
  }
}

function walkJson(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJson(p, out);
    else if (entry.name.endsWith(".json")) out.push(p);
  }
  return out;
}

// ============ Output ============

const count = <T>(items: T[], key: (t: T) => string) =>
  items.reduce<Record<string, number>>((acc, item) => {
    const k = key(item);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

const allOps = report.flatMap((r) => r.ops);
const allTypes = report.flatMap((r) => r.resourceTypes);
const summary = {
  services: report.length,
  armOperations: allOps.length,
  armByCategory: count(allOps, (o) => o.category),
  unparsedOperations: allOps.filter((o) => o.method === "?").length,
  resourceTypes: allTypes.length,
  resourceTypesByStatus: count(allTypes, (t) => t.status),
  alchemyResourceTypes: [...declaredTypes.values()].flat().length,
  alchemyTypesWithoutTestFile: new Set(
    [...declaredTypes.values()].flat().filter((t) => t.startsWith("Azure.") && !hasTest(t)),
  ).size,
  bindingServices: bindingServices.length,
  dataPlaneGroups: dataPlaneGroups.length,
  dataPlaneGroupsInScope: dataPlaneGroups.filter((g) => g.scope === "in scope").length,
  dataPlaneOperations: dataPlane.length,
  dataPlaneByCategory: count(dataPlane, (o) => o.category),
  dataPlaneWithBinding: dataPlane.filter((o) => o.binding !== undefined).length,
};

if (asJson) {
  console.log(
    JSON.stringify({ summary, report, dataPlaneGroups, dataPlane, bindingServices }, null, 2),
  );
} else {
  console.log(JSON.stringify(summary, null, 2));
  if (selected.length > 0) {
    for (const r of report) {
      console.log(`\n## ${r.service}`);
      for (const t of r.resourceTypes)
        console.log(`  ${t.status.padEnd(12)} ${t.armType}  ${t.alchemyTypes.join(", ")}`);
      for (const o of r.bindingOps) console.log(`  binding      ${o.name}  ${o.method} ${o.uri}`);
    }
  }
}

if (writeDir) {
  fs.mkdirSync(writeDir, { recursive: true });
  fs.writeFileSync(
    path.join(writeDir, "audit.json"),
    JSON.stringify({ summary, report, dataPlaneGroups, dataPlane, bindingServices }, null, 2),
  );
  for (const r of report) {
    const lines = [
      `# ${r.service}`,
      "",
      "Generated by `bun scripts/audit-azure-service.ts --write`. Every operation of",
      `\`@distilled.cloud/azure/${r.service}\`, classified.`,
      "",
      "## Resource types",
      "",
      "| ARM type | Status | Alchemy resources | Reason |",
      "| --- | --- | --- | --- |",
      ...r.resourceTypes.map(
        (t) => `| \`${t.armType}\` | ${t.status} | ${t.alchemyTypes.join(", ")} | ${t.reason} |`,
      ),
      "",
      "## Operations",
      "",
      "| Operation | Method | Category | Reason | Used by |",
      "| --- | --- | --- | --- | --- |",
      ...r.ops.map(
        (o) =>
          `| \`${o.name}\` | ${o.method} | ${o.category} | ${o.reason} | ${o.usedBy.map((f) => path.basename(f)).join(", ")} |`,
      ),
      "",
    ];
    fs.writeFileSync(path.join(writeDir, `${r.service}.md`), lines.join("\n"));
  }
  if (dataPlaneRoot) {
    const lines = [
      "# Azure data planes",
      "",
      "Latest stable data-plane Swagger per group in Azure/azure-rest-api-specs.",
      "distilled does not generate these yet (Phase 2).",
      "",
      "| Service | Group | Version | Operations | Scope |",
      "| --- | --- | --- | --- | --- |",
      ...dataPlaneGroups.map(
        (g) => `| ${g.service} | ${g.group} | ${g.version} | ${g.ops} | ${g.scope} |`,
      ),
      "",
      "| Service | Group | Operation | Method | Category | Existing binding |",
      "| --- | --- | --- | --- | --- | --- |",
      ...dataPlane.map(
        (o) =>
          `| ${o.service} | ${o.group} | \`${o.operationId}\` | ${o.method} | ${o.category} | ${o.binding ?? ""} |`,
      ),
      "",
    ];
    fs.writeFileSync(path.join(writeDir, "data-plane.md"), lines.join("\n"));
  }
  fs.writeFileSync(path.join(writeDir, "INDEX.md"), renderIndex());
}

// ============ INDEX.md ============

interface Row {
  kind: string;
  name: string;
  status: string;
  note: string;
}

/** Status of an implemented resource from its own test file. */
function resourceRow(alchemyType: string): Row {
  const [, service, name] = alchemyType.split(".");
  const file = path.join(alchemyTests, service!, `${name}.test.ts`);
  if (!fs.existsSync(file)) {
    return { kind: "resource", name: alchemyType, status: "implemented", note: "no own test file" };
  }
  const text = fs.readFileSync(file, "utf8");
  const ungated = (text.match(/test\.provider\(/g) ?? []).length;
  const skipped = text.match(/\/\/ Skipped:(.*)/)?.[1]?.trim();
  if (/test\.provider\.skip\(/.test(text) && ungated === 0) {
    return {
      kind: "resource",
      name: alchemyType,
      status: "blocked: skipped",
      note: skipped ?? "test.provider.skip",
    };
  }
  if (ungated === 0 && /skipIf\(!runExpensive/.test(text)) {
    const cost = text.match(/\/\/ [^\n]*(~\$[^\n]*|hour[^\n]*)/)?.[0]?.replace(/^\/\/ /, "") ?? "";
    return { kind: "resource", name: alchemyType, status: "blocked: cost", note: cost };
  }
  if (ungated === 0 && /skipIf\(!runPaidOnly/.test(text)) {
    return {
      kind: "resource",
      name: alchemyType,
      status: "blocked: paid",
      note: "AZURE_TEST_PAID (partner SaaS, hardware, gated preview, or external system)",
    };
  }
  return {
    kind: "resource",
    name: alchemyType,
    status: "implemented",
    note: "ungated test file; not run this round",
  };
}

function exists(p: string) {
  return fs.existsSync(path.join(repo, p));
}
function has(re: RegExp) {
  return alchemyFiles.some((f) => re.test(fs.readFileSync(f, "utf8")));
}

function deliverableRows(): Row[] {
  const rows: Row[] = [];
  const row = (kind: string, name: string, done: boolean, note: string) =>
    rows.push({ kind, name, status: done ? "implemented" : "missing", note });

  // Distilled (Phase 2).
  row(
    "distilled",
    "data-plane modules from specification/*/data-plane",
    false,
    `${dataPlaneGroups.filter((g) => g.scope === "in scope").length} in-scope groups, ${dataPlane.filter((o) => o.category === "binding").length} operations`,
  );
  row(
    "distilled",
    "XML bodies, SAS, per-data-plane token audience in the protocol",
    false,
    "Storage blob/queue/file are XML; Key Vault, Storage, Service Bus each need their own audience",
  );
  row(
    "distilled",
    "manual spec: Service Bus messaging REST (send/receive/peek-lock/complete)",
    false,
    "no Swagger upstream",
  );
  row("distilled", "manual spec: Event Hubs send REST", false, "no Swagger upstream");
  row(
    "distilled",
    "manual spec: Cosmos DB NoSQL REST (documents, queries)",
    false,
    "no Swagger upstream; Tables is in specs",
  );
  row(
    "distilled",
    "manual spec: Kudu OneDeploy / zip deploy",
    false,
    "used by Functions.Function and Website.AppDeployment",
  );
  row(
    "distilled",
    "managed-identity credentials provider (IMDS + IDENTITY_ENDPOINT)",
    false,
    "replaces Binding.ts/Token.ts token caches; model on AWS fromContainerMetadata",
  );
  row(
    "distilled",
    "nextLink pagination (`.pages` / `.items`)",
    true,
    "ARM list ops are paginated; alchemy reads every page with `collectAll` (Arm.ts)",
  );
  row(
    "distilled",
    "per-operation typed errors",
    false,
    "errors are client-level only (AZURE_ERROR_CODE_MAP)",
  );

  // Bindings infrastructure.
  row(
    "bindings",
    "AzureBindings.ts (HostBinding, Bind, withCredentials, host bundle)",
    exists("packages/azure/src/AzureBindings.ts"),
    "Binding.ts uses host.bind with a host allowlist",
  );
  row(
    "bindings",
    "test/Azure/ExternalHost/CloudflareWorker.test.ts",
    exists("packages/integration-tests/test/Azure/ExternalHost/CloudflareWorker.test.ts"),
    "",
  );
  row("bindings", "Azure hosts in other providers' ExternalHost suites", false, "");

  // Runtimes.
  const runtimes: [string, string, boolean][] = [
    ["Azure.Functions.Function", "packages/azure/src/Functions/Function.ts", true],
    ["Azure.Web.FunctionApp", "packages/azure/src/Web/FunctionApp.ts", false],
    ["Azure.Web.WebApp", "packages/azure/src/Web/WebApp.ts", false],
    ["Azure.ContainerApps.ContainerApp", "packages/azure/src/ContainerApps/ContainerApp.ts", false],
    ["Azure.ContainerApps.Job", "packages/azure/src/ContainerApps/Job.ts", false],
    [
      "Azure.ContainerInstance.ContainerGroup",
      "packages/azure/src/ContainerInstance/ContainerGroup.ts",
      false,
    ],
    ["Azure.Compute.VirtualMachine", "packages/azure/src/Compute/VirtualMachine.ts", false],
  ];
  for (const [name, file, effectful] of runtimes) {
    const text = fs.existsSync(path.join(repo, file))
      ? fs.readFileSync(path.join(repo, file), "utf8")
      : "";
    row(
      "runtime",
      `${name} effectful form`,
      effectful && /Platform\(/.test(text),
      effectful ? "on Platform; bindings never attach (host allowlist)" : "plain resource",
    );
    row("runtime", `${name} async form`, /### Async/.test(text), "");
    row("runtime", `${name} tests for both forms`, false, "");
  }
  row("runtime", "Azure.InferEnv", has(/export type InferEnv/), "");
  // Event sources: the Functions.Function trigger layer each one registers.
  const functionEventSources = exists("packages/azure/src/Functions/EventSources.ts")
    ? fs.readFileSync(path.join(repo, "packages/azure/src/Functions/EventSources.ts"), "utf8")
    : "";
  for (const [source, layer] of [
    ["Storage queue", "StorageQueueEventSource"],
    ["Blob storage", "BlobCreatedEventSource"],
    ["Service Bus queue/topic", "ServiceBusSubscriptionEventSource"],
    ["Event Hubs", "EventHubEventSource"],
    ["Event Grid", "EventGridEventSource"],
    ["Cosmos DB change feed", "CosmosDBChangeFeedEventSource"],
    ["Timer (schedule)", "schedule"],
  ] as const) {
    row(
      "event-source",
      source,
      new RegExp(`export (const|function) ${layer}\\b`).test(functionEventSources) ||
        has(new RegExp(`export (const|function) ${layer}\\b`)),
      `Azure.Functions trigger layer \`${layer}\``,
    );
  }
  row(
    "workflow-engine",
    "Durable Functions / Durable Task Scheduler engine (host + remote)",
    has(/WorkflowEngine/),
    "8 conformance cases",
  );

  // Websites.
  const frameworks = [
    "Astro",
    "Foldkit",
    "Nextjs",
    "Nuxt",
    "Octane",
    "ReactRouter",
    "SolidStart",
    "StaticSite",
    "SvelteKit",
    "TanStackStart",
    "Vinext",
    "Vite",
    "Vocs",
    "Waku",
  ];
  const read = (p: string) => (exists(p) ? fs.readFileSync(path.join(repo, p), "utf8") : "");
  const frameworkSite = read("packages/azure/src/Website/FrameworkSite.ts");
  row(
    "website",
    "CDN (Front Door) on by default, purge on deploy",
    /frontDoor: site\.frontDoor \?\? \{\}/.test(frameworkSite) && /purge/.test(frameworkSite),
    "Front Door unless `frontDoor: false`; redeploys purge changed paths",
  );
  row(
    "website",
    "SSR on Azure Functions (Flex Consumption)",
    /from "\.\.\/Functions\/Function\.ts"/.test(frameworkSite),
    "server entry bundled into Azure.Functions.Function",
  );
  // Directory, example and docs names: lower case, `react-router`, `tanstack-start`.
  const kebab = (fw: string) =>
    ({ ReactRouter: "react-router", TanStackStart: "tanstack-start" })[fw] ?? fw.toLowerCase();
  for (const fw of frameworks) {
    const testFile = `packages/integration-tests/test/Azure/Website/${fw}.test.ts`;
    row(
      "website",
      `Azure.Website.${fw}`,
      exists(`packages/azure/src/Website/${fw}.ts`) && exists(testFile),
      "Blob + Front Door; server builds on Flex Consumption",
    );
    if (fw !== "StaticSite" && fw !== "Vite") {
      const dir = kebab(fw);
      row(
        "website",
        `frontend-frameworks/${dir}/azure.ts`,
        exists(`packages/frontend-frameworks/src/${dir}/azure.ts`),
        "",
      );
    }
    const example =
      fw === "StaticSite" ? "examples/azure-website-static" : `examples/azure-website-${kebab(fw)}`;
    row("example", example, exists(example), "");
    if (fw !== "StaticSite") {
      const page = `website/src/content/docs/azure/frontend/${kebab(fw)}.mdx`;
      row("docs", page, exists(page), "");
    }
  }
  row(
    "docs",
    "website/src/content/docs/azure/frontend/static-site.mdx",
    exists("website/src/content/docs/azure/frontend/static-site.mdx"),
    "",
  );

  // Workload examples.
  for (const ex of [
    "azure-function",
    "azure-function-async",
    "azure-function-httpapi",
    "azure-container-app",
    "azure-container-app-job",
    "azure-storage-queue",
    "azure-schedule",
    "azure-storage-uploads",
    "azure-service-bus",
    "azure-event-hubs",
    "azure-postgres-drizzle",
    "azure-sql",
    "azure-redis",
    "azure-key-vault",
    "azure-aks",
    "azure-vm",
    "azure-cosmos",
    "azure-openai",
    "azure-service-to-service",
    "azure-effect-workflows",
    "azure-dev",
  ]) {
    row("example", `examples/${ex}`, exists(`examples/${ex}`), "");
  }

  // Docs.
  for (const page of [
    "index",
    "setup",
    "tutorial/part-1",
    "tutorial/part-2",
    "tutorial/part-3",
    "tutorial/part-4",
    "tutorial/part-5",
    "compute/choosing-a-runtime",
    "compute/functions",
    "compute/container-apps",
    "compute/aks",
    "compute/vms",
    "compute/effect-workflows",
    "data/storage",
    "data/cosmos-db",
    "data/postgres",
    "data/sql",
    "messaging/storage-queues",
    "messaging/service-bus",
    "messaging/event-hubs",
    "messaging/event-grid",
    "security/key-vault",
    "networking/index",
    "observability/monitor",
    "ai/openai",
    "local-development",
    "frontend/websites",
  ]) {
    row(
      "docs",
      `website/src/content/docs/azure/${page}.mdx`,
      exists(`website/src/content/docs/azure/${page}.mdx`),
      "",
    );
  }
  row(
    "docs",
    "llms.txt section",
    /heading: "Azure"/.test(read("website/scripts/generate-llms-txt.ts")),
    "website/scripts/generate-llms-txt.ts",
  );
  row(
    "docs",
    "JSDoc: runtimes to the AWS.Lambda.Function bar",
    false,
    "Functions.Function has 2 examples; Lambda has 21",
  );
  row(
    "docs",
    "JSDoc: fat-head resources to the S3/R2 Bucket bar",
    false,
    "StorageAccount has 3 examples; S3 Bucket has 15",
  );
  row("docs", "PR description: runtimes and fat head", false, "");
  return rows;
}

function renderIndex(): string {
  const skill = Bun.spawnSync(
    ["git", "log", "-1", "--format=%H", "--", ".agents/skills/alchemy-provider"],
    { cwd: repo },
  )
    .stdout.toString()
    .trim();
  const rows: Row[] = [];
  const implemented = new Set<string>();
  for (const r of report) {
    for (const t of r.resourceTypes) {
      if (t.status === "implemented") {
        for (const a of t.alchemyTypes) if (a.startsWith("Azure.")) implemented.add(a);
      } else {
        rows.push({
          kind: "resource",
          name: `${r.service}: ${t.armType}`,
          status: t.status,
          note: t.reason,
        });
      }
    }
  }
  for (const types of declaredTypes.values())
    for (const t of types) if (t.startsWith("Azure.")) implemented.add(t);
  rows.unshift(...[...implemented].sort().map(resourceRow));
  for (const r of report) {
    for (const o of r.bindingOps) {
      rows.push({
        kind: "binding",
        name: `${r.service}.${o.name}`,
        status: "missing",
        note: `ARM action ${o.method} …/${o.uri.split("/").pop()}`,
      });
    }
  }
  for (const o of dataPlane) {
    if (o.category !== "binding") continue;
    rows.push({
      kind: "binding",
      name: `${o.service}/${o.group}.${o.operationId}`,
      status: o.binding ? "implemented" : "missing",
      note: o.binding
        ? `${o.binding} (hand-written HTTP, host.bind allowlist, no host test)`
        : "data plane not in distilled",
    });
  }
  rows.push(...deliverableRows());
  const byStatus = count(rows, (r) => r.status.split(":")[0]!);
  const byKind = Object.entries(
    rows.reduce<Record<string, Record<string, number>>>((acc, r) => {
      const s = r.status.split(":")[0]!;
      (acc[r.kind] ??= {})[s] = (acc[r.kind]![s] ?? 0) + 1;
      return acc;
    }, {}),
  );
  const statuses = ["missing", "implemented", "tested", "blocked", "out-of-scope"];
  return [
    `Skill: ${skill}`,
    "",
    "# Azure provider index",
    "",
    "Generated by `bun scripts/audit-azure-service.ts --data-plane <specs> --write processes/Azure/catalog`.",
    "`implemented` resources have code; they become `tested` only after a passing live run.",
    "",
    `| Kind | ${statuses.join(" | ")} |`,
    `| --- | ${statuses.map(() => "---").join(" | ")} |`,
    ...byKind.map(([kind, s]) => `| ${kind} | ${statuses.map((x) => s[x] ?? 0).join(" | ")} |`),
    `| **total** | ${statuses.map((x) => byStatus[x] ?? 0).join(" | ")} |`,
    "",
    "| Kind | Row | Status | Note |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (r) => `| ${r.kind} | ${r.name} | ${r.status} | ${r.note.replaceAll("|", "\\|")} |`,
    ),
    "",
  ].join("\n");
}
