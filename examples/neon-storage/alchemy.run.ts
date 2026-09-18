import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import EffectApi from "./EffectApi.ts";
import { resources } from "./resources.ts";

export default Alchemy.Stack(
  "NeonStorage",
  {
    providers: Neon.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const { branch, uploads, publicAssets } = yield* resources;
    const native = yield* Neon.Function("NativeApi", {
      branch,
      main: "./native.ts",
      env: {
        UPLOADS_BUCKET: uploads.bucketName,
        APP_TOKEN: yield* Config.Redacted("NEON_STORAGE_APP_TOKEN"),
      },
    });
    const effect = yield* EffectApi;
    return {
      nativeUrl: native.url,
      effectUrl: effect.url,
      publicBucket: publicAssets.bucketName,
    };
  }),
);
