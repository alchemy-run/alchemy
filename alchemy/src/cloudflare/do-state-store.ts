import { alchemy } from "../alchemy.ts";
import type { Scope } from "../scope.ts";
import type { Secret } from "../secret.ts";
import { StateStoreProxy } from "../sqlite/proxy.ts";
import { logger } from "../util/logger.ts";
import { memoize } from "../util/memoize.ts";
import type { CloudflareApiOptions } from "./api.ts";
import { createCloudflareApi } from "./api.ts";
import {
  enableWorkerSubdomain,
  getAccountSubdomain,
} from "./worker-subdomain.ts";
import {
  getTemplateWorkerStatus,
  pollUntilReady,
  provisionTemplateWorker,
} from "./worker/shared.ts";

export interface DOStateStoreOptions extends CloudflareApiOptions {
  /**
   * The name of the script to use for the state store.
   * @default "alchemy-state-sqlite"
   */
  scriptName?: string;
  /**
   * Whether to force the worker to be updated.
   * This may be useful if you've lost the token for the state store and need to overwrite it.
   * @default false
   */
  forceUpdate?: boolean;
  /**
   * The token to use for the state store.
   * @default process.env.ALCHEMY_STATE_TOKEN
   * @note You must use the same token for all deployments on your Cloudflare account.
   */
  stateToken?: Secret<string>;
}

const TEMPLATE_WORKER_NAME = "do-sqlite-state-store" as const;

/**
 * A state store backed by a SQLite database in a Cloudflare Durable Object.
 *
 * @see {@link https://alchemy.run/guides/do-state-store DOStateStore}
 */
export class DOStateStore extends StateStoreProxy {
  constructor(
    scope: Scope,
    private readonly options: DOStateStoreOptions = {},
  ) {
    super(scope);
  }

  async provision(): Promise<StateStoreProxy.Dispatch> {
    const { url, token } = await provision(this.options);
    return async (method, params) => {
      const request: StateStoreProxy.Request<
        typeof method,
        { chain: string[] }
      > = {
        method,
        params,
        context: { chain: this.scope.chain },
      };
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
      if (!response.headers.get("Content-Type")?.includes("application/json")) {
        throw new Error(
          `[DOStateStore] "${method}" request failed with status ${response.status}: Expected JSON response, but got ${response.headers.get("Content-Type")}`,
        );
      }
      const json = (await response.json()) as StateStoreProxy.Response<
        typeof method
      >;
      if (!json.success) {
        throw new Error(
          `[DOStateStore] "${method}" request failed with status ${response.status}: ${json.error}`,
        );
      }
      return json.result;
    };
  }
}

const provision = memoize(async (options: DOStateStoreOptions) => {
  const scriptName = options.scriptName ?? "alchemy-state-sqlite";
  const tokenSecret =
    options.stateToken ??
    (await alchemy.secret.env(
      "ALCHEMY_STATE_TOKEN",
      undefined,
      "Missing token for DOStateStore. Please set ALCHEMY_STATE_TOKEN in the environment or set the `stateToken` option in the DOStateStore constructor.",
    ));
  const token = tokenSecret.unencrypted;

  const api = await createCloudflareApi(options);
  const { created, updated, enabled } = await getTemplateWorkerStatus(
    api,
    scriptName,
    TEMPLATE_WORKER_NAME,
  );
  if (!updated || options.forceUpdate) {
    logger.log(`[DOStateStore] ${created ? "Updating" : "Creating"}...`);
    await provisionTemplateWorker(api, {
      name: scriptName,
      template: TEMPLATE_WORKER_NAME,
      metadata: {
        bindings: [
          {
            name: "STORE",
            type: "durable_object_namespace",
            class_name: "Store",
          },
          {
            name: "STATE_TOKEN",
            type: "secret_text",
            text: token,
          },
        ],
        migrations: created
          ? undefined
          : {
              new_sqlite_classes: ["Store"],
            },
      },
    });
  }
  if (!enabled) {
    await enableWorkerSubdomain(api, scriptName);
  }
  const url = `https://${scriptName}.${await getAccountSubdomain(api)}.workers.dev`;
  await pollUntilReady("DOStateStore", () =>
    fetch(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  return { url, token };
});
