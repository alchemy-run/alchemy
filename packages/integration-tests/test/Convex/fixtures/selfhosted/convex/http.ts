import { httpActionGeneric, httpRouter } from "convex/server";

const http = httpRouter();

http.route({
  path: "/hello",
  method: "GET",
  handler: httpActionGeneric(async () => new Response("hello from an http action")),
});

export default http;
