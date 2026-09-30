import type * as Cloudflare from "@/Cloudflare";
import { DurableObject } from "cloudflare:workers";
import type { DurableObjectContainerWorker } from "./stack.ts";

const ports: Record<string, number> = { echo: 8080, whoami: 80 };

/**
 * Starts the image this object is named after, chosen from the images the
 * Worker upload declared for its class, then proxies the request to it.
 */
export class Sandbox extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container!;
    const url = new URL(request.url);
    if (url.pathname === "/images") {
      return Response.json(Object.keys(container.images).sort());
    }
    const name = url.searchParams.get("image") ?? "echo";
    const image = container.images[name];
    if (image === undefined) {
      return new Response(`no image named ${name}`, { status: 404 });
    }
    if (!container.running) {
      container.start({ image, enableInternet: false, instance: "lite" });
    }
    return container
      .getTcpPort(ports[name]!)
      .fetch(new Request("http://container/", request));
  }
}

type Env = Cloudflare.InferEnv<typeof DurableObjectContainerWorker>;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("image") ?? "echo";
    return env.SANDBOX.getByName(name).fetch(request);
  },
};
