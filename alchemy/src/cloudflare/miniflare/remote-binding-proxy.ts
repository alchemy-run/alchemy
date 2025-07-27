import type { RemoteProxyConnectionString } from "miniflare";
import { HTTPServer } from "../../util/http.ts";
import { extractCloudflareResult } from "../api-response.ts";
import { createCloudflareApi, type CloudflareApi } from "../api.ts";
import type { WorkerBindingSpec } from "../bindings.ts";
import { getInternalWorkerBundle } from "../bundle/internal-worker-bundle.ts";
import { WorkerBundle } from "../worker-bundle.ts";
import type { WorkerMetadata } from "../worker-metadata.ts";

type WranglerSessionConfig =
  | {
      workers_dev: boolean;
      minimal_mode: boolean;
    }
  | {
      routes: string[];
      minimal_mode: boolean;
    };

interface WorkersPreviewSession {
  inspector_websocket: string;
  prewarm: string;
  token: string;
}

export interface RemoteBindingProxy {
  server: HTTPServer;
  bindings: WorkerBindingSpec[];
  connectionString: RemoteProxyConnectionString;
}

export async function createRemoteProxyWorker(input: {
  name: string;
  bindings: WorkerBindingSpec[];
}) {
  const api = await createCloudflareApi();
  const script = await getInternalWorkerBundle("remote-binding-proxy");
  const [token, subdomain] = await Promise.all([
    createWorkersPreviewToken(api, {
      name: input.name,
      metadata: {
        main_module: script.bundle.entrypoint,
        compatibility_date: "2025-06-16",
        bindings: input.bindings,
        observability: {
          enabled: false,
        },
      },
      bundle: script.bundle,
      session: {
        workers_dev: true,
        minimal_mode: true,
      },
    }),
    import("../worker-subdomain.ts").then((m) => m.getAccountSubdomain(api)),
  ]);

  const proxyURL = new URL(`https://${input.name}.${subdomain}.workers.dev`);
  const server = new HTTPServer({
    fetch: async (req) => {
      const origin = new URL(req.url);
      const url = new URL(origin.pathname, proxyURL.toString());
      url.search = origin.search;
      url.hash = origin.hash;

      const requestHeaders = new Headers(req.headers);
      requestHeaders.set("cf-workers-preview-token", token);
      requestHeaders.set("host", proxyURL.hostname);
      requestHeaders.delete("cf-connecting-ip");

      const res = await fetch(url, {
        method: req.method,
        headers: requestHeaders,
        body: req.body,
        redirect: "manual",
      });

      // Remove headers that are not supported by miniflare
      const responseHeaders = new Headers(res.headers);
      responseHeaders.delete("transfer-encoding");
      responseHeaders.delete("content-encoding");

      return new Response(res.body, {
        status: res.status,
        headers: responseHeaders,
      });
    },
  });
  await server.listen();
  return {
    server,
    bindings: input.bindings,
    connectionString: new URL(server.url) as RemoteProxyConnectionString,
  };
}

async function createWorkersPreviewToken(
  api: CloudflareApi,
  input: {
    name: string;
    metadata: WorkerMetadata;
    bundle: WorkerBundle;
    session: WranglerSessionConfig;
  },
) {
  const session = await createWorkersPreviewSession(api);
  const formData = await WorkerBundle.toFormData(input.bundle);
  formData.append("metadata", JSON.stringify(input.metadata));
  formData.append("wrangler-session-config", JSON.stringify(input.session));
  const res = await extractCloudflareResult<{ preview_token: string }>(
    "create workers preview token",
    api.post(
      `/accounts/${api.accountId}/workers/scripts/${input.name}/edge-preview`,
      formData,
      {
        headers: {
          "cf-preview-upload-config-token": session.token,
        },
      },
    ),
  );
  // Fire and forget prewarm call
  // (see https://github.com/cloudflare/workers-sdk/blob/6c6afbd6072b96e78e67d3a863ed849c6aa49472/packages/wrangler/src/dev/create-worker-preview.ts#L338)
  void prewarm(session.prewarm, res.preview_token);
  return res.preview_token;
}

async function prewarm(url: string, previewToken: string) {
  const res = await fetch(url, {
    headers: {
      "cf-workers-preview-token": previewToken,
    },
  });
  if (!res.ok) {
    console.error(`Failed to prewarm worker: ${res.status} ${res.statusText}`);
  }
}

async function createWorkersPreviewSession(api: CloudflareApi) {
  const { exchange_url } = await extractCloudflareResult<{
    exchange_url: string;
    token: string;
  }>(
    "create workers preview session",
    api.get(`/accounts/${api.accountId}/workers/subdomain/edge-preview`),
  );
  const res = await fetch(exchange_url);
  if (!res.ok) {
    throw new Error(
      `Failed to create workers preview session: ${res.status} ${res.statusText}`,
    );
  }
  const json: WorkersPreviewSession = await res.json();
  return json;
}
