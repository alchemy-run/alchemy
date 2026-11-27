// A program for lifecycle tests: answers every call with its VERSION.
import { createServer } from "node:http";

createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ version: process.env.VERSION }));
}).listen(Number(process.env.PORT), "0.0.0.0");
