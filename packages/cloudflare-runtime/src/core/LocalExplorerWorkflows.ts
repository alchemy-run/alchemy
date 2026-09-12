// Keep workflow deletion inside the live Engine. Unlinking its SQLite file
// while workerd owns it leaves active execution and cached state behind.
export const explorerWorkflowLoopback = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = /^\\/core\\/workflow-storage\\/([^/]+)(?:\\/([a-f0-9]{64}))?$/.exec(url.pathname);
    if (!match) return env.LOOPBACK.fetch(request);
    const info = env.WORKFLOWS[decodeURIComponent(match[1])];
    if (!info) return new Response("Unknown workflow", { status: 404 });
    const namespace = env[info.engineBinding];
    const directoryUrl = new URL(request.url);
    directoryUrl.pathname = "/core/workflow-storage/" + match[1];
    const response = await env.LOOPBACK.fetch(directoryUrl);
    if (!response.ok) return response;
    const files = await response.json();
    const live = [];
    for (const file of files) {
      const id = file.name.slice(0, -7);
      if (match[2] && id !== match[2]) continue;
      const stub = namespace.get(namespace.idFromString(id));
      try {
        const metadata = await stub.getInstanceMetadata();
        // Empty database files can remain after deleteAll(), including after
        // a restart. They are not instances and must not appear in the UI.
        if (!metadata.instanceId) continue;
      } catch (error) {
        if (String(error).includes("instance.not_found") || String(error).includes("Engine was never started")) continue;
        throw error;
      }
      if (request.method === "DELETE") {
        try { await stub.deleteInstance(); }
        catch (error) {
          if (!String(error).includes("Aborting engine: User called delete")) throw error;
        }
      }
      live.push(file);
    }
    if (request.method === "GET") return Response.json(live);
    if (request.method === "DELETE") return match[2] && !live.length
      ? new Response("Unknown instance", { status: 404 })
      : Response.json({ success: true });
    return new Response("Method not allowed", { status: 405 });
  }
};
`;
