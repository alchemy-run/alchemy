// A plain JavaScript program, bundled and run as-is in every sandbox.
import { createServer } from "node:http";

const env = process.env;

createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(`${env.GREETING ?? "missing"} from an async template program`);
}).listen(Number(env.PORT ?? 3000), "0.0.0.0");
