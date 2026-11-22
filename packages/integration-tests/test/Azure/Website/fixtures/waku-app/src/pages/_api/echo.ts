// Waku API route (`/echo`): runs on the server Function, which stamps the
// response with a header Blob Storage never sends.
export const GET = async (request: Request): Promise<Response> => {
  const echo = new URL(request.url).searchParams.get("echo") ?? "";
  return Response.json(
    { marker: "WAKU_AZURE_API_MARKER", echo, host: new URL(request.url).host },
    { headers: { "x-rendered-by": "waku-function" } },
  );
};
