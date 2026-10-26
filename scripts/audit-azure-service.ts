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
  // Data-plane modules (`keyvault-secrets`, `storage-blob`, ...) address the
  // service's own host, never an ARM `/subscriptions/...` or `/providers/...` path.
  if (uri !== "?" && !uri.includes("/providers/") && !/^\/subscriptions(\/|$)/i.test(uri)) {
    return { category: "binding", reason: "data-plane operation" };
  }
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
/** alchemy files that implement a runtime binding layer (a `*Http` layer or an ARM action binding). */
const bindingFiles = new Set<string>();
for (const file of alchemyFiles) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(repo, file);
  if (/Http\.ts$/.test(file) || /make\w*Binding\(|Binding\.Service</.test(text)) {
    bindingFiles.add(rel);
  }
  const types = [
    ...[...text.matchAll(/=\s*(?:Grouped)?Resource<\w+>\(\s*"(Azure\.[\w.]+)"/g)].map((m) => m[1]!),
    // Runtimes: `Platform(FunctionTypeId, ...)` with `const FunctionTypeId = "Azure.…"`.
    ...[...text.matchAll(/Platform\((\w+TypeId)/g)].flatMap(
      (m) => text.match(new RegExp(`const ${m[1]}\\s*=\\s*"(Azure\\.[\\w.]+)"`))?.[1] ?? [],
    ),
  ];
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
  [/^Microsoft\.RecommendationsService\//i, "retired or closed to new customers (2026-03-31)"],
  [
    /^Microsoft\.DocumentDB\/databaseAccounts\/notebookWorkspaces$/i,
    "retired or closed to new customers (2024-03-30)",
  ],
  [
    /^Microsoft\.HardwareSecurityModules\/dedicatedHSMs$/i,
    "retired or closed to new customers (Dedicated HSM)",
  ],
  [
    /^Microsoft\.Web\/hostingEnvironments\/(multiRolePools|workerPools)$/i,
    "retired or closed to new customers (App Service Environment v1/v2)",
  ],
  [/^Microsoft\.Web\/kubeEnvironments$/i, "needs external systems (App Service on Azure Arc)"],
  [
    /^Microsoft\.DataMigration\/(databaseMigrations|services\/(serviceTasks|projects\/(tasks|files)))$/i,
    "action or run record, not desired state",
  ],
  [
    /^Microsoft\.ServiceBus\/namespaces\/migrationConfigurations$/i,
    "action or run record, not desired state",
  ],
  [/^Microsoft\.Mission\/approvals$/i, "action or run record, not desired state"],
  [/^Microsoft\.Monitor\/accounts\/issues$/i, "action or run record, not desired state"],
  [
    /^Microsoft\.DeviceRegistry\/namespaces\/discovered(Assets|Devices)$/i,
    "read-only mirror of discovered edge inventory (system-managed)",
  ],
  [
    /^Microsoft\.Workloads\/sapVirtualInstances\/(applicationInstances|centralInstances|databaseInstances)$/i,
    "system-managed child of the SAP Virtual Instance",
  ],
  [/^Microsoft\.Edge\/disconnectedOperations\/hardwareSettings$/i, "hardware order"],
  [
    /^Microsoft\.AzureSphere\/catalogs\/(products\/deviceGroups\/devices|images)$/i,
    "needs external hardware (Azure Sphere devices)",
  ],
  [
    /^Microsoft\.RecoveryServices\/vaults\/(replicationFabrics\/(replicationvCenters|replicationRecoveryServicesProviders|replicationProtectionContainers\/replicationMigrationItems)|replicationProtectionIntents)$/i,
    "needs external systems (on-premises vCenter / Hyper-V site recovery)",
  ],
  [/^Microsoft\.Resources\/tagNames(\/tagValues)?$/i, "duplicate of per-resource tags"],
  [/^Microsoft\.GraphServices\/accounts$/i, "billing, subscription, quota, or support object"],
  [/^Microsoft\.Solutions\/jitRequests$/i, "approval request (action), not desired state"],
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

// Several distilled modules carry the same ARM type (`resources` also models
// Microsoft.Solutions); a type implemented from one module is done everywhere.
const implementedArmTypes = new Map<string, string>();
for (const r of report)
  for (const t of r.resourceTypes)
    if (t.status === "implemented") implementedArmTypes.set(t.armType.toLowerCase(), r.service);
for (const r of report)
  for (const t of r.resourceTypes) {
    const owner = implementedArmTypes.get(t.armType.toLowerCase());
    if (t.status === "missing" && owner !== undefined && owner !== r.service) {
      t.status = "out-of-scope";
      t.reason = `duplicate of another resource (implemented from the \`${owner}\` module)`;
    }
  }

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

/** Generated data-plane modules (`src/services/<service>-<group>.ts`) outside binding scope. */
const DATA_PLANE_MODULE_OUT_OF_SCOPE: [RegExp, string][] = [
  [/^(datalake-analytics|datalake-store|timeseriesinsights)/, "retired service"],
  [/^machinelearningservices-/, "ML workspace run records (end-user data)"],
  [/^purview-/, "data-governance catalog content (end-user data)"],
  [/^marketplacecatalog/, "marketplace catalog (billing/marketplace)"],
  [/^servicefabric-/, "cluster management API of self-hosted Service Fabric"],
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

/**
 * Latest live result per Azure test file, from the alchemy-test run logs
 * (`.alchemy/log/test/*.log`, pruned after a week). A file is green when its
 * most recent run passed at least one case and failed none.
 */
// `var`: renderIndex runs from the `--write` block above this declaration.
var latestRunsCache: Map<string, { log: string; pass: number; fail: number }> | undefined;
function latestRuns() {
  return (latestRunsCache ??= readLatestRuns());
}
function readLatestRuns() {
  const dirs = [
    path.join(repo, "packages/integration-tests/.alchemy/log/test"),
    path.join(repo, ".alchemy/log/test"),
  ];
  const logs = dirs
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  const latest = new Map<string, { log: string; pass: number; fail: number }>();
  for (const log of logs) {
    const per = new Map<string, { pass: number; fail: number }>();
    for (const m of fs
      .readFileSync(log, "utf8")
      .matchAll(/^(PASS|FAIL) test\/Azure\/([^ ]+\.test\.ts) /gm)) {
      const r = per.get(m[2]!) ?? { pass: 0, fail: 0 };
      if (m[1] === "PASS") r.pass++;
      else r.fail++;
      per.set(m[2]!, r);
    }
    for (const [file, r] of per) latest.set(file, { log: path.basename(log), ...r });
  }
  return latest;
}

/**
 * Statuses the factory agents reported for each resource in their workflow
 * results (`<catalog>/agent-results.json`, extracted from the workflow
 * journals). Used only when the local test logs have no run of the file.
 */
var agentResultsCache: Record<string, string> | undefined;
function agentResults(): Record<string, string> {
  if (agentResultsCache) return agentResultsCache;
  const file = path.join(repo, "processes/Azure/catalog/agent-results.json");
  agentResultsCache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return agentResultsCache!;
}

/** The `//` comment block right above the first test gated on `gate`. */
function gateComment(text: string, gate: string): string | undefined {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(`skipIf(!${gate}`));
  if (at === -1) return undefined;
  const comment: string[] = [];
  let start = at - 1;
  while (start >= 0 && lines[start]!.trim() === "") start--;
  for (let i = start; i >= 0 && /^\s*\/\//.test(lines[i]!); i--) {
    comment.unshift(lines[i]!.replace(/^\s*\/\/\s?/, ""));
  }
  const joined = comment.join(" ").replace(/\s+/g, " ").trim();
  if (joined === "") return undefined;
  return joined.length > 240 ? `${joined.slice(0, 237)}...` : joined;
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
    const cost =
      gateComment(text, "runExpensive") ??
      text.match(/\/\/ [^\n]*(~\$[^\n]*|hour[^\n]*)/)?.[0]?.replace(/^\/\/ /, "") ??
      "AZURE_TEST_EXPENSIVE (no cost comment)";
    return { kind: "resource", name: alchemyType, status: "blocked: cost", note: cost };
  }
  if (ungated === 0 && /skipIf\(!runPaidOnly/.test(text)) {
    return {
      kind: "resource",
      name: alchemyType,
      status: "blocked: paid",
      note:
        gateComment(text, "runPaidOnly") ??
        "AZURE_TEST_PAID (partner SaaS, hardware, gated preview, or external system)",
    };
  }
  const run = latestRuns().get(`${service}/${name}.test.ts`);
  if (run && run.fail === 0 && run.pass > 0) {
    return {
      kind: "resource",
      name: alchemyType,
      status: "tested",
      note: `${run.pass} passed (${run.log})`,
    };
  }
  if (run === undefined && agentResults()[alchemyType] === "tested") {
    return {
      kind: "resource",
      name: alchemyType,
      status: "tested",
      note: "live pass reported by its factory agent (catalog/agent-results.json)",
    };
  }
  return {
    kind: "resource",
    name: alchemyType,
    status: "implemented",
    note: run
      ? `last run: ${run.fail} failed, ${run.pass} passed (${run.log})`
      : "ungated test file; no run in the local test logs",
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
  const distilled = (p: string) => path.join(repo, "submodules/distilled/packages/azure", p);
  const distilledText = (p: string) =>
    fs.existsSync(distilled(p)) ? fs.readFileSync(distilled(p), "utf8") : "";
  const dataPlaneModules = fs.readdirSync(distilledServices).filter((f) => f.includes("-"));
  row(
    "distilled",
    "data-plane modules from specification/*/data-plane",
    dataPlaneModules.length > 0,
    `${dataPlaneModules.length} modules in src/services`,
  );
  row(
    "distilled",
    "XML bodies, SAS, per-data-plane token audience in the protocol",
    distilledText("src/storage.ts") !== "" && /tokenFor/.test(distilledText("src/protocol.ts")),
    "src/storage.ts; protocol asks Credentials.tokenFor(audience)",
  );
  for (const [spec, label] of [
    ["servicebus-messaging", "Service Bus messaging REST (send/receive/peek-lock/complete)"],
    ["eventhubs-messaging", "Event Hubs send REST"],
    ["cosmos-nosql", "Cosmos DB NoSQL REST (documents, queries)"],
    ["kudu", "Kudu OneDeploy / zip deploy"],
    ["durabletask-data", "Durable Task Scheduler data plane"],
  ] as const) {
    row(
      "distilled",
      `manual spec: ${label}`,
      fs.existsSync(distilled(`manual-specs/${spec}.json`)),
      `manual-specs/${spec}.json`,
    );
  }
  row(
    "distilled",
    "managed-identity credentials provider (IMDS + IDENTITY_ENDPOINT)",
    /export const fromManagedIdentity\b/.test(distilledText("src/credentials.ts")),
    "fromManagedIdentity, fromWorkloadIdentity, fromClientSecret, fromEnv",
  );
  row(
    "distilled",
    "nextLink pagination (`.pages` / `.items`)",
    true,
    "ARM list ops are paginated; alchemy reads every page with `collectAll` (Arm.ts)",
  );
  row(
    "distilled",
    "typed errors",
    /AZURE_ERROR_CODE_MAP/.test(distilledText("src/errors.ts")),
    "ARM codes client-level (AZURE_ERROR_CODE_MAP); data-plane errors per operation via patches/<module>/",
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
  row(
    "bindings",
    "Azure hosts in other providers' ExternalHost suites",
    fs
      .readdirSync(path.join(repo, "packages/integration-tests/test"))
      .filter((d) => d !== "Azure")
      .some((d) => {
        const dir = path.join(repo, "packages/integration-tests/test", d, "ExternalHost");
        return walk(dir).some((f) => /@alchemy\.run\/azure/.test(fs.readFileSync(f, "utf8")));
      }),
    "an Azure Function/Container App calling another provider's bindings",
  );

  // Runtimes.
  const runtimes: [string, string, string][] = [
    [
      "Azure.Functions.Function",
      "packages/azure/src/Functions/Function.ts",
      "Functions/fixtures/{effect,async}-function.ts",
    ],
    [
      "Azure.Web.FunctionApp",
      "packages/azure/src/Web/FunctionApp.ts",
      "Web/fixtures/{effect,async}-function-app.ts",
    ],
    [
      "Azure.Web.WebApp",
      "packages/azure/src/Web/WebApp.ts",
      "Web/fixtures/{effect,async}-webapp.ts",
    ],
    [
      "Azure.ContainerApps.ContainerApp",
      "packages/azure/src/ContainerApps/ContainerApp.ts",
      "ContainerApps/fixtures/{effect,async}-app.ts",
    ],
    [
      "Azure.ContainerApps.Job",
      "packages/azure/src/ContainerApps/Job.ts",
      "ContainerApps/fixtures/{effect,async}-job.ts",
    ],
    [
      "Azure.ContainerInstance.ContainerGroup",
      "packages/azure/src/ContainerInstance/ContainerGroup.ts",
      "ContainerInstance/fixtures/{effect,async}-container.ts",
    ],
    [
      "Azure.Compute.VirtualMachine",
      "packages/azure/src/Compute/VirtualMachine.ts",
      "Compute/fixtures/{effect,async}-vm.ts",
    ],
  ];
  for (const [name, file, fixtures] of runtimes) {
    const text = fs.existsSync(path.join(repo, file))
      ? fs.readFileSync(path.join(repo, file), "utf8")
      : "";
    const examples = (text.match(/\*\*Example:\*\*/g) ?? []).length;
    row("runtime", `${name} effectful form`, /Platform\(/.test(text), "on Platform");
    row("runtime", `${name} async form`, /### Async/.test(text), `${examples} JSDoc examples`);
    const fixtureFiles = ["effect", "async"].map((form) =>
      path.join(alchemyTests, fixtures.replace("{effect,async}", form)),
    );
    row(
      "runtime",
      `${name} tests for both forms`,
      fixtureFiles.every((f) => fs.existsSync(f)),
      fixtureFiles.map((f) => path.relative(alchemyTests, f)).join(", "),
    );
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
  // Event sources on Container Apps (apps and jobs).
  for (const [file, layer] of [
    ["ContainerApps/AppEventSources.ts", "AppStorageQueueEventSource"],
    ["ContainerApps/AppEventSources.ts", "AppServiceBusQueueEventSource"],
    ["ContainerApps/AppEventSources.ts", "AppServiceBusSubscriptionEventSource"],
    ["ContainerApps/AppEventSources.ts", "appSchedule"],
    ["ContainerApps/JobEventSources.ts", "JobStorageQueueEventSource"],
    ["ContainerApps/JobEventSources.ts", "JobServiceBusQueueEventSource"],
    ["ContainerApps/JobEventSources.ts", "schedule"],
  ] as const) {
    row(
      "event-source",
      `Azure.ContainerApps.${layer}`,
      new RegExp(`export (const|function) ${layer}\\b`).test(
        fs.readFileSync(path.join(alchemySrc, file), "utf8"),
      ),
      file,
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
  const exampleCount = (file: string) =>
    (read(`packages/azure/src/${file}`).match(/\*\*Example:\*\*/g) ?? []).length;
  const thin = (files: string[], bar: number) =>
    files.filter((f) => exampleCount(f) < bar).map((f) => `${f} (${exampleCount(f)})`);
  const runtimeFiles = [
    "Functions/Function.ts",
    "Web/FunctionApp.ts",
    "Web/WebApp.ts",
    "ContainerApps/ContainerApp.ts",
    "ContainerApps/Job.ts",
    "ContainerInstance/ContainerGroup.ts",
    "Compute/VirtualMachine.ts",
  ];
  const fatHead = [
    "Storage/StorageAccount.ts",
    "Storage/BlobContainer.ts",
    "Storage/Queue.ts",
    "ServiceBus/Namespace.ts",
    "ServiceBus/Queue.ts",
    "EventHub/Namespace.ts",
    "EventHub/EventHub.ts",
    "Sql/Server.ts",
    "Sql/Database.ts",
    "CosmosDB/DatabaseAccount.ts",
    "KeyVault/Vault.ts",
    "Network/VirtualNetwork.ts",
  ];
  const thinRuntimes = thin(runtimeFiles, 10);
  row(
    "docs",
    "JSDoc: runtimes to the AWS.Lambda.Function bar (10+ examples)",
    thinRuntimes.length === 0,
    thinRuntimes.join(", ") || runtimeFiles.map((f) => `${f} (${exampleCount(f)})`).join(", "),
  );
  const thinFatHead = thin(fatHead, 5);
  row(
    "docs",
    "JSDoc: fat-head resources to the S3/R2 Bucket bar (5+ examples)",
    thinFatHead.length === 0,
    thinFatHead.join(", ") || fatHead.map((f) => `${f} (${exampleCount(f)})`).join(", "),
  );
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
      const dataPlaneOp = o.reason === "data-plane operation";
      const action = `${dataPlaneOp ? "data plane" : "ARM action"} ${o.method} ${o.uri}`;
      const layers = o.usedBy.filter((f) => bindingFiles.has(f));
      const scope = dataPlaneOp
        ? (DATA_PLANE_MODULE_OUT_OF_SCOPE.find(([re]) => re.test(r.service))?.[1] ??
          (/ServiceProperties|ServiceStats|GetAccountInfo|UserDelegationKey/i.test(o.name)
            ? "account-level settings, configured through the ARM resource"
            : undefined))
        : o.armType !== undefined
          ? OUT_OF_SCOPE.find(([re]) => re.test(o.armType!))?.[1]
          : undefined;
      rows.push({
        kind: "binding",
        name: `${r.service}.${o.name}`,
        status: layers.length > 0 ? "implemented" : scope ? "out-of-scope" : "missing",
        note:
          layers.length > 0
            ? `${action}; ${layers.map((f) => path.basename(f)).join(", ")}`
            : scope
              ? `${scope}; ${action}`
              : action,
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
