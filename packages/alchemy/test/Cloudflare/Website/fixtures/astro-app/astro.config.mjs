// @ts-check
import { defineConfig } from "astro/config";

// On-demand SSR by default; individual pages opt into prerendering
// (`about.astro`). Loaded natively by the integration — the config file is
// authoritative (the toolchain injects its adapter without overriding
// `output`; before the user-config principle landed the integration pinned
// `output: "server"` itself, which is why this file didn't exist).
export default defineConfig({
  output: "server",
});
