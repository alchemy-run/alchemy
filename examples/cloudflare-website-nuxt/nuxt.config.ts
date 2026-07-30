import { defineNuxtConfig } from "nuxt/config";

// The project's own nuxt.config.ts loads natively — Alchemy only overlays
// what the Cloudflare deploy needs (nitro's cloudflare_module preset).
// Do NOT set `nitro.preset` here; the deploy target owns it.
export default defineNuxtConfig({
  compatibilityDate: "2026-07-01",
  telemetry: { enabled: false },
  routeRules: {
    "/about": { prerender: true },
  },
});
