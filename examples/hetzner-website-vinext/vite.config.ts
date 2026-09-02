import { redisAdapter } from "@alchemy.run/frontend-frameworks/vinext/cache/redis";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({
      // Optional: set REDIS_URL on the systemd unit for a durable ISR
      // store. Local vinext start / alchemy dev without Redis falls back
      // to MemoryCacheHandler.
      cache: { data: redisAdapter() },
    }),
    tailwindcss(),
  ],
});
