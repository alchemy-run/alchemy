import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    foldkit({
      // `serverEntry` is what renders; `build` makes one `vite build` emit
      // the browser bundle AND `dist/server/fetch.js`, a Web `fetch` handler
      // that Alchemy deploys as the Worker. Nothing else names an entry.
      ssr: {
        serverEntry: "/src/entry.server.ts",
        build: true,
      },
    }),
  ],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
