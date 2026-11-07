import * as Cloudflare from "@alchemy.run/cloudflare";
import { bindingRoutes } from "./bindings-routes.ts";

/**
 * A Cloudflare Worker driving the Modal bindings. Its Modal calls go over a
 * `cloudflare:sockets` TLS socket, since a Worker's `fetch` can't reach
 * `api.modal.com`.
 */
export default class ModalBindingsWorker extends Cloudflare.Worker<ModalBindingsWorker>()(
  "ModalBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  bindingRoutes,
) {}
