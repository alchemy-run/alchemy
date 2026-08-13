// The explicit one-file mount for Nuxt (the v1 Nuxt path, both clouds):
// nitro compiles this middleware into the server bundle, so the Effect
// program runs in the deployed Lambda and under `nuxt dev` alike. The
// handler answers matched effect routes and returns undefined on
// passthrough so nitro continues to its own handlers.
import { toEventHandler } from "alchemy/serve/nitro";
import Site from "../../src/site.ts";

export default toEventHandler(Site);
