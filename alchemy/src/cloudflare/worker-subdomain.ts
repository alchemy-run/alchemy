import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";
import type { CloudflareApiResponse } from "./types.ts";
import { getAccountSubdomain } from "./worker/shared.ts";

interface WorkerSubdomainProps extends CloudflareApiOptions {
  /**
   * The name of the script to create a subdomain for.
   */
  scriptName: string;
  /**
   * The version ID of the worker, if versioning is enabled and the worker is a preview.
   *
   * @default undefined
   */
  previewVersionId?: string;
  /**
   * Prevents the subdomain from being deleted when the worker is deleted.
   *
   * @default false
   */
  retain?: boolean;
}

export interface WorkerSubdomain
  extends Resource<"cloudflare::WorkerSubdomain"> {
  /**
   * The `workers.dev` URL for the worker or preview version.
   */
  url: string;
}

export const WorkerSubdomain = Resource(
  "cloudflare::WorkerSubdomain",
  async function (
    this: Context<WorkerSubdomain>,
    id: string,
    props: WorkerSubdomainProps,
  ) {
    const api = await createCloudflareApi(props);
    if (this.phase === "delete") {
      if (!props.retain) {
        await disableWorkerSubdomain(api, props.scriptName);
      }
      return this.destroy();
    }
    await wrapFetch<SubdomainResponse>(
      `enable subdomain for "${props.scriptName}"`,
      api.post(
        `/accounts/${api.accountId}/workers/scripts/${props.scriptName}/subdomain`,
        { enabled: true, previews_enabled: true },
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const subdomain = await getAccountSubdomain(api);
    const base = `${subdomain}.workers.dev`;
    let url: string;
    if (props.previewVersionId) {
      url = `https://${props.previewVersionId.substring(0, 8)}-${props.scriptName}.${base}`;
    } else {
      url = `https://${props.scriptName}.${base}`;
    }
    return this(id, {
      url,
    });
  },
);

export async function disableWorkerSubdomain(
  api: CloudflareApi,
  scriptName: string,
) {
  await wrapFetch<SubdomainResponse>(
    `disable subdomain for "${scriptName}"`,
    api.post(
      `/accounts/${api.accountId}/workers/scripts/${scriptName}/subdomain`,
      { enabled: false },
    ),
  ).catch((error) => {
    if (error.status === 404) {
      return;
    }
    throw error;
  });
}

interface SubdomainResponse {
  enabled: boolean;
  previews_enabled: boolean;
}

async function wrapFetch<T>(
  label: string,
  promise: Promise<Response>,
): Promise<T> {
  const response = await promise.catch(() => {
    throw new Error(`Failed to ${label}: Failed to fetch`);
  });
  const json = (await response.json().catch(() => {
    throw new Error(
      `Failed to ${label} (${response.status}): The API returned an invalid response`,
    );
  })) as CloudflareApiResponse<T>;
  if (json.success) {
    return json.result;
  } else {
    const error = new Error(
      `Failed to ${label} (${response.status}): ${json.errors.map((e) => `${e.code}: ${e.message}`).join(", ")}`,
    );
    Error.captureStackTrace(error, wrapFetch);
    Object.assign(error, {
      status: response.status,
    });
    throw error;
  }
}
