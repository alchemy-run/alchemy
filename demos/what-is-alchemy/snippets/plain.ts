import * as Cloudflare from "@alchemy.run/cloudflare";

// #region show
export const Uploads = Cloudflare.R2.Bucket("Uploads");

export const Api = Cloudflare.Worker("Api", {
  main: "./src/api.ts",
  env: { Uploads },
});

export type ApiEnv = Cloudflare.InferEnv<typeof Api>;
// #endregion show
