// Stands in for compiled NestJS output. It listens on the NestJS default port
// only, so it is reachable only when Compute maps that port.
Bun.serve({ port: 3000, fetch: () => new Response("nest-default-port") });
