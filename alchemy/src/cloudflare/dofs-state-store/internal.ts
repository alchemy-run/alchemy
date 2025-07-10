import { withExponentialBackoff } from "../../util/retry.ts";
import { handleApiError } from "../api-error.ts";
import type { CloudflareApi } from "../api.ts";
import type { WorkerMetadata } from "../worker-metadata.ts";
import { getWorkerTemplate, pollUntilReady } from "../worker/shared.ts";
import type { DOFSStateStoreAPI } from "./types.ts";

interface DOFSStateStoreClientOptions {
  app: string;
  stage: string;
  url: string;
  token: string;
}

class StateStoreError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class DOFSStateStoreClient {
  constructor(private readonly options: DOFSStateStoreClientOptions) {}

  async rpc<T extends keyof DOFSStateStoreAPI.API>(
    method: T,
    params: DOFSStateStoreAPI.API[T]["params"],
  ): Promise<DOFSStateStoreAPI.API[T]["result"]> {
    return await withExponentialBackoff(
      async () => {
        const res = await this.fetch("/rpc", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            method,
            params,
          }),
        });
        if (!res.headers.get("Content-Type")?.includes("application/json")) {
          throw new StateStoreError(
            `Unexpected response of type "${res.headers.get("Content-Type")}" from state store: ${res.status} ${res.statusText} ${await res.text()}`,
            true,
          );
        }
        const body = await res.json<DOFSStateStoreAPI.Response>();
        if (!body.success) {
          throw new StateStoreError(
            `State store "${method}" request failed with status ${res.status}: ${body.error}`,
            res.status >= 500,
          );
        }
        return body.result;
      },
      (error) => {
        if (error instanceof StateStoreError) {
          return error.retryable;
        }
        return true;
      },
      5,
      500,
    );
  }

  async validate(): Promise<Response> {
    return await this.fetch("/rpc", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        method: "validate",
        params: null,
      }),
    });
  }

  async waitUntilReady(): Promise<void> {
    await pollUntilReady("DOFSStateStore", () => this.validate());
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.options.url);
    url.searchParams.set("app", this.options.app);
    url.searchParams.set("stage", this.options.stage);
    return await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...init.headers,
      },
    });
  }
}

const TAG = "alchemy-state-store:2025-06-23";

const cache = new Map<string, string>();

export async function upsertStateStoreWorker(
  api: CloudflareApi,
  workerName: string,
  token: string,
  force: boolean,
) {
  const key = `worker:${workerName}`;
  const cached = cache.get(key);
  if (cached === TAG) {
    return;
  }
  const { found, tag } = await getWorkerStatus(api, workerName);
  if (found && tag === TAG && !force) {
    cache.set(key, TAG);
    return;
  }
  const formData = new FormData();
  const worker = await getWorkerTemplate("dofs-state-store");
  worker.files.forEach((file) => {
    formData.append(file.name, file);
  });
  formData.append(
    "metadata",
    new Blob([
      JSON.stringify({
        main_module: worker.entrypoint,
        compatibility_date: "2025-06-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [
          {
            name: "DOFS_STATE_STORE",
            type: "durable_object_namespace",
            class_name: "DOFSStateStore",
          },
          {
            name: "DOFS_TOKEN",
            type: "secret_text",
            text: token,
          },
        ],
        migrations: !found
          ? {
              new_sqlite_classes: ["DOFSStateStore"],
            }
          : undefined,
        tags: [TAG],
        observability: {
          enabled: true,
        },
      } satisfies WorkerMetadata),
    ]),
  );

  // Put the worker with migration tag v1
  const response = await api.put(
    `/accounts/${api.accountId}/workers/scripts/${workerName}`,
    formData,
  );
  if (!response.ok) {
    throw await handleApiError(response, "upload", "worker", workerName);
  }

  const subdomainRes = await api.post(
    `/accounts/${api.accountId}/workers/scripts/${workerName}/subdomain`,
    { enabled: true, preview_enabled: false },
    {
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!subdomainRes.ok) {
    throw await handleApiError(
      subdomainRes,
      "creating worker subdomain",
      "worker",
      workerName,
    );
  }
  cache.set(key, TAG);
}

async function getWorkerStatus(api: CloudflareApi, workerName: string) {
  const res = await api.get(
    `/accounts/${api.accountId}/workers/scripts/${workerName}/settings`,
  );
  if (!res.ok) {
    return {
      found: false,
      tag: undefined,
    };
  }
  const json: {
    result: {
      tags: string[];
    };
  } = await res.json();
  return {
    found: true,
    tag: json.result.tags.find((tag) => tag.startsWith("alchemy-state-store:")),
  };
}
