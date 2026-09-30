import { DurableObject } from "cloudflare:workers";
import type * as Cloudflare from "@/Cloudflare";
import type { NativeAsyncWorker } from "./stack.ts";

export class NativeAsyncObject extends DurableObject {
  async fetch(request: Request) {
    const container = this.ctx.container;
    if (!container)
      throw new Error("No container is attached to this Durable Object.");
    const path = new URL(request.url).pathname;
    if (!container.running) {
      const image = path.startsWith("/builtin")
        ? "cloudflare/debian-trixie"
        : container.images[
            path.startsWith("/image/") ? path.slice("/image/".length) : "shell"
          ];
      if (!image) throw new Error("The shell image is not configured.");
      container.start({
        image,
        entrypoint: ["sleep", "infinity"],
        enableInternet: false,
        instance: "lite",
      });
    }
    const child = await container.exec(
      path === "/stdin" ? ["cat"] : ["sh", "-c", "printf native; exit 7"],
      path === "/stdin" ? { stdin: "pipe" } : undefined,
    );
    const result =
      path === "/stdin"
        ? (
            await Promise.all([
              (async () => {
                const writer = child.stdin!.getWriter();
                await writer.write(new TextEncoder().encode("native stdin"));
                await writer.close();
              })(),
              child.output(),
            ])
          )[1]
        : await child.output();
    return Response.json({
      stdout: new TextDecoder().decode(result.stdout),
      exitCode: result.exitCode,
      images: Object.keys(container.images),
    });
  }
}

export default {
  async fetch(
    request: Request,
    env: Cloudflare.InferEnv<typeof NativeAsyncWorker>,
  ) {
    if (new URL(request.url).pathname === "/ready")
      return new Response("ready");
    try {
      return await env.SANDBOX.getByName(new URL(request.url).pathname).fetch(
        request,
      );
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
};
