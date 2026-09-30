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
    if (url.pathname === "/snapshot") {
      return this.snapshotRoundTrip(url.searchParams.get("token") ?? "");
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

  /**
   * Write `token` into the running container, snapshot its filesystem,
   * destroy it, start a fresh container from the snapshot and read the token
   * back: proof the restored container carries the snapshot's filesystem, not
   * the image's. Every step is reported with its duration, so a failure
   * names the step that failed.
   */
  async snapshotRoundTrip(token: string): Promise<Response> {
    const container = this.ctx.container!;
    const steps: Array<{ step: string; ms: number }> = [];
    const step = async <A>(name: string, run: () => Promise<A>) => {
      const started = Date.now();
      try {
        return await run();
      } finally {
        steps.push({ step: name, ms: Date.now() - started });
      }
    };
    try {
      if (!container.running) {
        container.start({
          image: container.images.echo!,
          enableInternet: false,
          instance: "lite",
        });
      }
      await step("write", () =>
        this.run(["sh", "-c", `echo ${token} > /tmp/alchemy-snapshot`]),
      );
      const snapshot = await step("snapshot", () =>
        container.snapshotContainer({ name: "alchemy-test" }),
      );
      await step("destroy", async () => {
        await container.destroy();
        for (let i = 0; i < 60 && container.running; i++) {
          await scheduler.wait(1000);
        }
      });
      container.start({
        containerSnapshot: { id: snapshot.id },
        enableInternet: false,
        instance: "lite",
      });
      const restored = await step("read", () =>
        this.run(["cat", "/tmp/alchemy-snapshot"]),
      );
      return Response.json({ snapshot, restored: restored.trim(), steps });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          steps,
        },
        { status: 500 },
      );
    }
  }

  /** Exec in the container, retrying while it is still booting. */
  async run(cmd: string[]): Promise<string> {
    let last: unknown;
    for (let i = 0; i < 30; i++) {
      try {
        // As the image's own user: `exec` with `user: "root"` fails with an
        // internal error (observed 2026-09-30).
        const process = await this.ctx.container!.exec(cmd);
        const output = await process.output();
        if (output.exitCode === 0) {
          return new TextDecoder().decode(output.stdout);
        }
        last = new Error(
          `exit ${output.exitCode}: ${new TextDecoder().decode(output.stderr)}`,
        );
      } catch (error) {
        last = error;
      }
      await scheduler.wait(1000);
    }
    throw last;
  }
}

type Env = Cloudflare.InferEnv<typeof DurableObjectContainerWorker>;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const name =
      url.pathname === "/snapshot"
        ? "snapshot"
        : (url.searchParams.get("image") ?? "echo");
    return env.SANDBOX.getByName(name).fetch(request);
  },
};
