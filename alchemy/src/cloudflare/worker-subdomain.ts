import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { createCloudflareApi, type CloudflareApiOptions } from "./api.ts";
import { getAccountSubdomain } from "./worker/shared.ts";

interface WorkerSubdomainProps extends CloudflareApiOptions {
  scriptName: string;
  versionId?: string;
}

interface WorkerSubdomain extends Resource<"cloudflare::WorkerSubdomain"> {
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
      await api.post(
        `/accounts/${api.accountId}/workers/scripts/${props.scriptName}/subdomain`,
        { enabled: false },
        {
          headers: { "Content-Type": "application/json" },
        },
      );
      return this.destroy();
    }
    await api.post(
      `/accounts/${api.accountId}/workers/scripts/${props.scriptName}/subdomain`,
      { enabled: true, previews_enabled: true },
      {
        headers: { "Content-Type": "application/json" },
      },
    );
    const subdomain = await getAccountSubdomain(api);
    const base = `${subdomain}.workers.dev`;
    let url: string;
    if (props.versionId) {
      url = `https://${props.versionId.substring(0, 8)}-${props.scriptName}.${base}`;
    } else {
      url = `https://${props.scriptName}.${base}`;
    }
    return this(id, {
      url,
    });
  },
);
