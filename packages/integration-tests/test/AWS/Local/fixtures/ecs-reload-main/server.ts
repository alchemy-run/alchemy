/**
 * External-`main` hot-reload fixture for the ECS local-dev test: a plain
 * Node.js HTTP server (no Effect entry — the Task is declared without an
 * inline impl, so the bundle runs as-is). The test clones this file, deploys
 * a bundled-`main` Task from the clone, then rewrites the marker below and
 * asserts the new marker serves WITHOUT another deploy.
 */
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 17360);

createServer((_request, response) => response.end("ecs-reload-main-v1")).listen(port, () =>
  console.log(`ecs-reload-main fixture listening on ${port}`),
);
