import { initialize } from "cojson-core-wasm/edge-lite";

export default {
  async fetch() {
    await initialize();
    return new Response("Hello, world!");
  },
};
