// The explicit one-file mount for Nuxt (the v1 Nuxt path, both clouds):
// nitro compiles this middleware into the server bundle, so the backend
// runs in the deployed Lambda and under `nuxt dev` alike. The universal
// rpc path (`POST /api/__rpc/<method>`, what `createClient`'s type-only
// form sends) is dispatched before route matching; everything else is
// declined (the backend exposes no `fetch`), so nitro continues to its
// own handlers — `/api/hello` stays a plain nitro route.
import { toEventHandler } from "alchemy/serve/nitro";
import Site from "../backend.ts";

export default toEventHandler(Site);
