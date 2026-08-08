import { defineNuxtConfig } from "nuxt/config";

/**
 * The fixture's own nuxt.config.ts — loaded natively by the integration.
 * Observable from the live test:
 *
 * - `runtimeConfig.public.fixtureMarker` renders on the SSR home page.
 * - `routeRules["/prerendered"].prerender` makes nitro prerender that
 *   route into `.output/public` at build time (served from S3).
 *
 * NO `nitro.preset` here: the AWS deploy target owns the preset.
 */
export default defineNuxtConfig({
  compatibilityDate: "2026-07-01",
  telemetry: { enabled: false },
  runtimeConfig: {
    public: {
      fixtureMarker: "nuxt-aws-user-config-loaded",
    },
  },
  routeRules: {
    "/prerendered": { prerender: true },
  },
});
