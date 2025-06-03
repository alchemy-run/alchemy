export default {
  async fetch(_request: Request, env: any): Promise<Response> {
    if (env.IMAGES && env.IMAGES.type === "images") {
      return new Response("Images binding available", { status: 200 });
    }
    if (env.VERSION_METADATA) {
      return new Response("VersionMetadata binding available", { status: 200 });
    }
    return new Response("Binding not found", { status: 500 });
  },
};
