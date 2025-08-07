import alchemy from "alchemy/cloudflare/redwood";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [alchemy()],
});
