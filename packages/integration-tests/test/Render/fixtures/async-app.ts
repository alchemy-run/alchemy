import * as Render from "@alchemy.run/render";
import * as pathe from "pathe";

/**
 * Async Render.WebService fixture (`InferEnv` form without Effect bootstrap).
 */
export const AsyncWebService = Render.WebService("AsyncWebService", {
  main: pathe.resolve(import.meta.dirname, "async-app-handler.ts"),
  registryImage: process.env.RENDER_TEST_REGISTRY_IMAGE ?? "ghcr.io/example/render-async-app",
  plan: "free",
  region: "oregon",
  env: {
    GREETING: "hello-render",
  },
});

export type AsyncWebServiceEnv = Render.InferEnv<typeof AsyncWebService>;
