// A Lambda Web Function origin. It echoes what reached it so the test can
// confirm CloudFront forwards the whole viewer request (method, query,
// body, the application's own Authorization header) while signing the
// origin request itself.
export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    return Response.json({
      message: "hello through cloudfront",
      method: request.method,
      query: url.search,
      body: request.method === "GET" || request.method === "HEAD" ? null : await request.text(),
      endpoint: request.headers.get("lambda-web-endpoint-name"),
      authorization: request.headers.get("authorization"),
    });
  },
};
