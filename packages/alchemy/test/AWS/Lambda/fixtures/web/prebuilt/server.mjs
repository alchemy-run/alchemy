// A prebuilt server deployed as-is (`bundle: false`), like a framework's
// standalone output. It reads the conventional PORT / HOSTNAME variables.
import * as http from "node:http";
import { greeting } from "./greeting.mjs";

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`${greeting} on ${process.env.HOSTNAME}:${process.env.PORT}`);
  })
  .listen(Number(process.env.PORT ?? 3000), process.env.HOSTNAME ?? "127.0.0.1");
