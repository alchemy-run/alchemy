import { DurableObject } from "cloudflare:workers";

// The async form a host converts from: the `LENS_DO` binding's physical class
// is `LensServer`, a name distinct from the binding's logical id.
export class LensServer extends DurableObject {
  async write(value: string) {
    await this.ctx.storage.put("value", value);
  }

  async read() {
    return (await this.ctx.storage.get<string>("value")) ?? null;
  }
}

export default {
  async fetch(
    request: Request,
    env: { LENS_DO: DurableObjectNamespace<LensServer> },
  ) {
    const object = env.LENS_DO.getByName("lens");
    const value = new URL(request.url).searchParams.get("value");
    if (request.method === "POST" && value !== null) {
      await object.write(value);
    }
    return Response.json({ form: "async", value: await object.read() });
  },
};
