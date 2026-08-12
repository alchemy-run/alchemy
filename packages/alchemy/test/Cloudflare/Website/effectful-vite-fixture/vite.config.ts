import { defineConfig } from "vite";

// No framework plugin and no server environment of its own: the effectful
// Website's generated `virtual:alchemy:website-entry` wrapper IS the worker.
export default defineConfig({});
