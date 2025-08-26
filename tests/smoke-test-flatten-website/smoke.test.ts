import { $ } from "bun";
import { switchVersion } from "./scripts/switch.ts";

const env = process.env as Record<string, string>;
// switch to the stable version of alchemy prior to flattening the website resource
await switchVersion("0.62.2");
await $`bun alchemy destroy --env-file ../../.env`.env(env);
await $`bun alchemy deploy --env-file ../../.env`.env({
  ...env,
  RUN_COUNT: "0",
});

// switch to the `this` version of alchemy and ensure it deploys
await switchVersion("workspace:*");
await $`RUN_COUNT=1 bun alchemy deploy --env-file ../../.env`.env({
  ...env,
  RUN_COUNT: "1",
});
if (!process.env.NO_DESTROY) {
  await $`bun alchemy destroy --env-file ../../.env`.env(env);
}
