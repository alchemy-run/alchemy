import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import alchemy from "alchemy/cloudflare/react-router";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [alchemy(), tailwindcss(), reactRouter(), tsconfigPaths()],
});
