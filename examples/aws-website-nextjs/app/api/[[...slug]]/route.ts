// The explicit one-file mount for Next.js (the v1 Next path, both
// clouds): a catch-all route handler compiled by Next itself, so the
// Effect program runs in the deployed OpenNext Lambda and under
// `next dev` alike. The universal rpc path (`POST /api/__rpc/<method>`,
// what `createClient`'s type-only form sends) rides through this
// catch-all and is dispatched before route matching. More-specific
// routes (e.g. /api/hello) keep winning over the catch-all.
import { toRouteHandler } from "alchemy/serve/next";
import Site from "../../backend.ts";

const handler = toRouteHandler(Site);
export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as HEAD,
  handler as OPTIONS,
};
