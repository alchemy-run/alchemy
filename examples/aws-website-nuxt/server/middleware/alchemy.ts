// The explicit one-file mount for Nuxt (the v1 Nuxt path, both clouds):
// nitro compiles this middleware into the server bundle, so the Effect
// program runs in the deployed Lambda and under `nuxt dev` alike. The
// shared `routes` claim decides who serves each path — inside it the
// effect fetch is authoritative (its 404s are real 404s); outside it the
// handler returns undefined so nitro continues to its own handlers.
import { toEventHandler } from "alchemy/serve/nitro";
import Site, { routes } from "../../src/site.ts";

export default toEventHandler(Site, { routes });
