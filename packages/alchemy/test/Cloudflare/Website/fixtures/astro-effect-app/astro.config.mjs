// @ts-check
import { defineConfig } from "astro/config";

// On-demand SSR (required for the effectful-Website tier — a
// declared-static build would deploy assets-only and the Effect program's
// handlers could never run; the construct fails fast on that combination).
// Individual pages still opt into prerendering (`about.astro`), which is
// the effect tier's prerender guard case: the prerender worker keeps
// astro's default fetchable and must build without touching the effect
// module graph.
export default defineConfig({
  output: "server",
});
