// App Router route handler — served by Next as usual: the backend's RPC
// dispatch only claims /api/__rpc/*, so the rest of /api/* stays Next's.
// The integ test asserts this JSON shape.
export function GET() {
  return Response.json({ hello: "world" });
}
