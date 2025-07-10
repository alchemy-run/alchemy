import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_DATE } from "../../build-date.ts";
import { logger } from "../../util/logger.ts";
import { memoize } from "../../util/memoize.ts";
import type { CloudflareApi } from "../api.ts";
import { FSBundleProvider } from "../bundle/fs.ts";
import { extractCloudflareResult } from "../types.ts";
import type { WorkerMetadata } from "../worker-metadata.ts";

type WorkerTemplate =
  | "dofs-state-store"
  | "do-sqlite-state-store"
  | "mixed-mode-proxy-worker";

export const getWorkerTemplate = memoize(async (name: WorkerTemplate) => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const provider = new FSBundleProvider({
    cwd: join(dir, "..", "..", "..", "workers"),
    entrypoint: `${name}.js`,
    globs: undefined,
    sourcemaps: false,
    format: "esm",
    nodeCompat: null,
  });
  return provider.create(false).then((bundle) => ({
    ...bundle,
    tag: `${name}:${bundle.hash}`,
  }));
});

export async function getTemplateWorkerStatus(
  api: CloudflareApi,
  name: string,
  template: WorkerTemplate,
) {
  const { getWorkerSettings } = await import("../worker-metadata.ts");
  const { getWorkerSubdomain } = await import("../worker-subdomain.ts");
  const worker = await getWorkerTemplate(template);
  const [settings, subdomain] = await Promise.all([
    getWorkerSettings(api, name),
    getWorkerSubdomain(api, name),
  ]);
  return {
    created: !!settings,
    updated: settings?.tags.includes(worker.tag) ?? false,
    enabled: subdomain.enabled,
  };
}

interface ProvisionTemplateWorkerProps {
  name: string;
  template: WorkerTemplate;
  metadata: Partial<WorkerMetadata>;
}

export async function provisionTemplateWorker(
  api: CloudflareApi,
  props: ProvisionTemplateWorkerProps,
) {
  const worker = await getWorkerTemplate(props.template);
  const formData = new FormData();
  worker.files.forEach((file) => {
    formData.append(file.name, file);
  });
  const metadata: WorkerMetadata = {
    ...props.metadata,
    main_module: worker.entrypoint,
    tags: [worker.tag],
    compatibility_date: BUILD_DATE,
    observability: {
      enabled: true,
    },
    bindings: props.metadata.bindings ?? [],
  };
  formData.append("metadata", new Blob([JSON.stringify(metadata)]));
  await extractCloudflareResult(
    `provision ${props.template} worker ${props.name}`,
    api.put(
      `/accounts/${api.accountId}/workers/scripts/${props.name}`,
      formData,
    ),
  );
}

export async function pollUntilReady(
  label: string,
  fn: () => Promise<Response>,
) {
  // This ensures the token is correct and the worker is ready to use.
  let last: Response | undefined;
  let delay = 1000;
  for (let i = 0; i < 20; i++) {
    const res = await fn();
    if (res.ok) {
      return;
    }
    if (res.status === 401) {
      throw new Error(
        `[${label}] The token is invalid. Please check your ALCHEMY_STATE_TOKEN environment variable, or set "forceUpdate: true" in the ${label} constructor to overwrite the current token.`,
      );
    }
    if (!last) {
      logger.log(`[${label}] Waiting for deployment...`);
    }
    last = res;
    // Exponential backoff with jitter
    const jitter = Math.random() * 0.1 * delay;
    await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    delay *= 1.5; // Increase the delay for next attempt
    delay = Math.min(delay, 10000); // Cap at 10 seconds
  }
  throw new Error(
    `[${label}] Failed to reach state store: ${last?.status} ${last?.statusText}`,
  );
}
