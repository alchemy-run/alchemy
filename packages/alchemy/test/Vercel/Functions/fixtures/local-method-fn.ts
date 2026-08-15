/**
 * Local-dev async fixture: method exports (arm 3 of the launcher matrix).
 * No default export — the shim must route by request method, serve HEAD
 * with GET (body stripped), and 405 unexported methods.
 */
export function GET(request: Request): Response {
  return Response.json({ method: "GET", path: new URL(request.url).pathname });
}

export async function POST(request: Request): Promise<Response> {
  return Response.json({ method: "POST", echo: await request.text() });
}
