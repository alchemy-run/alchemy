// src/server.ts
import { createServer } from "node:http";
import type { GreeterEnv } from "./Greeter.ts";

const env = process.env as GreeterEnv & { PORT?: string };

createServer((request, response) => {
  const name = new URL(request.url ?? "/", "http://sandbox").searchParams.get("name") ?? "world";
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ message: `${env.GREETING}, ${name}` }));
}).listen(Number(env.PORT ?? 3000), "0.0.0.0");
