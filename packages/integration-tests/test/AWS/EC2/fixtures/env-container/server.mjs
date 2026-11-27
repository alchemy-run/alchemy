// Echoes every `ENV_*` variable the container was started with, so the test
// can compare them against `expectedEnv` (test/EnvValues.ts).
import http from "node:http";

http
  .createServer((_req, res) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.startsWith("ENV_")),
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(env));
  })
  .listen(Number(process.env.PORT ?? 3000));
