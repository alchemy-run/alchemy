import * as Render from "@alchemy.run/render";
import * as Layer from "effect/Layer";

export interface FakeRenderCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string[]>;
  readonly body: unknown;
}

export interface FaultRule {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly remaining?: number;
}

interface StoredOwner {
  id: string;
  name: string;
  email: string;
  type: "team" | "user";
}

interface StoredProject {
  id: string;
  name: string;
  owner: StoredOwner;
  environmentIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface StoredEnvironment {
  id: string;
  name: string;
  projectId: string;
  protectedStatus: string;
  networkIsolationEnabled: boolean;
  ipAllowList?: Array<{ cidrBlock: string; description: string }>;
}

interface StoredRegistryCredential {
  id: string;
  ownerId: string;
  name: string;
  registry: string;
  username: string;
  authToken: string;
  updatedAt: string;
}

interface StoredEnvGroup {
  id: string;
  name: string;
  ownerId: string;
  environmentId?: string;
  envVars: Array<{ key: string; value: string }>;
  secretFiles: Array<{ name: string; content: string }>;
  serviceIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface StoredDisk {
  id: string;
  serviceId: string;
  name: string;
  mountPath: string;
  sizeGB: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredService {
  id: string;
  name: string;
  slug: string;
  type: string;
  ownerId: string;
  environmentId?: string;
  repo?: string;
  branch?: string;
  rootDir?: string;
  imagePath?: string;
  autoDeploy: "yes" | "no";
  autoDeployTrigger?: string;
  buildFilter?: { paths: string[]; ignoredPaths: string[] };
  registryCredential?: { id: string; name: string };
  dashboardUrl: string;
  suspended: string;
  suspenders: string[];
  serviceDetails: Record<string, unknown>;
  envVars: Array<{ key: string; value: string }>;
  secretFiles: Array<{ name: string; content: string }>;
  customDomains: Array<{
    id: string;
    name: string;
    domainType: string;
    publicSuffix: string;
    redirectForName: string;
    verificationStatus: string;
    createdAt: string;
  }>;
  headers: Array<{ id: string; path: string; name: string; value: string }>;
  routes: Array<{
    id: string;
    source: string;
    destination: string;
    type: string;
    priority: number;
  }>;
  deploys: Array<{
    id: string;
    status: string;
    trigger: string;
    createdAt: string;
    updatedAt: string;
  }>;
  notificationOverride: {
    serviceId: string;
    notificationsToSend: string;
    previewNotificationsEnabled: string;
  };
  pollCount: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredPostgres {
  id: string;
  name: string;
  owner: StoredOwner;
  plan: string;
  region: string;
  version: string;
  databaseName: string;
  databaseUser: string;
  diskSizeGB?: number;
  diskAutoscalingEnabled: boolean;
  highAvailabilityEnabled: boolean;
  environmentId?: string;
  ipAllowList: Array<{ cidrBlock: string; description: string }>;
  readReplicas: Array<{
    id: string;
    name: string;
    parameterOverrides?: Record<string, string>;
  }>;
  parameterOverrides?: Record<string, string>;
  connectionPool: string;
  primaryPostgresID?: string;
  role: string;
  status: string;
  suspended: string;
  suspenders: string[];
  dashboardUrl: string;
  createdAt: string;
  updatedAt: string;
  pollCount: number;
}

interface StoredKeyValue {
  id: string;
  name: string;
  owner: StoredOwner;
  plan: string;
  region: string;
  version: string;
  environmentId?: string;
  ipAllowList: Array<{ cidrBlock: string; description: string }>;
  options: { maxmemoryPolicy?: string; persistenceMode?: string };
  status: string;
  dashboardUrl: string;
  createdAt: string;
  updatedAt: string;
  pollCount: number;
}

interface StoredWebhook {
  id: string;
  ownerId: string;
  name: string;
  url: string;
  enabled: boolean;
  eventFilter: string[];
  secret: string;
}

interface StoredDedicatedIp {
  id: string;
  name: string;
  ownerId: string;
  region: string;
  description: string;
  environmentIds: string[];
  ips: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  pollCount: number;
}

interface StoredWorkflow {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  environmentId?: string;
  region: string;
  runtime: string;
  repo: string;
  branch?: string;
  rootDir?: string;
  buildCommand?: string;
  runCommand: string;
  autoDeployTrigger?: string;
  defaultVersionId?: string;
  envVars: Array<{ key: string; value: string }>;
  createdAt: string;
  updatedAt: string;
}

interface StoredWorkflowVersion {
  id: string;
  workflowId: string;
  name?: string;
  status: string;
  pollCount: number;
  createdAt: string;
  updatedAt: string;
}

interface StoredTaskRun {
  id: string;
  task: string;
  status: string;
  input?: unknown;
  results?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredBlueprint {
  id: string;
  name: string;
  ownerId: string;
  repo: string;
  branch: string;
  path: string;
  status: string;
  autoSync: boolean;
  lastSync?: string;
  resources: Array<{ id: string; name: string; type: string }>;
  syncs: Array<{
    id: string;
    state: string;
    commit?: { id?: string; message?: string; url?: string };
    startedAt?: string;
    completedAt?: string;
  }>;
}

interface StoredPostgresExport {
  id: string;
  url?: string;
  createdAt?: string;
}

interface StoredLogEntry {
  id: string;
  ownerId: string;
  resourceId?: string;
  timestamp: string;
  message: string;
  labels?: Array<{ name: string; value?: string }>;
}

const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: {
      ...(data !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  });

const notFound = (message = "Not found") => json({ message }, 404);

const paginate = <T>(
  items: T[],
  cursorParam: string | null,
  limitParam: string | null,
  maxPageSize: number,
  wrap: (cursor: string, item: T) => unknown,
) => {
  const requestedLimit = limitParam ? Number(limitParam) : maxPageSize;
  const pageSize = Math.max(1, Math.min(requestedLimit, maxPageSize));
  const start = cursorParam ? Number(cursorParam) : 0;
  const slice = items.slice(start, start + pageSize);
  return slice.map((item, idx) => wrap(String(start + idx + 1), item));
};

export interface FakeRenderServerOptions {
  readonly apiKey?: string;
  readonly owners?: StoredOwner[];
  readonly maxPageSize?: number;
  readonly postgresReadyAfterPolls?: number;
  readonly dedicatedIpReadyAfterPolls?: number;
  readonly dedicatedIpTerminalStatus?: string;
  readonly deployReadyAfterPolls?: number;
  readonly deployTerminalStatus?: string;
  readonly workflowVersionReadyAfterPolls?: number;
  readonly customDomainInitialVerificationStatus?: string;
}

export class FakeRenderServer {
  readonly apiKey: string;
  owners: StoredOwner[];
  maxPageSize: number;
  postgresReadyAfterPolls: number;
  dedicatedIpReadyAfterPolls: number;
  dedicatedIpTerminalStatus?: string;
  deployReadyAfterPolls: number;
  deployTerminalStatus?: string;
  workflowVersionReadyAfterPolls: number;
  customDomainInitialVerificationStatus: string;

  readonly calls: FakeRenderCall[] = [];
  readonly faults: FaultRule[] = [];

  private seq = 1;
  private projects = new Map<string, StoredProject>();
  private environments = new Map<string, StoredEnvironment>();
  private registryCredentials = new Map<string, StoredRegistryCredential>();
  private envGroups = new Map<string, StoredEnvGroup>();
  private services = new Map<string, StoredService>();
  private disks = new Map<string, StoredDisk>();
  private postgres = new Map<string, StoredPostgres>();
  private keyValues = new Map<string, StoredKeyValue>();
  private redis = new Map<string, StoredKeyValue>();
  private webhooks = new Map<string, StoredWebhook>();
  private dedicatedIps = new Map<string, StoredDedicatedIp>();
  private ownerLogStreams = new Map<
    string,
    { ownerId: string; endpoint: string; preview: string }
  >();
  private resourceLogStreams = new Map<
    string,
    { resourceId: string; setting: string; endpoint?: string }
  >();
  private metricsStreams = new Map<string, { ownerId: string; provider: string; url: string }>();
  private notificationSettings = new Map<
    string,
    {
      ownerId: string;
      emailEnabled: boolean;
      slackEnabled: boolean;
      notificationsToSend: string;
      previewNotificationsEnabled: boolean;
    }
  >();
  private workflows = new Map<string, StoredWorkflow>();
  private workflowVersions = new Map<string, StoredWorkflowVersion>();
  private taskRuns = new Map<string, StoredTaskRun>();
  private blueprints = new Map<string, StoredBlueprint>();
  private postgresExports = new Map<string, StoredPostgresExport[]>();
  private logs: StoredLogEntry[] = [];

  readonly server: ReturnType<typeof Bun.serve>;
  readonly baseUrl: string;

  constructor(options: FakeRenderServerOptions = {}) {
    this.apiKey = options.apiKey ?? "rnd_local_test_key";
    this.owners = options.owners ?? [
      {
        id: "tea-alchemy-test",
        name: "Alchemy Test Team",
        email: "ops@alchemy.test",
        type: "team",
      },
    ];
    this.maxPageSize = options.maxPageSize ?? 100;
    this.postgresReadyAfterPolls = options.postgresReadyAfterPolls ?? 1;
    this.dedicatedIpReadyAfterPolls = options.dedicatedIpReadyAfterPolls ?? 1;
    this.dedicatedIpTerminalStatus = options.dedicatedIpTerminalStatus;
    this.deployReadyAfterPolls = options.deployReadyAfterPolls ?? 1;
    this.deployTerminalStatus = options.deployTerminalStatus;
    this.workflowVersionReadyAfterPolls = options.workflowVersionReadyAfterPolls ?? 1;
    this.customDomainInitialVerificationStatus =
      options.customDomainInitialVerificationStatus ?? "verified";

    this.server = Bun.serve({
      port: 0,
      fetch: (req) => this.handle(req),
    });
    this.baseUrl = `${this.server.url.origin}/v1`;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${String(this.seq++).padStart(4, "0")}`;
  }

  private now(): string {
    return "2026-01-01T00:00:00.000Z";
  }

  clearCalls() {
    this.calls.length = 0;
  }

  pushFault(rule: FaultRule) {
    this.faults.push({ ...rule });
  }

  deleteOutOfBand(
    kind:
      | "project"
      | "environment"
      | "service"
      | "postgres"
      | "keyvalue"
      | "redis"
      | "webhook"
      | "dedicatedIp"
      | "envGroup"
      | "registryCredential"
      | "workflow"
      | "blueprint",
    id: string,
  ) {
    switch (kind) {
      case "project": {
        const proj = this.projects.get(id);
        if (proj) {
          for (const eid of proj.environmentIds) this.environments.delete(eid);
        }
        this.projects.delete(id);
        break;
      }
      case "environment":
        this.environments.delete(id);
        break;
      case "service":
        this.services.delete(id);
        break;
      case "postgres":
        this.postgres.delete(id);
        break;
      case "keyvalue":
        this.keyValues.delete(id);
        break;
      case "redis":
        this.redis.delete(id);
        break;
      case "webhook":
        this.webhooks.delete(id);
        break;
      case "dedicatedIp":
        this.dedicatedIps.delete(id);
        break;
      case "envGroup":
        this.envGroups.delete(id);
        break;
      case "registryCredential":
        this.registryCredentials.delete(id);
        break;
      case "workflow":
        this.workflows.delete(id);
        break;
      case "blueprint":
        this.blueprints.delete(id);
        break;
    }
  }

  seedBlueprint(input: {
    id?: string;
    name: string;
    ownerId?: string;
    repo?: string;
    branch?: string;
    path?: string;
    status?: string;
    autoSync?: boolean;
    resources?: Array<{ id: string; name: string; type: string }>;
    syncs?: StoredBlueprint["syncs"];
  }): string {
    const id = input.id ?? this.nextId("exs");
    this.blueprints.set(id, {
      id,
      name: input.name,
      ownerId: input.ownerId ?? this.owners[0]?.id ?? "tea-alchemy-test",
      repo: input.repo ?? "https://github.com/alchemy/blueprint-example",
      branch: input.branch ?? "main",
      path: input.path ?? "render.yaml",
      status: input.status ?? "synced",
      autoSync: input.autoSync ?? true,
      lastSync: this.now(),
      resources: input.resources ?? [],
      syncs: input.syncs ?? [
        {
          id: this.nextId("syc"),
          state: "succeeded",
          commit: { id: "abc1234", message: "Initial sync" },
          startedAt: this.now(),
          completedAt: this.now(),
        },
      ],
    });
    return id;
  }

  appendLog(entry: {
    ownerId?: string;
    resourceId?: string;
    timestamp?: string;
    message: string;
    labels?: Array<{ name: string; value?: string }>;
  }) {
    this.logs.push({
      id: this.nextId("log"),
      ownerId: entry.ownerId ?? this.owners[0]?.id ?? "tea-alchemy-test",
      resourceId: entry.resourceId,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      message: entry.message,
      labels: entry.labels,
    });
  }

  parityCounts() {
    return {
      workflows: this.workflows.size,
      workflowVersions: this.workflowVersions.size,
      taskRuns: this.taskRuns.size,
      blueprints: this.blueprints.size,
      postgresExports: [...this.postgresExports.values()].reduce((acc, l) => acc + l.length, 0),
      logs: this.logs.length,
    };
  }

  seedService(input: {
    id?: string;
    name: string;
    type?: string;
    ownerId?: string;
    plan?: string;
    region?: string;
  }): string {
    const id = input.id ?? this.nextId("srv");
    const now = this.now();
    this.services.set(id, {
      id,
      name: input.name,
      slug: input.name,
      type: input.type ?? "web_service",
      ownerId: input.ownerId ?? this.owners[0]?.id ?? "tea-alchemy-test",
      autoDeploy: "yes",
      dashboardUrl: `https://dashboard.render.com/web/${id}`,
      suspended: "not_suspended",
      suspenders: [],
      serviceDetails: {
        plan: input.plan ?? "starter",
        region: input.region ?? "oregon",
        runtime: "node",
        buildPlan: "starter",
        numInstances: 1,
        url: `https://${input.name}.onrender.com`,
        openPorts: [{ port: 10000, protocol: "TCP" }],
        envSpecificDetails: { buildCommand: "pnpm build", startCommand: "pnpm start" },
      },
      envVars: [],
      secretFiles: [],
      customDomains: [],
      headers: [],
      routes: [],
      deploys: [
        { id: this.nextId("dep"), status: "live", trigger: "api", createdAt: now, updatedAt: now },
      ],
      notificationOverride: {
        serviceId: id,
        notificationsToSend: "default",
        previewNotificationsEnabled: "default",
      },
      pollCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  snapshotCounts() {
    return {
      projects: this.projects.size,
      environments: this.environments.size,
      registryCredentials: this.registryCredentials.size,
      envGroups: this.envGroups.size,
      services: this.services.size,
      disks: this.disks.size,
      postgres: this.postgres.size,
      keyValues: this.keyValues.size,
      redis: this.redis.size,
      webhooks: this.webhooks.size,
      dedicatedIps: this.dedicatedIps.size,
      ownerLogStreams: this.ownerLogStreams.size,
      resourceLogStreams: this.resourceLogStreams.size,
      metricsStreams: this.metricsStreams.size,
    };
  }

  providersLayer(options?: {
    readonly ownerId?: string;
    readonly pollIntervalMs?: number;
    readonly pollMaxAttempts?: number;
  }) {
    const base = Render.providers();
    const creds = Render.fromConfig({
      apiKey: this.apiKey,
      ownerId: options?.ownerId,
      apiBaseUrl: this.baseUrl,
    });
    const poll = Layer.succeed(Render.RenderPollConfig, {
      intervalMs: options?.pollIntervalMs ?? 5,
      maxAttempts: options?.pollMaxAttempts ?? 15,
    });
    return Layer.mergeAll(creds, poll).pipe(Layer.provideMerge(base));
  }

  stop() {
    this.server.stop(true);
  }

  private envVarsFromInput(
    inputs: Array<{ key: string; value?: string; generateValue?: boolean }> | undefined,
  ): Array<{ key: string; value: string }> {
    if (!inputs) return [];
    return inputs.map((item) => ({
      key: item.key,
      value: item.generateValue ? `generated-${item.key}-${this.seq++}` : (item.value ?? ""),
    }));
  }

  private setEnvironmentForResource(resourceId: string, envId: string | undefined) {
    const svc = this.services.get(resourceId);
    if (svc) svc.environmentId = envId;
    const pg = this.postgres.get(resourceId);
    if (pg) pg.environmentId = envId;
    const kv = this.keyValues.get(resourceId);
    if (kv) kv.environmentId = envId;
    const rd = this.redis.get(resourceId);
    if (rd) rd.environmentId = envId;
    const eg = this.envGroups.get(resourceId);
    if (eg) eg.environmentId = envId;
    const wf = this.workflows.get(resourceId);
    if (wf) wf.environmentId = envId;
  }

  private environmentView(env: StoredEnvironment) {
    const serviceIds: string[] = [];
    for (const s of this.services.values()) if (s.environmentId === env.id) serviceIds.push(s.id);
    const databasesIds: string[] = [];
    for (const p of this.postgres.values()) if (p.environmentId === env.id) databasesIds.push(p.id);
    const redisIds: string[] = [];
    for (const k of this.keyValues.values()) if (k.environmentId === env.id) redisIds.push(k.id);
    for (const r of this.redis.values()) if (r.environmentId === env.id) redisIds.push(r.id);
    const envGroupIds: string[] = [];
    for (const e of this.envGroups.values()) if (e.environmentId === env.id) envGroupIds.push(e.id);
    return {
      ...env,
      serviceIds,
      databasesIds,
      redisIds,
      envGroupIds,
    };
  }

  private envGroupView(group: StoredEnvGroup) {
    const serviceLinks = group.serviceIds
      .map((sid) => this.services.get(sid))
      .filter((s): s is StoredService => s !== undefined)
      .map((s) => ({ id: s.id, name: s.name, type: s.type }));
    return {
      id: group.id,
      name: group.name,
      ownerId: group.ownerId,
      ...(group.environmentId ? { environmentId: group.environmentId } : {}),
      envVars: group.envVars,
      secretFiles: group.secretFiles,
      serviceLinks,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  private serviceView(s: StoredService) {
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      type: s.type,
      ownerId: s.ownerId,
      ...(s.environmentId ? { environmentId: s.environmentId } : {}),
      ...(s.repo !== undefined ? { repo: s.repo } : {}),
      ...(s.branch !== undefined ? { branch: s.branch } : {}),
      ...(s.rootDir !== undefined ? { rootDir: s.rootDir } : {}),
      ...(s.imagePath !== undefined ? { imagePath: s.imagePath } : {}),
      autoDeploy: s.autoDeploy,
      ...(s.autoDeployTrigger !== undefined ? { autoDeployTrigger: s.autoDeployTrigger } : {}),
      ...(s.buildFilter !== undefined ? { buildFilter: s.buildFilter } : {}),
      ...(s.registryCredential !== undefined ? { registryCredential: s.registryCredential } : {}),
      dashboardUrl: s.dashboardUrl,
      suspended: s.suspended,
      suspenders: s.suspenders,
      serviceDetails: s.serviceDetails,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  private workflowView(w: StoredWorkflow) {
    return {
      id: w.id,
      name: w.name,
      slug: w.slug,
      ownerId: w.ownerId,
      ...(w.environmentId ? { environmentId: w.environmentId } : {}),
      region: w.region,
      runtime: w.runtime,
      repo: w.repo,
      ...(w.branch !== undefined ? { branch: w.branch } : {}),
      ...(w.rootDir !== undefined ? { rootDir: w.rootDir } : {}),
      ...(w.buildCommand !== undefined ? { buildCommand: w.buildCommand } : {}),
      runCommand: w.runCommand,
      buildConfig: {
        runtime: w.runtime,
        repo: w.repo,
        ...(w.branch !== undefined ? { branch: w.branch } : {}),
        ...(w.rootDir !== undefined ? { rootDir: w.rootDir } : {}),
        ...(w.buildCommand !== undefined ? { buildCommand: w.buildCommand } : {}),
      },
      ...(w.autoDeployTrigger !== undefined ? { autoDeployTrigger: w.autoDeployTrigger } : {}),
      ...(w.defaultVersionId !== undefined ? { defaultVersionId: w.defaultVersionId } : {}),
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/v1/, "") || "/";
    const method = req.method.toUpperCase();

    const query: Record<string, string[]> = {};
    for (const [k, v] of url.searchParams.entries()) {
      (query[k] ??= []).push(v);
    }

    let body: unknown;
    let formData: FormData | undefined;
    if (method !== "GET" && method !== "DELETE" && method !== "HEAD") {
      const contentType = req.headers.get("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        formData = await req.formData();
        const entries: Record<string, unknown> = {};
        for (const [k, v] of formData.entries()) {
          const raw: unknown = v;
          entries[k] =
            typeof raw === "string" ? raw : raw instanceof Blob ? await raw.text() : String(raw);
        }
        body = entries;
      } else {
        const text = await req.text();
        if (text.trim().length > 0) {
          body = JSON.parse(text);
        }
      }
    }

    this.calls.push({ method, path, query, body });

    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${this.apiKey}`) {
      return json({ message: "Invalid API key" }, 401);
    }

    // Match fault injections before routing
    for (let i = 0; i < this.faults.length; i++) {
      const f = this.faults[i];
      if (f.method === method && f.path === path) {
        if (f.remaining !== undefined) {
          if (f.remaining <= 0) continue;
          const nextCount = f.remaining - 1;
          this.faults[i] = { ...f, remaining: nextCount };
        }
        return json(f.body ?? { message: `Injected ${f.status}` }, f.status, f.headers);
      }
    }

    const cursor = url.searchParams.get("cursor");
    const limit = url.searchParams.get("limit");
    const segs = path.split("/").filter(Boolean).map(decodeURIComponent);

    // /owners
    if (method === "GET" && segs.length === 1 && segs[0] === "owners") {
      return json(
        paginate(this.owners, cursor, limit, this.maxPageSize, (c, owner) => ({
          cursor: c,
          owner,
        })),
      );
    }

    // /projects
    if (segs[0] === "projects") {
      if (segs.length === 1 && method === "GET") {
        const ownerFilter = query.ownerId;
        const items = [...this.projects.values()].filter(
          (p) => !ownerFilter || ownerFilter.includes(p.owner.id),
        );
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, project) => ({
            cursor: c,
            project,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as {
          name: string;
          ownerId: string;
          environments?: Array<Record<string, unknown>>;
        };
        const owner = this.owners.find((o) => o.id === b.ownerId) ?? this.owners[0];
        const id = this.nextId("prj");
        const envIds: string[] = [];
        for (const envIn of b.environments ?? [{ name: "production" }]) {
          const eid = this.nextId("env");
          this.environments.set(eid, {
            id: eid,
            name: String(envIn.name),
            projectId: id,
            protectedStatus: String(envIn.protectedStatus ?? "unprotected"),
            networkIsolationEnabled: Boolean(envIn.networkIsolationEnabled ?? false),
            ipAllowList: envIn.ipAllowList as
              | Array<{ cidrBlock: string; description: string }>
              | undefined,
          });
          envIds.push(eid);
        }
        const now = this.now();
        const proj: StoredProject = {
          id,
          name: b.name,
          owner,
          environmentIds: envIds,
          createdAt: now,
          updatedAt: now,
        };
        this.projects.set(id, proj);
        return json(proj, 201);
      }
      if (segs.length === 2) {
        const proj = this.projects.get(segs[1]);
        if (!proj) return notFound("Project not found");
        if (method === "GET") return json(proj);
        if (method === "PATCH") {
          const b = body as { name?: string };
          if (b.name !== undefined) proj.name = b.name;
          return json(proj);
        }
        if (method === "DELETE") {
          for (const eid of proj.environmentIds) this.environments.delete(eid);
          this.projects.delete(segs[1]);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /environments
    if (segs[0] === "environments") {
      if (segs.length === 1 && method === "GET") {
        const projectFilter = query.projectId;
        const items = [...this.environments.values()]
          .filter((e) => !projectFilter || projectFilter.includes(e.projectId))
          .map((e) => this.environmentView(e));
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, environment) => ({
            cursor: c,
            environment,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as {
          projectId: string;
          name: string;
          protectedStatus?: string;
          networkIsolationEnabled?: boolean;
          ipAllowList?: Array<{ cidrBlock: string; description: string }>;
        };
        const id = this.nextId("env");
        const env: StoredEnvironment = {
          id,
          projectId: b.projectId,
          name: b.name,
          protectedStatus: b.protectedStatus ?? "unprotected",
          networkIsolationEnabled: b.networkIsolationEnabled ?? false,
          ipAllowList: b.ipAllowList,
        };
        this.environments.set(id, env);
        const proj = this.projects.get(b.projectId);
        if (proj && !proj.environmentIds.includes(id)) proj.environmentIds.push(id);
        return json(this.environmentView(env), 201);
      }
      if (segs.length === 2) {
        const env = this.environments.get(segs[1]);
        if (!env) return notFound("Environment not found");
        if (method === "GET") return json(this.environmentView(env));
        if (method === "PATCH") {
          const b = body as Partial<StoredEnvironment>;
          if (b.name !== undefined) env.name = b.name;
          if (b.protectedStatus !== undefined) env.protectedStatus = b.protectedStatus;
          if (b.networkIsolationEnabled !== undefined)
            env.networkIsolationEnabled = b.networkIsolationEnabled;
          if (b.ipAllowList !== undefined) env.ipAllowList = b.ipAllowList;
          return json(this.environmentView(env));
        }
        if (method === "DELETE") {
          const proj = this.projects.get(env.projectId);
          if (proj) proj.environmentIds = proj.environmentIds.filter((eid) => eid !== env.id);
          this.environments.delete(env.id);
          return new Response(null, { status: 204 });
        }
      }
      if (segs.length === 3 && segs[2] === "resources") {
        const env = this.environments.get(segs[1]);
        if (!env) return notFound("Environment not found");
        if (method === "POST") {
          const b = body as { resourceIds: string[] };
          for (const rid of b.resourceIds ?? []) this.setEnvironmentForResource(rid, env.id);
          return json(this.environmentView(env), 200);
        }
        if (method === "DELETE") {
          for (const rid of query.resourceIds ?? []) this.setEnvironmentForResource(rid, undefined);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /registrycredentials
    if (segs[0] === "registrycredentials") {
      if (segs.length === 1 && method === "GET") {
        const ownerFilter = query.ownerId;
        const items = [...this.registryCredentials.values()]
          .filter((c) => !ownerFilter || ownerFilter.includes(c.ownerId))
          .map(({ id, name, registry, username, updatedAt }) => ({
            id,
            name,
            registry,
            username,
            updatedAt,
          }));
        return json(items);
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as {
          name: string;
          ownerId: string;
          registry: string;
          username: string;
          authToken: string;
        };
        const id = this.nextId("rgc");
        const cred: StoredRegistryCredential = {
          id,
          ownerId: b.ownerId,
          name: b.name,
          registry: b.registry,
          username: b.username,
          authToken: b.authToken,
          updatedAt: this.now(),
        };
        this.registryCredentials.set(id, cred);
        // Render returns HTTP 200 for POST /registrycredentials!
        return json(
          {
            id,
            name: cred.name,
            registry: cred.registry,
            username: cred.username,
            updatedAt: cred.updatedAt,
          },
          200,
        );
      }
      if (segs.length === 2) {
        const cred = this.registryCredentials.get(segs[1]);
        if (!cred) return notFound("Registry credential not found");
        if (method === "GET") {
          return json({
            id: cred.id,
            name: cred.name,
            registry: cred.registry,
            username: cred.username,
            updatedAt: cred.updatedAt,
          });
        }
        if (method === "PATCH") {
          const b = body as Partial<StoredRegistryCredential>;
          if (b.name !== undefined) cred.name = b.name;
          if (b.registry !== undefined) cred.registry = b.registry;
          if (b.username !== undefined) cred.username = b.username;
          if (b.authToken !== undefined) cred.authToken = b.authToken;
          return json({
            id: cred.id,
            name: cred.name,
            registry: cred.registry,
            username: cred.username,
            updatedAt: cred.updatedAt,
          });
        }
        if (method === "DELETE") {
          this.registryCredentials.delete(cred.id);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /env-groups
    if (segs[0] === "env-groups") {
      if (segs.length === 1 && method === "GET") {
        const ownerFilter = query.ownerId;
        const items = [...this.envGroups.values()]
          .filter((g) => !ownerFilter || ownerFilter.includes(g.ownerId))
          .map((g) => {
            const v = this.envGroupView(g);
            return {
              id: v.id,
              name: v.name,
              ownerId: v.ownerId,
              environmentId: v.environmentId,
              serviceLinks: v.serviceLinks,
              createdAt: v.createdAt,
              updatedAt: v.updatedAt,
            };
          });
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, envGroup) => ({
            cursor: c,
            envGroup,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as {
          name: string;
          ownerId: string;
          environmentId?: string;
          envVars?: Array<{ key: string; value?: string; generateValue?: boolean }>;
          secretFiles?: Array<{ name: string; content: string }>;
          serviceIds?: string[];
        };
        const id = this.nextId("evg");
        const now = this.now();
        const group: StoredEnvGroup = {
          id,
          name: b.name,
          ownerId: b.ownerId,
          environmentId: b.environmentId,
          envVars: this.envVarsFromInput(b.envVars),
          secretFiles: b.secretFiles ?? [],
          serviceIds: b.serviceIds ?? [],
          createdAt: now,
          updatedAt: now,
        };
        this.envGroups.set(id, group);
        return json(this.envGroupView(group), 201);
      }
      if (segs.length === 2) {
        const group = this.envGroups.get(segs[1]);
        if (!group) return notFound("EnvGroup not found");
        if (method === "GET") return json(this.envGroupView(group));
        if (method === "PATCH") {
          const b = body as { name?: string };
          if (b.name !== undefined) group.name = b.name;
          return json(this.envGroupView(group));
        }
        if (method === "DELETE") {
          this.envGroups.delete(group.id);
          return new Response(null, { status: 204 });
        }
      }
      if (segs.length === 4 && segs[2] === "env-vars") {
        const group = this.envGroups.get(segs[1]);
        if (!group) return notFound("EnvGroup not found");
        const key = segs[3];
        if (method === "PUT") {
          const b = body as { value?: string; generateValue?: boolean };
          const val = b.generateValue ? `generated-${key}-${this.seq++}` : (b.value ?? "");
          const idx = group.envVars.findIndex((e) => e.key === key);
          if (idx >= 0) group.envVars[idx] = { key, value: val };
          else group.envVars.push({ key, value: val });
          return json(this.envGroupView(group));
        }
        if (method === "DELETE") {
          group.envVars = group.envVars.filter((e) => e.key !== key);
          return new Response(null, { status: 204 });
        }
      }
      if (segs.length === 4 && segs[2] === "secret-files") {
        const group = this.envGroups.get(segs[1]);
        if (!group) return notFound("EnvGroup not found");
        const name = segs[3];
        if (method === "PUT") {
          const b = body as { content: string };
          const idx = group.secretFiles.findIndex((f) => f.name === name);
          if (idx >= 0) group.secretFiles[idx] = { name, content: b.content };
          else group.secretFiles.push({ name, content: b.content });
          return json(this.envGroupView(group));
        }
        if (method === "DELETE") {
          group.secretFiles = group.secretFiles.filter((f) => f.name !== name);
          return new Response(null, { status: 204 });
        }
      }
      if (segs.length === 4 && segs[2] === "services") {
        const group = this.envGroups.get(segs[1]);
        if (!group) return notFound("EnvGroup not found");
        const serviceId = segs[3];
        if (method === "POST") {
          if (!group.serviceIds.includes(serviceId)) group.serviceIds.push(serviceId);
          return json(this.envGroupView(group), 200);
        }
        if (method === "DELETE") {
          group.serviceIds = group.serviceIds.filter((s) => s !== serviceId);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /disks
    if (segs[0] === "disks") {
      if (segs.length === 1 && method === "GET") {
        const ownerFilter = query.ownerId;
        const items = [...this.disks.values()].filter((d) => {
          if (!ownerFilter) return true;
          const svc = this.services.get(d.serviceId);
          return svc !== undefined && ownerFilter.includes(svc.ownerId);
        });
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, disk) => ({
            cursor: c,
            disk,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as { name: string; mountPath: string; sizeGB: number; serviceId: string };
        const svc = this.services.get(b.serviceId);
        if (!svc) return notFound("Service not found for disk");
        const id = this.nextId("dsk");
        const now = this.now();
        const disk: StoredDisk = {
          id,
          serviceId: b.serviceId,
          name: b.name,
          mountPath: b.mountPath,
          sizeGB: b.sizeGB,
          createdAt: now,
          updatedAt: now,
        };
        this.disks.set(id, disk);
        svc.serviceDetails.disk = { id, name: b.name, mountPath: b.mountPath, sizeGB: b.sizeGB };
        return json(disk, 201);
      }
      if (segs.length === 2) {
        const disk = this.disks.get(segs[1]);
        if (!disk) return notFound("Disk not found");
        if (method === "PATCH") {
          const b = body as Partial<StoredDisk>;
          if (b.name !== undefined) disk.name = b.name;
          if (b.mountPath !== undefined) disk.mountPath = b.mountPath;
          if (b.sizeGB !== undefined) disk.sizeGB = b.sizeGB;
          const svc = this.services.get(disk.serviceId);
          if (svc)
            svc.serviceDetails.disk = {
              id: disk.id,
              name: disk.name,
              mountPath: disk.mountPath,
              sizeGB: disk.sizeGB,
            };
          return json(disk);
        }
        if (method === "DELETE") {
          const svc = this.services.get(disk.serviceId);
          if (svc) delete svc.serviceDetails.disk;
          this.disks.delete(disk.id);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /services
    if (segs[0] === "services") {
      if (segs.length === 1 && method === "GET") {
        const items = [...this.services.values()].filter((s) => {
          if (query.ownerId && !query.ownerId.includes(s.ownerId)) return false;
          if (query.name && !query.name.includes(s.name)) return false;
          if (query.type && !query.type.includes(s.type)) return false;
          return true;
        });
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, s) => ({
            cursor: c,
            service: this.serviceView(s),
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as Record<string, unknown>;
        const id = this.nextId("srv");
        const now = this.now();
        const details = { ...(b.serviceDetails as Record<string, unknown>) };
        if (details.disk && typeof details.disk === "object") {
          const dIn = details.disk as { name: string; mountPath: string; sizeGB?: number };
          const dId = this.nextId("dsk");
          const diskObj: StoredDisk = {
            id: dId,
            serviceId: id,
            name: dIn.name,
            mountPath: dIn.mountPath,
            sizeGB: dIn.sizeGB ?? 1,
            createdAt: now,
            updatedAt: now,
          };
          this.disks.set(dId, diskObj);
          details.disk = {
            id: dId,
            name: diskObj.name,
            mountPath: diskObj.mountPath,
            sizeGB: diskObj.sizeGB,
          };
        }
        const headersIn =
          (details.headers as Array<{ path: string; name: string; value: string }>) ?? [];
        const routesIn =
          (details.routes as Array<{ source: string; destination: string; type: string }>) ?? [];
        delete details.headers;
        delete details.routes;
        if (b.type === "web_service") {
          details.url = `https://${b.name}.onrender.com`;
          details.openPorts = [{ port: 10000, protocol: "TCP" }];
        } else if (b.type === "private_service") {
          details.url = `${b.name}:10000`;
          details.openPorts = [{ port: 10000, protocol: "TCP" }];
        } else if (b.type === "static_site") {
          details.url = `https://${b.name}.onrender.com`;
        }
        const img = b.image as { imagePath?: string; registryCredentialId?: string } | undefined;
        const deployId = this.nextId("dep");
        const svc: StoredService = {
          id,
          name: String(b.name),
          slug: String(b.name),
          type: String(b.type),
          ownerId: String(b.ownerId),
          environmentId: b.environmentId as string | undefined,
          repo: b.repo as string | undefined,
          branch: b.branch as string | undefined,
          rootDir: (b.rootDir as string | undefined) ?? ".",
          imagePath: img?.imagePath,
          autoDeploy: b.autoDeployTrigger === "off" || b.autoDeploy === "no" ? "no" : "yes",
          autoDeployTrigger: b.autoDeployTrigger as string | undefined,
          buildFilter: b.buildFilter as { paths: string[]; ignoredPaths: string[] } | undefined,
          registryCredential: img?.registryCredentialId
            ? { id: img.registryCredentialId, name: "cred" }
            : undefined,
          dashboardUrl: `https://dashboard.render.com/service/${id}`,
          suspended: "not_suspended",
          suspenders: [],
          serviceDetails: details,
          envVars: this.envVarsFromInput(
            b.envVars as
              | Array<{ key: string; value?: string; generateValue?: boolean }>
              | undefined,
          ),
          secretFiles: (b.secretFiles as Array<{ name: string; content: string }>) ?? [],
          customDomains: [],
          headers: headersIn.map((h) => ({ id: this.nextId("hdr"), ...h })),
          routes: routesIn.map((r, i) => ({ id: this.nextId("rte"), priority: i, ...r })),
          deploys: [
            {
              id: deployId,
              status: this.deployReadyAfterPolls <= 1 ? "live" : "build_in_progress",
              trigger: "api",
              createdAt: now,
              updatedAt: now,
            },
          ],
          notificationOverride: {
            serviceId: id,
            notificationsToSend: "default",
            previewNotificationsEnabled: "default",
          },
          pollCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.services.set(id, svc);
        return json({ deployId, service: this.serviceView(svc) }, 201);
      }
      if (segs.length === 2) {
        const svc = this.services.get(segs[1]);
        if (!svc) return notFound("Service not found");
        if (method === "GET") return json(this.serviceView(svc));
        if (method === "PATCH") {
          const b = body as Record<string, unknown>;
          if (b.name !== undefined) svc.name = String(b.name);
          if (b.repo !== undefined) svc.repo = String(b.repo);
          if (b.branch !== undefined) svc.branch = String(b.branch);
          if (b.rootDir !== undefined) svc.rootDir = String(b.rootDir);
          if (b.autoDeploy !== undefined) svc.autoDeploy = b.autoDeploy as "yes" | "no";
          if (b.autoDeployTrigger !== undefined)
            svc.autoDeployTrigger = String(b.autoDeployTrigger);
          if (b.buildFilter !== undefined)
            svc.buildFilter = b.buildFilter as { paths: string[]; ignoredPaths: string[] };
          const img = b.image as { imagePath?: string; registryCredentialId?: string } | undefined;
          if (img?.imagePath !== undefined) svc.imagePath = img.imagePath;
          if (b.serviceDetails && typeof b.serviceDetails === "object") {
            svc.serviceDetails = {
              ...svc.serviceDetails,
              ...(b.serviceDetails as Record<string, unknown>),
            };
          }
          return json(this.serviceView(svc));
        }
        if (method === "DELETE") {
          for (const [did, d] of this.disks.entries()) {
            if (d.serviceId === svc.id) this.disks.delete(did);
          }
          this.services.delete(svc.id);
          return new Response(null, { status: 204 });
        }
      }
      if (segs.length >= 3) {
        const svc = this.services.get(segs[1]);
        if (!svc) return notFound("Service not found");
        const sub = segs[2];
        if (sub === "env-vars") {
          if (method === "GET") {
            return json(
              paginate(svc.envVars, cursor, limit, this.maxPageSize, (c, envVar) => ({
                cursor: c,
                envVar,
              })),
            );
          }
          if (method === "PUT") {
            svc.envVars = this.envVarsFromInput(
              body as Array<{ key: string; value?: string; generateValue?: boolean }>,
            );
            return json(svc.envVars.map((envVar, i) => ({ cursor: String(i + 1), envVar })));
          }
        }
        if (sub === "secret-files") {
          if (method === "GET") {
            return json(
              paginate(svc.secretFiles, cursor, limit, this.maxPageSize, (c, secretFile) => ({
                cursor: c,
                secretFile,
              })),
            );
          }
          if (method === "PUT") {
            svc.secretFiles = (body as Array<{ name: string; content: string }>) ?? [];
            return json(
              svc.secretFiles.map((secretFile, i) => ({ cursor: String(i + 1), secretFile })),
            );
          }
        }
        if (sub === "custom-domains") {
          if (method === "GET" && segs.length === 3) {
            return json(
              paginate(svc.customDomains, cursor, limit, this.maxPageSize, (c, customDomain) => ({
                cursor: c,
                customDomain,
              })),
            );
          }
          if (method === "POST" && segs.length === 3) {
            const b = body as { name: string };
            const cd = {
              id: this.nextId("cdm"),
              name: b.name,
              domainType: b.name.split(".").length > 2 ? "subdomain" : "apex",
              publicSuffix: "com",
              redirectForName: "",
              verificationStatus: this.customDomainInitialVerificationStatus,
              createdAt: this.now(),
            };
            svc.customDomains.push(cd);
            return json([cd], 201);
          }
          if (method === "POST" && segs.length === 5 && segs[4] === "verify") {
            const domain = svc.customDomains.find((d) => d.id === segs[3] || d.name === segs[3]);
            if (!domain) return notFound("Custom domain not found");
            domain.verificationStatus = "verified";
            return new Response(null, { status: 204 });
          }
          if (method === "DELETE" && segs.length === 4) {
            svc.customDomains = svc.customDomains.filter(
              (d) => d.id !== segs[3] && d.name !== segs[3],
            );
            return new Response(null, { status: 204 });
          }
        }
        if (sub === "scale" && method === "POST") {
          const b = body as { numInstances: number };
          svc.serviceDetails.numInstances = b.numInstances;
          return new Response(null, { status: 204 });
        }
        if (sub === "autoscaling") {
          if (method === "PUT") {
            svc.serviceDetails.autoscaling = body;
            return new Response(null, { status: 204 });
          }
          if (method === "DELETE") {
            delete svc.serviceDetails.autoscaling;
            return new Response(null, { status: 204 });
          }
        }
        if (sub === "headers") {
          if (method === "GET") {
            return json(
              paginate(svc.headers, cursor, limit, this.maxPageSize, (c, header) => ({
                cursor: c,
                header,
              })),
            );
          }
          if (method === "PUT") {
            const list = (body as Array<{ path: string; name: string; value: string }>) ?? [];
            svc.headers = list.map((h) => ({ id: this.nextId("hdr"), ...h }));
            return json(svc.headers);
          }
        }
        if (sub === "routes") {
          if (method === "GET") {
            return json(
              paginate(svc.routes, cursor, limit, this.maxPageSize, (c, route) => ({
                cursor: c,
                route,
              })),
            );
          }
          if (method === "PUT") {
            const list =
              (body as Array<{ source: string; destination: string; type: string }>) ?? [];
            svc.routes = list.map((r, i) => ({ id: this.nextId("rte"), priority: i, ...r }));
            return json(svc.routes);
          }
        }
        if (sub === "deploys") {
          if (method === "GET") {
            svc.pollCount++;
            if (svc.deploys[0]) {
              if (this.deployTerminalStatus && svc.pollCount >= 2) {
                svc.deploys[0].status = this.deployTerminalStatus;
              } else if (svc.pollCount >= this.deployReadyAfterPolls) {
                svc.deploys[0].status = "live";
              }
            }
            return json(svc.deploys.map((deploy, i) => ({ cursor: String(i + 1), deploy })));
          }
          if (method === "POST") {
            const dep = {
              id: this.nextId("dep"),
              status: this.deployReadyAfterPolls <= 1 ? "live" : "build_in_progress",
              trigger: "api",
              createdAt: this.now(),
              updatedAt: this.now(),
            };
            svc.pollCount = 0;
            svc.deploys.unshift(dep);
            return json(dep, 201);
          }
        }
        if (sub === "suspend" && method === "POST") {
          svc.suspended = "suspended";
          svc.suspenders = ["user"];
          return new Response(null, { status: 204 });
        }
        if (sub === "resume" && method === "POST") {
          svc.suspended = "not_suspended";
          svc.suspenders = [];
          return new Response(null, { status: 204 });
        }
        if (sub === "cache" && segs.length === 4 && segs[3] === "purge" && method === "POST") {
          return new Response(null, { status: 204 });
        }
        if (sub === "preview" && method === "POST") {
          const b = body as { imagePath: string; name?: string; plan?: string };
          const id = this.nextId("srv");
          const deployId = this.nextId("dep");
          const now = this.now();
          const name = b.name ?? `${svc.name}-preview-${id}`;
          const previewSvc: StoredService = {
            id,
            name,
            slug: name,
            type: svc.type,
            ownerId: svc.ownerId,
            environmentId: svc.environmentId,
            imagePath: b.imagePath,
            autoDeploy: svc.autoDeploy,
            autoDeployTrigger: svc.autoDeployTrigger,
            registryCredential: svc.registryCredential,
            dashboardUrl: `https://dashboard.render.com/service/${id}`,
            suspended: "not_suspended",
            suspenders: [],
            serviceDetails: {
              ...svc.serviceDetails,
              ...(b.plan !== undefined ? { plan: b.plan } : {}),
              ...(svc.type === "web_service" ? { url: `https://${name}.onrender.com` } : {}),
            },
            envVars: svc.envVars.map((ev) => ({ ...ev })),
            secretFiles: svc.secretFiles.map((sf) => ({ ...sf })),
            customDomains: [],
            headers: [],
            routes: [],
            deploys: [
              {
                id: deployId,
                status: this.deployReadyAfterPolls <= 1 ? "live" : "build_in_progress",
                trigger: "api",
                createdAt: now,
                updatedAt: now,
              },
            ],
            notificationOverride: {
              serviceId: id,
              notificationsToSend: "default",
              previewNotificationsEnabled: "default",
            },
            pollCount: 0,
            createdAt: now,
            updatedAt: now,
          };
          this.services.set(id, previewSvc);
          return json({ deployId, service: this.serviceView(previewSvc) }, 201);
        }
      }
    }

    // /postgres
    if (segs[0] === "postgres") {
      if (segs.length === 1 && method === "GET") {
        const items = [...this.postgres.values()].filter((p) => {
          if (query.ownerId && !query.ownerId.includes(p.owner.id)) return false;
          if (query.name && !query.name.includes(p.name)) return false;
          return true;
        });
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, postgres) => ({
            cursor: c,
            postgres,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as Record<string, unknown>;
        const id = this.nextId("dpg");
        const owner = this.owners.find((o) => o.id === b.ownerId) ?? this.owners[0];
        const replicasIn =
          (b.readReplicas as Array<{
            name: string;
            parameterOverrides?: Record<string, string>;
          }>) ?? [];
        const now = this.now();
        const pg: StoredPostgres = {
          id,
          name: String(b.name),
          owner,
          plan: String(b.plan ?? "free"),
          region: String(b.region ?? "oregon"),
          version: String(b.version ?? "16"),
          databaseName: String(b.databaseName ?? "app_db"),
          databaseUser: String(b.databaseUser ?? "app_user"),
          diskSizeGB: (b.diskSizeGB as number | undefined) ?? 1,
          diskAutoscalingEnabled: Boolean(b.enableDiskAutoscaling ?? false),
          highAvailabilityEnabled: Boolean(b.enableHighAvailability ?? false),
          environmentId: b.environmentId as string | undefined,
          ipAllowList: (b.ipAllowList as Array<{ cidrBlock: string; description: string }>) ?? [
            { cidrBlock: "0.0.0.0/0", description: "everywhere" },
          ],
          readReplicas: replicasIn.map((r) => ({
            id: this.nextId("dpg-rep"),
            name: r.name,
            parameterOverrides: r.parameterOverrides,
          })),
          parameterOverrides: b.parameterOverrides as Record<string, string> | undefined,
          connectionPool: (b.connectionPool as string | undefined) ?? "none",
          role: "primary",
          status: this.postgresReadyAfterPolls <= 1 ? "available" : "creating",
          suspended: "not_suspended",
          suspenders: [],
          dashboardUrl: `https://dashboard.render.com/d/${id}`,
          createdAt: now,
          updatedAt: now,
          pollCount: 0,
        };
        this.postgres.set(id, pg);
        return json(pg, 201);
      }
      if (segs.length >= 2) {
        const pg = this.postgres.get(segs[1]);
        if (!pg) return notFound("Postgres not found");
        if (segs.length === 3 && segs[2] === "connection-info" && method === "GET") {
          return json({
            internalConnectionString: `postgresql://${pg.databaseUser}:pgpass-${pg.id}@${pg.id}-a:5432/${pg.databaseName}`,
            externalConnectionString: `postgresql://${pg.databaseUser}:pgpass-${pg.id}@${pg.id}-a.${pg.region}-postgres.render.com:5432/${pg.databaseName}?ssl=true`,
            password: `pgpass-${pg.id}`,
            psqlCommand: `PGPASSWORD=pgpass-${pg.id} psql postgresql://${pg.databaseUser}@${pg.id}-a.${pg.region}-postgres.render.com:5432/${pg.databaseName}`,
          });
        }
        if (segs.length === 2 && method === "GET") {
          pg.pollCount++;
          if (pg.status === "creating" && pg.pollCount >= this.postgresReadyAfterPolls) {
            pg.status = "available";
          }
          return json(pg);
        }
        if (segs.length === 2 && method === "PATCH") {
          const b = body as Record<string, unknown>;
          if (b.name !== undefined) pg.name = String(b.name);
          if (b.plan !== undefined) pg.plan = String(b.plan);
          if (b.diskSizeGB !== undefined) pg.diskSizeGB = Number(b.diskSizeGB);
          if (b.enableDiskAutoscaling !== undefined)
            pg.diskAutoscalingEnabled = Boolean(b.enableDiskAutoscaling);
          if (b.enableHighAvailability !== undefined)
            pg.highAvailabilityEnabled = Boolean(b.enableHighAvailability);
          if (b.connectionPool !== undefined) pg.connectionPool = String(b.connectionPool);
          if (b.ipAllowList !== undefined)
            pg.ipAllowList = b.ipAllowList as Array<{ cidrBlock: string; description: string }>;
          if ("parameterOverrides" in b) {
            const p = b.parameterOverrides as Record<string, string>;
            pg.parameterOverrides = Object.keys(p).length === 0 ? undefined : p;
          }
          if (b.readReplicas !== undefined) {
            const list = b.readReplicas as Array<{
              name: string;
              parameterOverrides?: Record<string, string>;
            }>;
            pg.readReplicas = list.map((r) => {
              const existing = pg.readReplicas.find((er) => er.name === r.name);
              return {
                id: existing?.id ?? this.nextId("dpg-rep"),
                name: r.name,
                parameterOverrides: r.parameterOverrides,
              };
            });
          }
          return json(pg);
        }
        if (segs.length === 2 && method === "DELETE") {
          this.postgresExports.delete(pg.id);
          this.postgres.delete(pg.id);
          return new Response(null, { status: 204 });
        }
        if (segs.length === 3 && segs[2] === "suspend" && method === "POST") {
          pg.suspended = "suspended";
          pg.suspenders = ["user"];
          return new Response(null, { status: 204 });
        }
        if (segs.length === 3 && segs[2] === "resume" && method === "POST") {
          pg.suspended = "not_suspended";
          pg.suspenders = [];
          return new Response(null, { status: 204 });
        }
        if (segs.length === 3 && segs[2] === "recovery") {
          if (method === "GET") {
            return json({
              recoveryStatus: pg.plan === "free" ? "unavailable" : "available",
              ...(pg.plan === "free" ? {} : { startsAt: pg.createdAt }),
            });
          }
          if (method === "POST") {
            const b = body as { restoreName: string; restoreTime: string; plan?: string };
            const id = this.nextId("dpg");
            const now = this.now();
            const restored: StoredPostgres = {
              id,
              name: b.restoreName,
              owner: pg.owner,
              plan: b.plan ?? pg.plan,
              region: pg.region,
              version: pg.version,
              databaseName: pg.databaseName,
              databaseUser: pg.databaseUser,
              diskSizeGB: pg.diskSizeGB,
              diskAutoscalingEnabled: pg.diskAutoscalingEnabled,
              highAvailabilityEnabled: pg.highAvailabilityEnabled,
              environmentId: pg.environmentId,
              ipAllowList: pg.ipAllowList.map((entry) => ({ ...entry })),
              readReplicas: [],
              parameterOverrides: pg.parameterOverrides ? { ...pg.parameterOverrides } : undefined,
              connectionPool: pg.connectionPool,
              primaryPostgresID: pg.id,
              role: "primary",
              status: this.postgresReadyAfterPolls <= 1 ? "available" : "creating",
              suspended: "not_suspended",
              suspenders: [],
              dashboardUrl: `https://dashboard.render.com/d/${id}`,
              createdAt: now,
              updatedAt: now,
              pollCount: 0,
            };
            this.postgres.set(id, restored);
            return json(restored, 201);
          }
        }
        if (segs.length === 3 && segs[2] === "export") {
          const list = this.postgresExports.get(pg.id) ?? [];
          if (method === "GET") {
            return json(list);
          }
          if (method === "POST") {
            const exp: StoredPostgresExport = {
              id: this.nextId("dpg-exp"),
              url: `https://exports.render.com/${pg.id}/${this.seq}.sql.gz`,
              createdAt: this.now(),
            };
            list.push(exp);
            this.postgresExports.set(pg.id, list);
            return json(exp, 201);
          }
        }
      }
    }

    // /key-value and /redis share storage semantics on separate maps
    if (segs[0] === "key-value" || segs[0] === "redis") {
      const store = segs[0] === "key-value" ? this.keyValues : this.redis;
      const listKey = segs[0] === "key-value" ? "keyValue" : "redis";
      if (segs.length === 1 && method === "GET") {
        const items = [...store.values()].filter((k) => {
          if (query.ownerId && !query.ownerId.includes(k.owner.id)) return false;
          if (query.name && !query.name.includes(k.name)) return false;
          return true;
        });
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, item) => ({
            cursor: c,
            [listKey]: item,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as Record<string, unknown>;
        const id = this.nextId("red");
        const owner = this.owners.find((o) => o.id === b.ownerId) ?? this.owners[0];
        const now = this.now();
        const item: StoredKeyValue = {
          id,
          name: String(b.name),
          owner,
          plan: String(b.plan ?? "free"),
          region: String(b.region ?? "oregon"),
          version: "8.0",
          environmentId: b.environmentId as string | undefined,
          ipAllowList: (b.ipAllowList as Array<{ cidrBlock: string; description: string }>) ?? [
            { cidrBlock: "0.0.0.0/0", description: "everywhere" },
          ],
          options: {
            ...(b.maxmemoryPolicy !== undefined
              ? { maxmemoryPolicy: String(b.maxmemoryPolicy) }
              : { maxmemoryPolicy: "noeviction" }),
            ...(b.persistenceMode !== undefined
              ? { persistenceMode: String(b.persistenceMode) }
              : {}),
          },
          status: "available",
          dashboardUrl: `https://dashboard.render.com/r/${id}`,
          createdAt: now,
          updatedAt: now,
          pollCount: 0,
        };
        store.set(id, item);
        return json(item, 201);
      }
      if (segs.length >= 2) {
        const item = store.get(segs[1]);
        if (!item) return notFound(`${segs[0]} not found`);
        if (segs.length === 3 && segs[2] === "connection-info" && method === "GET") {
          const internal = `redis://${item.id}:6379`;
          const external = `rediss://red-${item.id}:${item.region}.render.com:6379`;
          if (segs[0] === "key-value") {
            return json({
              internalConnectionString: internal,
              externalConnectionString: external,
              cliCommand: `valkey-cli -u ${external}`,
            });
          }
          return json({
            internalConnectionString: internal,
            externalConnectionString: external,
            redisCLICommand: `redis-cli -u ${external}`,
          });
        }
        if (segs.length === 2 && method === "GET") return json(item);
        if (segs.length === 2 && method === "PATCH") {
          const b = body as Record<string, unknown>;
          if (b.name !== undefined) item.name = String(b.name);
          if (b.plan !== undefined) item.plan = String(b.plan);
          if (b.ipAllowList !== undefined)
            item.ipAllowList = b.ipAllowList as Array<{ cidrBlock: string; description: string }>;
          if (b.maxmemoryPolicy !== undefined)
            item.options.maxmemoryPolicy = String(b.maxmemoryPolicy);
          if (b.persistenceMode !== undefined)
            item.options.persistenceMode = String(b.persistenceMode);
          return json(item);
        }
        if (segs.length === 2 && method === "DELETE") {
          store.delete(item.id);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /webhooks
    if (segs[0] === "webhooks") {
      if (segs.length === 1 && method === "GET") {
        const items = [...this.webhooks.values()].filter(
          (w) => !query.ownerId || query.ownerId.includes(w.ownerId),
        );
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, webhook) => ({
            cursor: c,
            webhook,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as {
          ownerId: string;
          name: string;
          url: string;
          enabled: boolean;
          eventFilter: string[];
        };
        const id = this.nextId("whk");
        const whk: StoredWebhook = {
          id,
          ownerId: b.ownerId,
          name: b.name,
          url: b.url,
          enabled: b.enabled,
          eventFilter: b.eventFilter ?? [],
          secret: `whsec-${id}`,
        };
        this.webhooks.set(id, whk);
        return json(whk, 201);
      }
      if (segs.length === 2) {
        const whk = this.webhooks.get(segs[1]);
        if (!whk) return notFound("Webhook not found");
        if (method === "GET") return json(whk);
        if (method === "PATCH") {
          const b = body as Partial<StoredWebhook>;
          if (b.name !== undefined) whk.name = b.name;
          if (b.url !== undefined) whk.url = b.url;
          if (b.enabled !== undefined) whk.enabled = b.enabled;
          if (b.eventFilter !== undefined) whk.eventFilter = b.eventFilter;
          return json(whk);
        }
        if (method === "DELETE") {
          this.webhooks.delete(whk.id);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /dedicated-ips
    if (segs[0] === "dedicated-ips") {
      if (segs.length === 1 && method === "GET") {
        const items = [...this.dedicatedIps.values()].filter((d) => {
          if (query.ownerId && !query.ownerId.includes(d.ownerId)) return false;
          if (query.region && !query.region.includes(d.region)) return false;
          return true;
        });
        return json(items);
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as {
          ownerId: string;
          name: string;
          region: string;
          description?: string;
          environmentIds?: string[];
        };
        const id = this.nextId("dip");
        const now = this.now();
        const dip: StoredDedicatedIp = {
          id,
          name: b.name,
          ownerId: b.ownerId,
          region: b.region,
          description: b.description ?? "",
          environmentIds: b.environmentIds ?? [],
          ips: this.dedicatedIpReadyAfterPolls <= 1 ? ["198.51.100.10", "198.51.100.11"] : [],
          status: this.dedicatedIpReadyAfterPolls <= 1 ? "RUNNING" : "CREATING",
          createdAt: now,
          updatedAt: now,
          pollCount: 0,
        };
        this.dedicatedIps.set(id, dip);
        return json(dip, 201);
      }
      if (segs.length === 2) {
        const dip = this.dedicatedIps.get(segs[1]);
        if (!dip) return notFound("DedicatedIp not found");
        if (method === "GET") {
          dip.pollCount++;
          if (dip.status === "CREATING") {
            if (this.dedicatedIpTerminalStatus && dip.pollCount >= 1) {
              dip.status = this.dedicatedIpTerminalStatus;
            } else if (dip.pollCount >= this.dedicatedIpReadyAfterPolls) {
              dip.status = "RUNNING";
              dip.ips = ["198.51.100.10", "198.51.100.11"];
            }
          }
          return json(dip);
        }
        if (method === "PATCH") {
          const b = body as Partial<StoredDedicatedIp>;
          if (b.name !== undefined) dip.name = b.name;
          if (b.description !== undefined) dip.description = b.description;
          if (b.environmentIds !== undefined) dip.environmentIds = b.environmentIds;
          return json(dip);
        }
        if (method === "DELETE") {
          this.dedicatedIps.delete(dip.id);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /logs/streams/owner/:ownerId and /logs/streams/resource/:resourceId
    if (segs[0] === "logs" && segs[1] === "streams") {
      if (segs[2] === "owner" && segs.length === 4) {
        const ownerId = segs[3];
        if (method === "GET") {
          const entry = this.ownerLogStreams.get(ownerId);
          return entry ? json(entry) : notFound("Owner log stream not found");
        }
        if (method === "PUT") {
          const b = body as { endpoint: string; preview?: string };
          const entry = { ownerId, endpoint: b.endpoint, preview: b.preview ?? "send" };
          this.ownerLogStreams.set(ownerId, entry);
          return json(entry);
        }
        if (method === "DELETE") {
          this.ownerLogStreams.delete(ownerId);
          return new Response(null, { status: 204 });
        }
      }
      if (segs[2] === "resource" && segs.length === 4) {
        const resourceId = segs[3];
        if (method === "GET") {
          const entry = this.resourceLogStreams.get(resourceId);
          return entry ? json(entry) : notFound("Resource log stream not found");
        }
        if (method === "PUT") {
          const b = body as { setting: string; endpoint?: string };
          const entry = {
            resourceId,
            setting: b.setting,
            ...(b.endpoint !== undefined ? { endpoint: b.endpoint } : {}),
          };
          this.resourceLogStreams.set(resourceId, entry);
          return json(entry);
        }
        if (method === "DELETE") {
          this.resourceLogStreams.delete(resourceId);
          return new Response(null, { status: 204 });
        }
      }
    }

    // /metrics-stream/:ownerId
    if (segs[0] === "metrics-stream" && segs.length === 2) {
      const ownerId = segs[1];
      if (method === "GET") {
        const entry = this.metricsStreams.get(ownerId);
        return entry ? json(entry) : notFound("Metrics stream not found");
      }
      if (method === "PUT") {
        const b = body as { provider: string; url: string };
        const entry = { ownerId, provider: b.provider, url: b.url };
        this.metricsStreams.set(ownerId, entry);
        return json(entry);
      }
      if (method === "DELETE") {
        this.metricsStreams.delete(ownerId);
        return new Response(null, { status: 204 });
      }
    }

    // /notification-settings/owners/:ownerId and /notification-settings/overrides/services/:serviceId
    if (segs[0] === "notification-settings") {
      if (segs[1] === "owners" && segs.length === 3) {
        const ownerId = segs[2];
        const current = this.notificationSettings.get(ownerId) ?? {
          ownerId,
          emailEnabled: true,
          slackEnabled: false,
          notificationsToSend: "all",
          previewNotificationsEnabled: true,
        };
        if (method === "GET") return json(current);
        if (method === "PATCH") {
          const b = body as Partial<typeof current>;
          const updated = {
            ...current,
            ...(b.emailEnabled !== undefined ? { emailEnabled: b.emailEnabled } : {}),
            ...(b.notificationsToSend !== undefined
              ? { notificationsToSend: b.notificationsToSend }
              : {}),
            ...(b.previewNotificationsEnabled !== undefined
              ? { previewNotificationsEnabled: b.previewNotificationsEnabled }
              : {}),
          };
          this.notificationSettings.set(ownerId, updated);
          return json(updated);
        }
      }
      if (segs[1] === "overrides" && segs[2] === "services" && segs.length === 4) {
        const svc = this.services.get(segs[3]);
        if (!svc) return notFound("Service not found");
        if (method === "GET") return json(svc.notificationOverride);
        if (method === "PATCH") {
          const b = body as { notificationsToSend?: string; previewNotificationsEnabled?: string };
          svc.notificationOverride = {
            serviceId: svc.id,
            notificationsToSend:
              b.notificationsToSend ?? svc.notificationOverride.notificationsToSend,
            previewNotificationsEnabled:
              b.previewNotificationsEnabled ?? svc.notificationOverride.previewNotificationsEnabled,
          };
          return json(svc.notificationOverride);
        }
      }
    }

    // /workflows
    if (segs[0] === "workflows") {
      if (segs.length === 1 && method === "GET") {
        const items = [...this.workflows.values()].filter((w) => {
          if (query.ownerId && !query.ownerId.includes(w.ownerId)) return false;
          if (query.name && !query.name.includes(w.name)) return false;
          if (
            query.environmentId &&
            (!w.environmentId || !query.environmentId.includes(w.environmentId))
          ) {
            return false;
          }
          return true;
        });
        if (items.length === 0 && !cursor) {
          return json(null);
        }
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, w) => ({
            cursor: c,
            workflow: this.workflowView(w),
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as Record<string, unknown>;
        const id = this.nextId("wfl");
        const now = this.now();
        const buildConfig = (b.buildConfig as Record<string, unknown> | undefined) ?? {};
        const wf: StoredWorkflow = {
          id,
          name: String(b.name),
          slug: String(b.name),
          ownerId: String(b.ownerId ?? this.owners[0]?.id ?? "tea-alchemy-test"),
          environmentId: b.environmentId as string | undefined,
          region: String(b.region ?? "oregon"),
          runtime: String(buildConfig.runtime ?? b.runtime ?? "node"),
          repo: String(buildConfig.repo ?? b.repo ?? ""),
          branch: (buildConfig.branch ?? b.branch) as string | undefined,
          rootDir: (buildConfig.rootDir ?? b.rootDir) as string | undefined,
          buildCommand: (buildConfig.buildCommand ?? b.buildCommand) as string | undefined,
          runCommand: String(b.runCommand ?? ""),
          autoDeployTrigger: b.autoDeployTrigger as string | undefined,
          envVars: this.envVarsFromInput(
            b.envVars as
              | Array<{ key: string; value?: string; generateValue?: boolean }>
              | undefined,
          ),
          createdAt: now,
          updatedAt: now,
        };
        this.workflows.set(id, wf);
        return json(this.workflowView(wf), 201);
      }
      if (segs.length === 2) {
        const wf = this.workflows.get(segs[1]);
        if (!wf) return notFound("Workflow not found");
        if (method === "GET") return json(this.workflowView(wf));
        if (method === "PATCH") {
          const b = body as Record<string, unknown>;
          const buildConfig = b.buildConfig as Record<string, unknown> | undefined;
          if (b.name !== undefined) wf.name = String(b.name);
          if (b.runCommand !== undefined) wf.runCommand = String(b.runCommand);
          if (b.autoDeployTrigger !== undefined) wf.autoDeployTrigger = String(b.autoDeployTrigger);
          if (buildConfig) {
            if (buildConfig.runtime !== undefined) wf.runtime = String(buildConfig.runtime);
            if (buildConfig.repo !== undefined) wf.repo = String(buildConfig.repo);
            if (buildConfig.branch !== undefined) wf.branch = String(buildConfig.branch);
            if (buildConfig.rootDir !== undefined) wf.rootDir = String(buildConfig.rootDir);
            if (buildConfig.buildCommand !== undefined)
              wf.buildCommand = String(buildConfig.buildCommand);
          }
          if (b.envVars !== undefined) {
            wf.envVars = this.envVarsFromInput(
              b.envVars as Array<{ key: string; value?: string; generateValue?: boolean }>,
            );
          }
          return json(this.workflowView(wf));
        }
        if (method === "DELETE") {
          for (const [vid, v] of this.workflowVersions.entries()) {
            if (v.workflowId === wf.id) this.workflowVersions.delete(vid);
          }
          this.workflows.delete(wf.id);
          return new Response(null, { status: 204 });
        }
      }
      if (segs.length === 3 && segs[2] === "versions") {
        const wf = this.workflows.get(segs[1]);
        if (!wf) return notFound("Workflow not found");
        if (method === "GET") {
          const versions = [...this.workflowVersions.values()].filter(
            (v) => v.workflowId === wf.id,
          );
          return json(
            paginate(versions, cursor, limit, this.maxPageSize, (c, workflowVersion) => ({
              cursor: c,
              workflowVersion,
            })),
          );
        }
        if (method === "POST") {
          const b = (body as { name?: string } | undefined) ?? {};
          const id = this.nextId("wfl-ver");
          const now = this.now();
          const version: StoredWorkflowVersion = {
            id,
            workflowId: wf.id,
            name: b.name,
            status: this.workflowVersionReadyAfterPolls <= 1 ? "ready" : "building",
            pollCount: 0,
            createdAt: now,
            updatedAt: now,
          };
          this.workflowVersions.set(id, version);
          wf.defaultVersionId = id;
          return json(version, 201);
        }
      }
    }

    // /workflowversions/:id
    if (segs[0] === "workflowversions" && segs.length === 2 && method === "GET") {
      const version = this.workflowVersions.get(segs[1]);
      if (!version) return notFound("Workflow version not found");
      version.pollCount++;
      if (version.status !== "ready" && version.pollCount >= this.workflowVersionReadyAfterPolls) {
        version.status = "ready";
      }
      return json(version);
    }

    // /task-runs
    if (segs[0] === "task-runs") {
      if (segs.length === 1 && method === "GET") {
        const items = [...this.taskRuns.values()].filter((tr) => {
          if (query.task && !query.task.includes(tr.task)) return false;
          if (query.status && !query.status.includes(tr.status)) return false;
          return true;
        });
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, taskRun) => ({
            cursor: c,
            taskRun,
          })),
        );
      }
      if (segs.length === 1 && method === "POST") {
        const b = body as { task: string; input?: unknown };
        const id = this.nextId("trn");
        const now = this.now();
        const taskRun: StoredTaskRun = {
          id,
          task: b.task,
          status: "completed",
          input: b.input,
          results: b.input !== undefined ? { echo: b.input } : { ok: true },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        this.taskRuns.set(id, taskRun);
        return json(taskRun, 202);
      }
      if (segs.length === 2) {
        const taskRun = this.taskRuns.get(segs[1]);
        if (!taskRun) return notFound("Task run not found");
        if (method === "GET") return json(taskRun);
        if (method === "DELETE") {
          taskRun.status = "canceled";
          return new Response(null, { status: 204 });
        }
      }
    }

    // /blueprints
    if (segs[0] === "blueprints") {
      if (segs.length === 1 && method === "GET") {
        const ownerFilter = query.ownerId;
        const items = [...this.blueprints.values()]
          .filter((bp) => !ownerFilter || ownerFilter.includes(bp.ownerId))
          .map(({ resources: _r, syncs: _s, ...summary }) => summary);
        return json(
          paginate(items, cursor, limit, this.maxPageSize, (c, blueprint) => ({
            cursor: c,
            blueprint,
          })),
        );
      }
      if (segs.length === 2 && segs[1] === "validate" && method === "POST") {
        const yamlText =
          typeof formData?.get("file") === "string"
            ? (formData.get("file") as string)
            : formData?.get("file") instanceof Blob
              ? await (formData.get("file") as Blob).text()
              : typeof (body as { file?: unknown } | undefined)?.file === "string"
                ? (body as { file: string }).file
                : "";
        if (yamlText.includes("INVALID_BLUEPRINT") || yamlText.trim().length === 0) {
          return json({ valid: false, error: "Invalid render.yaml blueprint manifest" }, 200);
        }
        return json({ valid: true, plan: { services: [] } }, 200);
      }
      if (segs.length === 2) {
        const bp = this.blueprints.get(segs[1]);
        if (!bp) return notFound("Blueprint not found");
        if (method === "GET") {
          const { syncs: _s, ...detail } = bp;
          return json(detail);
        }
        if (method === "PATCH") {
          const b = body as { name?: string; autoSync?: boolean; branch?: string; path?: string };
          if (b.name !== undefined) bp.name = b.name;
          if (b.autoSync !== undefined) bp.autoSync = b.autoSync;
          if (b.branch !== undefined) bp.branch = b.branch;
          if (b.path !== undefined) bp.path = b.path;
          const { resources: _r, syncs: _s, ...summary } = bp;
          return json(summary);
        }
        if (method === "DELETE") {
          this.blueprints.delete(bp.id);
          return new Response(null, { status: 204 });
        }
      }
      if (segs.length === 3 && segs[2] === "syncs" && method === "GET") {
        const bp = this.blueprints.get(segs[1]);
        if (!bp) return notFound("Blueprint not found");
        return json(
          paginate(bp.syncs, cursor, limit, this.maxPageSize, (c, sync) => ({
            cursor: c,
            sync,
          })),
        );
      }
    }

    // /logs
    if (segs[0] === "logs" && segs.length === 1 && method === "GET") {
      const ownerFilter = query.ownerId;
      const resourceFilter = query.resource;
      const startMs = query.startTime?.[0] ? Date.parse(query.startTime[0]) : undefined;
      const endMs = query.endTime?.[0] ? Date.parse(query.endTime[0]) : undefined;
      let matching = this.logs.filter((l) => {
        if (ownerFilter && !ownerFilter.includes(l.ownerId)) return false;
        if (resourceFilter && (!l.resourceId || !resourceFilter.includes(l.resourceId))) {
          return false;
        }
        const ts = Date.parse(l.timestamp);
        if (startMs !== undefined && !Number.isNaN(startMs) && ts < startMs) return false;
        if (endMs !== undefined && !Number.isNaN(endMs) && ts > endMs) return false;
        return true;
      });
      if (query.direction?.[0] === "backward") {
        matching = [...matching].reverse();
      }
      const reqLimit = query.limit?.[0] ? Number(query.limit[0]) : 100;
      const hasMore = matching.length > reqLimit;
      const slice = matching.slice(0, reqLimit);
      return json({
        hasMore,
        logs: slice.map(({ id, timestamp, message, labels }) => ({
          id,
          timestamp,
          message,
          ...(labels ? { labels } : {}),
        })),
      });
    }

    return notFound(`Unhandled FakeRenderServer route: ${method} ${path}`);
  }
}
