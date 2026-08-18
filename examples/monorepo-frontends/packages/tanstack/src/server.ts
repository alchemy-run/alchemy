/**
 * The mount — TanStack Start's `src/server.ts` convention (Start builds
 * it as the server entry in dev AND prod): effect API first (`undefined`
 * = "not mine"), then the framework serves everything else.
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` and the request scope settles inline before the response
 * — Lambda semantics.
 */
import serverEntry from "@tanstack/react-start/server-entry";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

const site = mount(Site);

const framework = serverEntry as {
  fetch: (request: Request) => Response | Promise<Response>;
};

export default {
  fetch: async (request: Request): Promise<Response> =>
    (await site.fetch(request)) ?? framework.fetch(request),
};
