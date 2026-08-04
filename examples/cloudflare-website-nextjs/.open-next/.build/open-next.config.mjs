import { createRequire as topLevelCreateRequire } from 'module';const require = topLevelCreateRequire(import.meta.url);import bannerUrl from 'url';const __dirname = bannerUrl.fileURLToPath(new URL('.', import.meta.url));

// ../../node_modules/.bun/@opennextjs+cloudflare@1.20.1+afb1e91d6e182267/node_modules/@opennextjs/cloudflare/dist/api/cloudflare-context.js
var cloudflareContextSymbol = Symbol.for("__cloudflare-context__");
function getCloudflareContext(options = { async: false }) {
  return options.async ? getCloudflareContextAsync() : getCloudflareContextSync();
}
function getCloudflareContextFromGlobalScope() {
  const global = globalThis;
  return global[cloudflareContextSymbol];
}
function inSSG() {
  const global = globalThis;
  return global.__NEXT_DATA__?.nextExport === true;
}
function getCloudflareContextSync() {
  const cloudflareContext = getCloudflareContextFromGlobalScope();
  if (cloudflareContext) {
    return cloudflareContext;
  }
  if (inSSG()) {
    throw new Error(`

ERROR: \`getCloudflareContext\` has been called in sync mode in either a static route or at the top level of a non-static one, both cases are not allowed but can be solved by either:
  - make sure that the call is not at the top level and that the route is not static
  - call \`getCloudflareContext({async: true})\` to use the \`async\` mode
  - avoid calling \`getCloudflareContext\` in the route
`);
  }
  throw new Error(initOpenNextCloudflareForDevErrorMsg);
}
async function getCloudflareContextAsync() {
  const cloudflareContext = getCloudflareContextFromGlobalScope();
  if (cloudflareContext) {
    return cloudflareContext;
  }
  const inNodejsRuntime = process.env.NEXT_RUNTIME === "nodejs";
  if (inNodejsRuntime || inSSG()) {
    const cloudflareContext2 = await getCloudflareContextFromWrangler();
    addCloudflareContextToNodejsGlobal(cloudflareContext2);
    return cloudflareContext2;
  }
  throw new Error(initOpenNextCloudflareForDevErrorMsg);
}
function addCloudflareContextToNodejsGlobal(cloudflareContext) {
  const global = globalThis;
  global[cloudflareContextSymbol] = cloudflareContext;
}
async function getCloudflareContextFromWrangler(options) {
  const { getPlatformProxy } = await import(
    /* webpackIgnore: true */
    `${"__wrangler".replaceAll("_", "")}`
  );
  const environment = options?.environment ?? process.env.NEXT_DEV_WRANGLER_ENV;
  const { env, cf, ctx } = await getPlatformProxy({
    ...options,
    // The `env` passed to the fetch handler does not contain variables from `.env*` files.
    // because we invoke wrangler with `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV`=`"false"`.
    // Initializing `envFiles` with an empty list is the equivalent for this API call.
    envFiles: [],
    environment
  });
  return {
    env,
    cf,
    ctx
  };
}
var initOpenNextCloudflareForDevErrorMsg = `

ERROR: \`getCloudflareContext\` has been called without having called \`initOpenNextCloudflareForDev\` from the Next.js config file.
You should update your Next.js config file as shown below:

   \`\`\`
   // next.config.mjs

   import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

   initOpenNextCloudflareForDev();

   const nextConfig = { ... };
   export default nextConfig;
   \`\`\`

`;

// ../../node_modules/.bun/@opennextjs+cloudflare@1.20.1+afb1e91d6e182267/node_modules/@opennextjs/cloudflare/dist/api/overrides/asset-resolver/index.js
var resolver = {
  name: "cloudflare-asset-resolver",
  async maybeGetAssetResult(event) {
    const { ASSETS } = getCloudflareContext().env;
    if (!ASSETS || !isUserWorkerFirst(globalThis.__ASSETS_RUN_WORKER_FIRST__, event.rawPath)) {
      return void 0;
    }
    const { method, headers } = event;
    if (method !== "GET" && method != "HEAD") {
      return void 0;
    }
    const url = new URL(event.rawPath, "https://assets.local");
    const response = await ASSETS.fetch(url, {
      headers,
      method
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return void 0;
    }
    return {
      type: "core",
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: getResponseBody(method, response),
      isBase64Encoded: false
    };
  }
};
function getResponseBody(method, response) {
  if (method === "HEAD") {
    return null;
  }
  return response.body || new ReadableStream();
}
function isUserWorkerFirst(runWorkerFirst, pathname) {
  if (!Array.isArray(runWorkerFirst)) {
    return runWorkerFirst ?? false;
  }
  let hasPositiveMatch = false;
  for (let rule of runWorkerFirst) {
    let isPositiveRule = true;
    if (rule.startsWith("!")) {
      rule = rule.slice(1);
      isPositiveRule = false;
    } else if (hasPositiveMatch) {
      continue;
    }
    const match = new RegExp(`^${rule.replace(/([[\]().*+?^$|{}\\])/g, "\\$1").replace("\\*", ".*")}$`).test(pathname);
    if (match) {
      if (isPositiveRule) {
        hasPositiveMatch = true;
      } else {
        return false;
      }
    }
  }
  return hasPositiveMatch;
}
var asset_resolver_default = resolver;

// ../../node_modules/.bun/@opennextjs+cloudflare@1.20.1+afb1e91d6e182267/node_modules/@opennextjs/cloudflare/dist/api/config.js
function defineCloudflareConfig(config = {}) {
  const { incrementalCache, tagCache, queue, cachePurge, enableCacheInterception = false, routePreloadingBehavior = "none" } = config;
  return {
    default: {
      override: {
        wrapper: "cloudflare-node",
        converter: "edge",
        proxyExternalRequest: "fetch",
        incrementalCache: resolveIncrementalCache(incrementalCache),
        tagCache: resolveTagCache(tagCache),
        queue: resolveQueue(queue),
        cdnInvalidation: resolveCdnInvalidation(cachePurge)
      },
      routePreloadingBehavior
    },
    // node:crypto is used to compute cache keys
    edgeExternals: ["node:crypto"],
    cloudflare: {
      useWorkerdCondition: true
    },
    dangerous: {
      enableCacheInterception
    },
    middleware: {
      external: true,
      override: {
        wrapper: "cloudflare-edge",
        converter: "edge",
        proxyExternalRequest: "fetch",
        incrementalCache: resolveIncrementalCache(incrementalCache),
        tagCache: resolveTagCache(tagCache),
        queue: resolveQueue(queue)
      },
      assetResolver: () => asset_resolver_default
    }
  };
}
function resolveIncrementalCache(value = "dummy") {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "function" ? value : () => value;
}
function resolveTagCache(value = "dummy") {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "function" ? value : () => value;
}
function resolveQueue(value = "dummy") {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "function" ? value : () => value;
}
function resolveCdnInvalidation(value = "dummy") {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "function" ? value : () => value;
}

// ../../node_modules/.bun/@opennextjs+aws@4.0.2+94efd628ca815546/node_modules/@opennextjs/aws/dist/utils/error.js
var IgnorableError = class extends Error {
  __openNextInternal = true;
  canIgnore = true;
  logLevel = 0;
  constructor(message) {
    super(message);
    this.name = "IgnorableError";
  }
};
function isOpenNextError(e) {
  try {
    return "__openNextInternal" in e;
  } catch {
    return false;
  }
}

// ../../node_modules/.bun/@opennextjs+aws@4.0.2+94efd628ca815546/node_modules/@opennextjs/aws/dist/adapters/logger.js
function debug(...args) {
  if (globalThis.openNextDebug) {
    console.log(...args);
  }
}
function warn(...args) {
  console.warn(...args);
}
var DOWNPLAYED_ERROR_LOGS = [
  {
    clientName: "S3Client",
    commandName: "GetObjectCommand",
    errorName: "NoSuchKey"
  }
];
var isDownplayedErrorLog = (errorLog) => DOWNPLAYED_ERROR_LOGS.some((downplayedInput) => downplayedInput.clientName === errorLog?.clientName && downplayedInput.commandName === errorLog?.commandName && (downplayedInput.errorName === errorLog?.error?.name || downplayedInput.errorName === errorLog?.error?.Code));
function error(...args) {
  if (args.some((arg) => isDownplayedErrorLog(arg))) {
    return debug(...args);
  }
  if (args.some((arg) => isOpenNextError(arg))) {
    const error2 = args.find((arg) => isOpenNextError(arg));
    if (error2.logLevel < getOpenNextErrorLogLevel()) {
      return;
    }
    if (error2.logLevel === 0) {
      return console.log(...args.map((arg) => isOpenNextError(arg) ? `${arg.name}: ${arg.message}` : arg));
    }
    if (error2.logLevel === 1) {
      return warn(...args.map((arg) => isOpenNextError(arg) ? `${arg.name}: ${arg.message}` : arg));
    }
    return console.error(...args);
  }
  console.error(...args);
}
function getOpenNextErrorLogLevel() {
  const strLevel = process.env.OPEN_NEXT_ERROR_LOG_LEVEL ?? "1";
  switch (strLevel.toLowerCase()) {
    case "debug":
    case "0":
      return 0;
    case "error":
    case "2":
      return 2;
    default:
      return 1;
  }
}

// ../../node_modules/.bun/@opennextjs+cloudflare@1.20.1+afb1e91d6e182267/node_modules/@opennextjs/cloudflare/dist/api/overrides/internal.js
var debugCache = (name, ...args) => {
  if (process.env.NEXT_PRIVATE_DEBUG_CACHE) {
    console.log(`[${name}] `, ...args);
  }
};
var FALLBACK_BUILD_ID = "no-build-id";

// ../../node_modules/.bun/@opennextjs+cloudflare@1.20.1+afb1e91d6e182267/node_modules/@opennextjs/cloudflare/dist/api/overrides/incremental-cache/static-assets-incremental-cache.js
var CACHE_DIR = "cdn-cgi/_next_cache";
var NAME = "cf-static-assets-incremental-cache";
var StaticAssetsIncrementalCache = class {
  name = NAME;
  async get(key, cacheType) {
    const assets = getCloudflareContext().env.ASSETS;
    if (!assets)
      throw new IgnorableError("No Static Assets");
    debugCache("StaticAssetsIncrementalCache", `get ${key}`);
    try {
      const response = await assets.fetch(this.getAssetUrl(key, cacheType));
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return {
        value: await response.json(),
        lastModified: globalThis.__BUILD_TIMESTAMP_MS__
      };
    } catch (e) {
      error("Failed to get from cache", e);
      return null;
    }
  }
  async set(key, _value, cacheType) {
    error(`StaticAssetsIncrementalCache: Failed to set to read-only cache key=${key} type=${cacheType}`);
  }
  async delete() {
    error("StaticAssetsIncrementalCache: Failed to delete from read-only cache");
  }
  getAssetUrl(key, cacheType) {
    if (cacheType === "composable") {
      throw new Error("Composable cache is not supported in static assets incremental cache");
    }
    const buildId = process.env.OPEN_NEXT_BUILD_ID ?? FALLBACK_BUILD_ID;
    const name = (cacheType === "fetch" ? `${CACHE_DIR}/__fetch/${buildId}/${key}` : `${CACHE_DIR}/${buildId}/${key}.cache`).replace(/\/+/g, "/");
    return `http://assets.local/${name}`;
  }
};
var static_assets_incremental_cache_default = new StaticAssetsIncrementalCache();

// open-next.config.ts
var open_next_config_default = defineCloudflareConfig({
  // Read-only incremental cache backed by the ASSETS binding — no KV/R2/D1
  // required. ISR pages serve their prerendered payloads; revalidation
  // writes are no-ops (documented v1 limitation of Website.Nextjs).
  incrementalCache: static_assets_incremental_cache_default
});
export {
  open_next_config_default as default
};
