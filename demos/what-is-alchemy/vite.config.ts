import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev`: the presenter (index.html → src/present.tsx).
export default defineConfig({
  plugins: [react()],
  server: { port: 5299 },
});
