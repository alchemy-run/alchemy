import { s3Adapter } from "@alchemy.run/frontend-frameworks/vinext/cache/s3";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({
      // CACHE_BUCKET_NAME is set by AWS.Website.Vinext. Local vinext
      // start without the bucket falls back to MemoryCacheHandler.
      cache: { data: s3Adapter() },
    }),
    tailwindcss(),
  ],
});
