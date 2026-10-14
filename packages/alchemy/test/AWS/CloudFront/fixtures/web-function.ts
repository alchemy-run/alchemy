// A Lambda Web Function origin. It echoes the viewer's Authorization header
// so the test can confirm CloudFront passes the application's own auth
// through while signing the origin request itself.
export default {
  async fetch(request: Request) {
    return Response.json({
      message: "hello through cloudfront",
      endpoint: request.headers.get("lambda-web-endpoint-name"),
      authorization: request.headers.get("authorization"),
    });
  },
};
