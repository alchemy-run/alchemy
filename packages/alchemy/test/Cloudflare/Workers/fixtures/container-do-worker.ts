import { Container } from "@cloudflare/containers";

/**
 * Container-backed Durable Object class hosted by a plain async Worker —
 * used by the DO-attachment regression test in `Worker.test.ts` (#1150).
 * The class only needs to be hosted (declared + exported) so the Worker
 * upload creates its namespace and marks it container-backed; the fetch
 * handler never routes into the container.
 */
export class AttachmentRegressionContainer extends Container {
  defaultPort = 8080;
}

export default {
  fetch: async () => new Response("ok"),
};
