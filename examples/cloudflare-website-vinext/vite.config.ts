import tailwindcss from "@tailwindcss/vite";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({
      // Website.Vinext runs vinext prerender after `vite build`.
      prerender: true,
      // Descriptors only — adapters instantiate on the first request.
      // Missing bindings log and fall back; they do not fail the build.
      cache: {
        // Page-level ISR on the edge. Origin renders, Cache-Tag, and
        // revalidateTag / revalidatePath purge via ctx.cache. Website.Vinext
        // sets cache.enabled and CF_VERSION_METADATA (no wrangler.jsonc).
        cdn: cdnAdapter(),
        // Durable HIT/STALE in KV. Reads env.VINEXT_KV_CACHE (default
        // binding). Website.Vinext provisions and seeds that namespace.
        // Optional: appPrefix, ttlSeconds (default 30d), tagCacheTtlMs.
        data: kvDataAdapter(),
      },
    }),
    tailwindcss(),
  ],
});
