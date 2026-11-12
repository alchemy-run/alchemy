import { DurableObject } from "cloudflare:workers";

/**
 * A Durable Object backed by one Durable Object-managed Container, keyed
 * `PreviewShell` in `ctx.container.images`. Each request starts the container
 * if needed and reports its Alpine release, so a response proves the class's
 * namespace has a container application.
 */
export class PreviewSandbox extends DurableObject {
  async fetch() {
    const container = this.ctx.container;
    if (!container) {
      throw new Error("No container is attached to this Durable Object.");
    }
    if (!container.running) {
      container.start({
        image: container.images.PreviewShell,
        entrypoint: ["sleep", "infinity"],
        enableInternet: false,
      });
    }
    const output = await (await container.exec(["cat", "/etc/alpine-release"])).output();
    return new Response(`alpine ${new TextDecoder().decode(output.stdout).trim()}`);
  }
}

export default {
  async fetch(_request: Request, env: { SANDBOX: DurableObjectNamespace<PreviewSandbox> }) {
    try {
      return await env.SANDBOX.getByName("probe").fetch("http://sandbox/");
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
