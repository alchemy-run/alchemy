import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Alchemy loads this config natively at deploy time — the AWS deploy
// target injects its Lambda finishing pass around the build; no adapter
// or AWS plugin is declared here.
export default defineConfig({
  plugins: [tanstackStart(), viteReact()],
});
