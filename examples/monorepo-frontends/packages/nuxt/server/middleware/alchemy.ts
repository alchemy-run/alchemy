/**
 * The mount — a nitro server middleware owns HTTP composition on Nuxt
 * (Serve/DESIGN.md): effect API first (`undefined` lets nitro continue
 * to its own routes and pages).
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` and the request scope settles inline before the response
 * — Lambda semantics.
 */
import { mount } from "alchemy/Serve";
import { defineEventHandler, toWebRequest } from "h3";
import Site from "../../src/backend.ts";

const site = mount(Site);

export default defineEventHandler((event) => site.fetch(toWebRequest(event)));
