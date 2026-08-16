import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Alchemy loads this config natively at deploy time and injects its
// AWS Lambda adapter into the `sveltekit()` instance below — do NOT
// declare an adapter here.
export default defineConfig({
  plugins: [sveltekit()],
});
