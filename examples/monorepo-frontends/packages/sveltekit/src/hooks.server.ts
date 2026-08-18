/**
 * The mount — kit's `handle` hook owns HTTP composition (Serve/DESIGN.md):
 * effect API first (`undefined` = "not mine"), then kit serves pages.
 *
 * `site.fetch(request)` takes no env/ctx on AWS: env resolves from
 * `process.env` and the request scope settles inline before the response
 * — Lambda semantics.
 */
import type { Handle } from "@sveltejs/kit";
import { mount } from "alchemy/Serve";
import Site from "./backend.ts";

const site = mount(Site);

export const handle: Handle = async ({ event, resolve }) =>
  (await site.fetch(event.request)) ?? resolve(event);
