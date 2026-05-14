import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, esmExternalRequirePlugin } from "vite";

export default defineConfig({
  plugins: [tanstackStart(), viteReact(), esmExternalRequirePlugin()],
});
