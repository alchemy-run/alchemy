import {
  prepareExplorerEmail,
  handleExplorerEmailLoopback,
} from "./LocalExplorerEmail.ts";
import { explorerWorkflowLoopback } from "./LocalExplorerWorkflows.ts";
import type { makeLocalExplorerCollector } from "./LocalExplorerCollector.ts";
import * as Effect from "effect/Effect";
import {
  defaultDurableObjectUniqueKey,
  SERVICE_USER_WORKER,
} from "./internal/constants.ts";
import * as Schema from "effect/Schema";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RegistryProxy } from "./registry/RegistryProxy.ts";
import { kVoid } from "./workerd/Config.ts";
import { Loopback } from "./globals/Loopback.ts";
import type { PluginContext } from "./PluginContext.ts";
import type { RuntimeWorker } from "./RuntimeWorker.ts";
import { ConfigError, SystemError } from "./RuntimeError.shared.ts";
import type { Service, Worker_Binding } from "./workerd/Config.ts";

export const LOCAL_EXPLORER_COLLECTOR = "local-explorer:collector";
export const LOCAL_EXPLORER_FLAGS = [
  "streaming_tail_worker",
  "tail_worker_user_spans",
];

export const LOCAL_EXPLORER_SERVICE = "local-explorer:router";
export const LOCAL_EXPLORER_PUBLIC_SERVICE = "local-explorer:public";

// Alchemy carries the resource ID in service props; Miniflare sends it in
// MF-Namespace. Reuse the exact resolved local service designator, including
// its props, instead of opening a second simulator or guessing storage IDs.
const storageRouter = `
export default {
  fetch(request, env) {
    const id = request.headers.get("MF-Namespace");
    const name = Object.hasOwn(env.RESOURCES, id) ? env.RESOURCES[id] : undefined;
    if (!name) return new Response("Unknown local resource", { status: 404 });
    return env[name].fetch(request);
  }
};
`;
const collectorBridge = `
import { WorkerEntrypoint } from "cloudflare:workers";
function serialize(event) {
  return JSON.parse(JSON.stringify(event, function(key, value) {
    if (this[key] instanceof Date) return { __date: this[key].getTime() };
    if (typeof value === "bigint") return { __bigint: value.toString() };
    return value;
  }), (_key, value) => {
    if (value && typeof value === "object") {
      if ("__date" in value) return new Date(value.__date);
      if ("__bigint" in value) return BigInt(value.__bigint);
    }
    return value;
  });
}
export default class extends WorkerEntrypoint {
  async target() {
    const response = await this.env.LOOPBACK.fetch("http://localhost/core/observability-collector");
    if (!response.ok) throw new Error("Local trace collector is unavailable");
    const { address } = await response.json();
    return this.env.DEBUG.connect(address).getEntrypoint("local-explorer:collector", undefined, this.ctx.props);
  }
  async fetch(request) { return (await this.target()).fetch(request); }
  async tailStream(onset) {
    const handler = await (await this.target()).tailStream(serialize(onset));
    return (event) => handler(serialize(event));
  }
}
`;
const d1Props = Schema.Struct({ databaseId: Schema.String });
const r2Props = Schema.Struct({ bucketName: Schema.String });
const kvProps = Schema.Struct({ namespaceId: Schema.String });

// Miniflare owns the UI and API contract. This adapter only supplies Alchemy's
// live Engine namespaces and its different persistence directory layout.
const router = `
import explorer, { handleEmail } from "./explorer.worker.js";
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const legacy = "/cdn-cgi/explorer";
    const prefix = "/cdn-cgi/local/explorer";
    if (url.pathname === legacy || url.pathname.startsWith(legacy + "/")) {
      url.pathname = prefix + url.pathname.slice(legacy.length);
      return Response.redirect(url, 302);
    }
    if (url.pathname === "/cdn-cgi/handler/email" || url.pathname === "/cdn-cgi/local/email") {
      return handleEmail(url.searchParams, request,
        env["MINIFLARE_EXPLORER_USER_WORKER_" + env.LOCAL_EXPLORER_WORKER_NAMES[0]],
        env.LOCAL_EXPLORER_WORKER_NAMES[0], env, ctx);
    }
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) {
      return env.UPSTREAM.fetch(request);
    }
    // The pinned native backend validates routes, methods and payloads. Keep
    // its OpenAPI specification consistent with the operations we expose.
    const resource = /^\\/cdn-cgi\\/local\\/explorer\\/api\\/(d1\\/database|r2\\/buckets|storage\\/kv\\/namespaces|workflows)\\/([^/]+)/.exec(url.pathname);
    if (resource) {
      const kind = resource[1] === "d1/database" ? "d1" : resource[1] === "r2/buckets" ? "r2" : resource[1] === "workflows" ? "workflows" : "kv";
      const id = decodeURIComponent(resource[2]);
      if (!Object.hasOwn(env.LOCAL_EXPLORER_BINDING_MAP[kind], id)) {
        const noAggregate = "X-Miniflare-Explorer-No-Aggregate";
        if (!request.headers.has(noAggregate)) {
          const registryResponse = await env.MINIFLARE_LOOPBACK.fetch("http://localhost/core/dev-registry");
          const peers = await registryResponse.json();
          for (const [name, peer] of Object.entries(peers)) {
            if (env.LOCAL_EXPLORER_WORKER_NAMES.includes(name)) continue;
            const entry = env.DEV_REGISTRY_DEBUG_PORT.connect(peer.debugPortAddress).getEntrypoint("core:entry");
            const headers = { [noAggregate]: "true", Host: "localhost" };
            let listing;
            try {
              const response = await entry.fetch("http://localhost" + prefix + "/api/" + resource[1], { headers });
              if (!response.ok) continue;
              listing = (await response.json()).result;
            } catch { continue; } // A peer may stop while discovery is in flight.
            const owned = kind === "d1" ? listing.some((db) => db.uuid === id) : kind === "r2" ? listing.buckets.some((bucket) => bucket.name === id) : kind === "workflows" ? listing.some((workflow) => workflow.name === id) : listing.some((ns) => ns.id === id);
            if (owned) {
              const forwarded = new Request(request);
              forwarded.headers.set(noAggregate, "true");
              return entry.fetch(forwarded);
            }
          }
        }
        return Response.json({ success: false, result: null, errors: [{ code: 10001, message: "Unknown local resource" }], messages: [] }, { status: 404 });
      }
    }
    // Miniflare's clear-workflow handler ignores a non-OK loopback response.
    // Surface failed deletions instead of reporting success to the browser.
    const checkedLoopback = {
      async fetch(input, init) {
        const response = await env.MINIFLARE_LOOPBACK.fetch(input, init);
        const method = init?.method ?? input?.method;
        if (method === "DELETE" && !response.ok && response.status !== 404) {
          throw new Error("Failed to delete local Workflow state");
        }
        return response;
      }
    };
    return explorer.fetch(request, { ...env, MINIFLARE_LOOPBACK: checkedLoopback }, ctx);
  }
};
`;

export const prepareLocalExplorer = Effect.fn("LocalExplorer.prepare")(
  function* (
    worker: RuntimeWorker,
    context: PluginContext["Service"],
    upstream: string,
    storage: Service,
    resolvedBindings: ReadonlyArray<Worker_Binding>,
    explorerUrl: string,
    collector?: Effect.Success<ReturnType<typeof makeLocalExplorerCollector>>,
  ) {
    const loopback = yield* context.get(Loopback);
    const scope = yield* Effect.scope;
    const workflows = worker.workflows ?? [];
    const require = createRequire(import.meta.url);
    const miniflareDist = yield* Effect.try({
      try: () => path.dirname(require.resolve("miniflare")),
      catch: (cause) =>
        new ConfigError({
          subtag: "LocalExplorer",
          message:
            "Install the pinned Miniflare dependency to use Local Explorer.",
          cause,
        }),
    });
    const [backend, shared, durableObjectWrapper, emailStore, sendEmail] =
      yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            fs.readFile(
              path.join(
                miniflareDist,
                "workers/local-explorer/explorer.worker.js",
              ),
              "utf8",
            ),
            fs.readFile(
              path.join(miniflareDist, "workers/shared/index.worker.js"),
              "utf8",
            ),
            fs.readFile(
              path.join(miniflareDist, "workers/core/do-wrapper.worker.js"),
              "utf8",
            ),
            fs.readFile(
              path.join(miniflareDist, "workers/email/email-store.worker.js"),
              "utf8",
            ),
            fs.readFile(
              path.join(miniflareDist, "workers/email/send_email.worker.js"),
              "utf8",
            ),
          ]),
        catch: (cause) =>
          new SystemError({
            subtag: "LocalExplorer",
            message: "Unable to load Miniflare's Local Explorer assets.",
            cause,
          }),
      });
    const storagePath = "disk" in storage ? storage.disk?.path : undefined;
    if (!storagePath)
      return yield* new ConfigError({
        subtag: "LocalExplorer",
        message: "Local Explorer requires disk-backed storage.",
      });

    const kvMap: Record<string, string> = Object.create(null);
    const kvBindings: Worker_Binding[] = [];
    const d1Map: Record<string, string> = Object.create(null);
    const r2Map: Record<string, string> = Object.create(null);
    const d1Bindings: Worker_Binding[] = [];
    const r2Bindings: Worker_Binding[] = [];
    for (const binding of resolvedBindings) {
      if (!binding.name) continue;
      const d1 =
        "wrapped" in binding
          ? binding.wrapped?.innerBindings?.find(
              (inner) => inner.name === "fetcher",
            )
          : undefined;
      if (d1 && "service" in d1 && d1.service?.name === "d1") {
        const props = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(d1Props),
        )(d1.service.props?.json).pipe(
          Effect.mapError(
            (cause) =>
              new ConfigError({
                subtag: "LocalExplorer",
                message: "Invalid local D1 binding props.",
                cause,
              }),
          ),
        );
        d1Map[props.databaseId] = binding.name;
        d1Bindings.push({
          name: `RESOURCE_${d1Bindings.length}`,
          service: d1.service,
        });
      }
      if ("kvNamespace" in binding && binding.kvNamespace?.name === "kv") {
        const props = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(kvProps),
        )(binding.kvNamespace.props?.json).pipe(
          Effect.mapError(
            (cause) =>
              new ConfigError({
                subtag: "LocalExplorer",
                message: "Invalid local KV binding props.",
                cause,
              }),
          ),
        );
        kvMap[props.namespaceId] = binding.name;
        kvBindings.push({
          name: `RESOURCE_${kvBindings.length}`,
          service: binding.kvNamespace,
        });
      }
      if ("r2Bucket" in binding && binding.r2Bucket?.name === "r2") {
        const props = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(r2Props),
        )(binding.r2Bucket.props?.json).pipe(
          Effect.mapError(
            (cause) =>
              new ConfigError({
                subtag: "LocalExplorer",
                message: "Invalid local R2 binding props.",
                cause,
              }),
          ),
        );
        r2Map[props.bucketName] = binding.name;
        r2Bindings.push({
          name: `RESOURCE_${r2Bindings.length}`,
          service: binding.r2Bucket,
        });
      }
    }
    // Only namespaces hosted here are advertised. Cross-worker consumers are
    // discovered via their owner so no second actor opens the same database.
    const namespaces = (worker.durableObjectNamespaces ?? []).filter(
      (ns) => !ns.ephemeralLocal,
    );
    const doMap = Object.fromEntries(
      namespaces.map((ns, index) => [
        ns.uniqueKey ??
          defaultDurableObjectUniqueKey(worker.name, ns.className),
        {
          binding: `DO_${index}`,
          className: ns.className,
          scriptName: worker.name,
          useSQLite: ns.sql ?? false,
        },
      ]),
    );
    const doBindings: Worker_Binding[] = namespaces.map((ns, index) => ({
      name: `DO_${index}`,
      durableObjectNamespace: {
        className: ns.className,
        serviceName: SERVICE_USER_WORKER,
      },
    }));
    const registry = yield* context.get(RegistryProxy);
    const storageScope = path.resolve(storagePath);
    const instanceId = crypto.randomUUID();
    yield* registry.api.configureLocalExplorer({ storageScope, instanceId });

    // A distinct target plus scoped unregistration prevents both cross-worker
    // overwrites and retained handlers after hot reload.
    const loopbackBinding = yield* loopback.api.route(
      `local-explorer:${worker.name}:${crypto.randomUUID()}`,
      async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const send = (status: number, body: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        if (
          await handleExplorerEmailLoopback(
            request,
            response,
            url,
            storagePath,
            worker.name,
          )
        )
          return;
        if (request.method !== "GET")
          return send(405, { error: "Read-only endpoint" });
        if (url.pathname === "/core/observability-collector") {
          if (!collector)
            return send(404, { error: "Local observability is disabled" });
          return send(200, await Effect.runPromise(collector.get));
        }
        if (url.pathname === "/core/dev-registry") {
          const entries = await Effect.runPromise(
            registry.api.localExplorerEntries,
          );
          response.setHeader(
            "X-Miniflare-Dev-Registry-Instance-Id",
            instanceId,
          );
          return send(
            200,
            Object.fromEntries(
              entries
                .filter(
                  (entry) => entry.localExplorer?.storageScope === storageScope,
                )
                .map((entry) => [
                  entry.scriptName,
                  {
                    debugPortAddress: entry.debugPortAddress,
                    ...entry.localExplorer,
                  },
                ]),
            ),
          );
        }
        const match = /^\/core\/(workflow-storage|do-storage)\/([^/]+)$/.exec(
          url.pathname,
        );
        const id = match?.[2] && decodeURIComponent(match[2]);
        const kind = match?.[1];
        const owned =
          id &&
          (kind === "workflow-storage"
            ? workflows.some((workflow) => workflow.workflowName === id)
            : Object.hasOwn(doMap, id));
        if (!owned) return send(404, { error: "Unknown local resource" });
        // Only filenames are read here. Queries use live Engine/DO RPC and
        // never open a competing SQLite connection to an active actor.
        const directory =
          kind === "workflow-storage"
            ? path.resolve(storagePath, "workflows", encodeURIComponent(id))
            : path.resolve(storagePath, id);
        if (!directory.startsWith(path.resolve(storagePath) + path.sep)) {
          return send(400, { error: "Invalid storage path" });
        }
        try {
          const entries = await fs.readdir(directory, { withFileTypes: true });
          const files = entries.filter(
            (entry) =>
              entry.isFile() && /^[a-f0-9]{64}\.sqlite$/i.test(entry.name),
          );
          const records = await Promise.all(
            files.map(async (entry) => {
              const stat = await fs.stat(path.join(directory, entry.name));
              return {
                name: entry.name,
                type: "file",
                birthtimeMs: stat.birthtimeMs,
              };
            }),
          );
          return send(200, records);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return send(200, []);
          throw error;
        }
      },
      scope,
    );

    const workflowMap = Object.fromEntries(
      workflows.map((workflow, index) => [
        workflow.workflowName,
        {
          name: workflow.workflowName,
          className: workflow.className,
          scriptName: worker.name,
          engineBinding: `ENGINE_${index}`,
          binding: `WORKFLOW_${index}`,
        },
      ]),
    );
    const engineBindings: Worker_Binding[] = workflows.map(
      (workflow, index) => ({
        name: `ENGINE_${index}`,
        durableObjectNamespace: {
          className: "Engine",
          serviceName: `workflows:${workflow.workflowName}`,
        },
      }),
    );
    const workflowBindings: Worker_Binding[] = workflows.map(
      (workflow, index) => ({
        name: `WORKFLOW_${index}`,
        wrapped: {
          moduleName: "cloudflare-runtime:workflows-wrapped-binding",
          innerBindings: [
            {
              name: "binding",
              service: {
                name: `workflows:${workflow.workflowName}`,
                entrypoint: "WorkflowBinding",
              },
            },
          ],
        },
      }),
    );
    const email = prepareExplorerEmail(
      worker.name,
      storage,
      resolvedBindings,
      loopbackBinding,
      emailStore,
      sendEmail,
    );
    const jsonBinding = (name: string, value: unknown): Worker_Binding => ({
      name,
      json: JSON.stringify(value),
    });
    return {
      durableObjectWrapper,
      bindings: email.userBindings,
      services: [
        ...email.services,
        {
          name: LOCAL_EXPLORER_PUBLIC_SERVICE,
          worker: {
            compatibilityDate: "2026-01-01",
            modules: [
              {
                name: "public.js",
                esModule: `
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    // Keep API requests on the internal adapter. Redirecting multipart writes
    // can cause clients to regenerate a body with the old boundary header.
    if (url.pathname.startsWith("/cdn-cgi/local/explorer/api/")) return env.EXPLORER.fetch(request);
    for (const prefix of ["/cdn-cgi/local/explorer", "/cdn-cgi/explorer"]) {
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        const target = new URL(env.URL);
        target.pathname = "/cdn-cgi/local/explorer" + url.pathname.slice(prefix.length);
        target.search = url.search;
        return Response.redirect(target, 307);
      }
    }
    if (url.pathname === "/cdn-cgi/handler/email" || url.pathname === "/cdn-cgi/local/email") return env.EXPLORER.fetch(request);
    return env.UPSTREAM.fetch(request);
  }
};`,
              },
            ],
            bindings: [
              { name: "URL", text: explorerUrl },
              { name: "EXPLORER", service: { name: LOCAL_EXPLORER_SERVICE } },
              { name: "UPSTREAM", service: { name: upstream } },
            ],
          },
        },
        {
          name: "local-explorer:loopback",
          worker: {
            compatibilityDate: "2026-01-01",
            modules: [
              { name: "loopback.js", esModule: explorerWorkflowLoopback },
            ],
            bindings: [
              { name: "LOOPBACK", service: loopbackBinding },
              jsonBinding("WORKFLOWS", workflowMap),
              ...engineBindings,
            ],
          },
        },
        ...(collector
          ? [
              {
                name: LOCAL_EXPLORER_COLLECTOR,
                worker: {
                  compatibilityDate: "2026-01-01",
                  modules: [
                    { name: "collector-bridge.js", esModule: collectorBridge },
                  ],
                  bindings: [
                    { name: "DEBUG", workerdDebugPort: kVoid },
                    { name: "LOOPBACK", service: loopbackBinding },
                  ],
                },
              } satisfies Service,
            ]
          : []),
        {
          // Miniflare's existing aggregation protocol resolves this service over
          // the debug port. Only peers sharing this storage scope are advertised.
          name: "core:entry",
          worker: {
            compatibilityDate: "2026-01-01",
            modules: [
              {
                name: "entry.js",
                esModule:
                  "export default { fetch(request, env) { if (new URL(request.url).pathname === '/_alchemy/explorer/health') return Response.json({ id: env.ID }); return env.EXPLORER.fetch(request); } };",
              },
            ],
            bindings: [
              { name: "ID", text: instanceId },
              { name: "EXPLORER", service: { name: LOCAL_EXPLORER_SERVICE } },
            ],
          },
        },
        ...[
          { name: "local-explorer:d1", resources: d1Map, bindings: d1Bindings },
          { name: "local-explorer:r2", resources: r2Map, bindings: r2Bindings },
          { name: "local-explorer:kv", resources: kvMap, bindings: kvBindings },
        ].map(({ name, resources, bindings }) => ({
          name,
          worker: {
            compatibilityDate: "2026-01-01",
            modules: [{ name: "storage-router.js", esModule: storageRouter }],
            bindings: [
              jsonBinding(
                "RESOURCES",
                Object.fromEntries(
                  bindings.map((binding) => {
                    const props = JSON.parse(
                      "service" in binding
                        ? (binding.service?.props?.json ?? "{}")
                        : "{}",
                    );
                    return [
                      props.databaseId ?? props.bucketName ?? props.namespaceId,
                      binding.name,
                    ];
                  }),
                ),
              ),
              ...bindings,
            ],
          },
        })),
        {
          name: "local-explorer:assets",
          disk: {
            path: path.resolve(miniflareDist, "../local-explorer-ui"),
            writable: false,
          },
        },
        {
          name: LOCAL_EXPLORER_SERVICE,
          worker: {
            compatibilityDate: "2026-01-01",
            compatibilityFlags: ["nodejs_compat"],
            modules: [
              { name: "router.worker.js", esModule: router },
              {
                name: "explorer.worker.js",
                esModule: backend + "\nexport { handleEmail };",
              },
            ],
            bindings: [
              { name: "UPSTREAM", service: { name: upstream } },
              { name: "DEV_REGISTRY_DEBUG_PORT", workerdDebugPort: kVoid },
              { name: "MINIFLARE_D1", service: { name: "local-explorer:d1" } },
              { name: "MINIFLARE_KV", service: { name: "local-explorer:kv" } },
              { name: "MINIFLARE_R2", service: { name: "local-explorer:r2" } },
              ...(collector
                ? [
                    {
                      name: "MINIFLARE_OBSERVABILITY_COLLECTOR",
                      service: { name: LOCAL_EXPLORER_COLLECTOR },
                    },
                  ]
                : []),
              {
                name: "MINIFLARE_LOOPBACK",
                service: { name: "local-explorer:loopback" },
              },
              {
                name: "MINIFLARE_EMAIL_STORE",
                service: { name: "email:store" },
              },
              {
                name: `MINIFLARE_EXPLORER_USER_WORKER_${worker.name}`,
                service: { name: SERVICE_USER_WORKER },
              },
              {
                name: "MINIFLARE_EXPLORER_DISK",
                service: { name: "local-explorer:assets" },
              },
              jsonBinding("MINIFLARE_TELEMETRY_CONFIG", { enabled: false }),
              jsonBinding("LOCAL_EXPLORER_WORKER_NAMES", [worker.name]),
              jsonBinding("LOCAL_EXPLORER_BINDING_MAP", {
                workflows: workflowMap,
                d1: d1Map,
                kv: kvMap,
                r2: r2Map,
                do: doMap,
              }),
              jsonBinding("MINIFLARE_EXPLORER_WORKER_OPTS", {
                [worker.name]: {
                  d1: Object.entries(d1Map).map(([id, bindingName]) => ({
                    id,
                    bindingName,
                  })),
                  r2: Object.entries(r2Map).map(([id, bindingName]) => ({
                    id,
                    bindingName,
                  })),
                  kv: Object.entries(kvMap).map(([id, bindingName]) => ({
                    id,
                    bindingName,
                  })),
                  do: Object.entries(doMap).map(([id, ns]) => ({
                    id,
                    className: ns.className,
                    scriptName: ns.scriptName,
                    useSqlite: ns.useSQLite,
                    bindingName:
                      resolvedBindings.find(
                        (binding) =>
                          "durableObjectNamespace" in binding &&
                          !binding.durableObjectNamespace?.serviceName &&
                          binding.durableObjectNamespace?.className ===
                            ns.className,
                      )?.name ?? ns.className,
                  })),
                  sendEmail: email.sendEmail,
                  workflows: workflows.map((workflow) => ({
                    id: workflow.workflowName,
                    bindingName: workflow.className,
                    className: workflow.className,
                    scriptName: worker.name,
                  })),
                },
              }),
              ...engineBindings,
              ...workflowBindings,
              ...doBindings,
            ],
          },
        },
      ] satisfies Service[],
      extensions: [
        { modules: [{ name: "miniflare:shared", esModule: shared }] },
      ],
    };
  },
);
