import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";
import solidYield from "vite-plugin-solid-yield";

// The yield transform runs before Solid's JSX compiler.
export default defineConfig({
  plugins: [solidYield(), solid()],
});
