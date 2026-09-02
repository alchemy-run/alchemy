import { redisAdapter } from "@alchemy.run/frontend-frameworks/vinext/cache/redis";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({
      // REDIS_URL is set on the Railway Service. Local vinext start /
      // alchemy dev without Redis falls back to MemoryCacheHandler.
      cache: { data: redisAdapter() },
    }),
    tailwindcss(),
  ],
});
