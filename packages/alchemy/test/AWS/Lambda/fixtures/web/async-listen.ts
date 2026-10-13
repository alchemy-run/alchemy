// An async Web Function that starts its own Node server. Alchemy mirrors
// Lambda's listen address into PORT and HOST before this module runs.
import * as http from "node:http";

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`listening on ${process.env.HOST}:${process.env.PORT} path=${req.url}`);
  })
  .listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? "127.0.0.1");
