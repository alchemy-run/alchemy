import * as Alchemy from "alchemy";
import * as Neon from "alchemy/Neon";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import EffectApi from "./src/EffectApi.ts";
import { auth, branch } from "./src/resources.ts";

export default Alchemy.Stack(
  "NeonManagedAuthExample",
  {
    providers: Neon.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const managedAuth = yield* auth;
    const backend = yield* branch;
    const site = yield* Neon.Function("AuthSite", {
      branch: backend,
      main: "./src/native.ts",
    });
    yield* Neon.AuthTrustedDomain("SiteOrigin", {
      auth: managedAuth,
      domain: site.url.pipe(Output.map((url) => new URL(url).origin)),
    });
    const api = yield* EffectApi;
    return {
      url: site.url,
      effectApiUrl: api.url,
      authUrl: managedAuth.baseUrl,
    };
  }),
);
