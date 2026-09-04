import { bootstrap } from "./scripts/bootstrap-distilled.mjs";

export const hooks = {
  updateConfig(config) {
    bootstrap(import.meta.dirname);
    return config;
  },
};
