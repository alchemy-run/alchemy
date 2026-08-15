// App Router route handler — served by Next as usual: the backend claims
// no HTTP paths, so all of /api/* stays Next's.
// The integ test asserts this JSON shape.
export function GET() {
  return Response.json({ hello: "world" });
}
