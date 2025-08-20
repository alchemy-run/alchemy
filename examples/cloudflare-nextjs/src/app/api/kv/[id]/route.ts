import { getCloudflareContext } from "@opennextjs/cloudflare";

export const GET = async (
  _: Request,
  { params }: { params: { id: string } },
) => {
  const { env } = await getCloudflareContext({ async: true });
  const value = await env.KV.get(params.id);
  if (!value) {
    return new Response(null, { status: 404 });
  }
  return new Response(value);
};

export const PUT = async (
  request: Request,
  { params }: { params: { id: string } },
) => {
  const { env } = await getCloudflareContext({ async: true });
  const value = await request.text();
  await env.KV.put(params.id, value);
  return new Response(null, { status: 201 });
};

export const DELETE = async (
  _: Request,
  { params }: { params: { id: string } },
) => {
  const { env } = await getCloudflareContext({ async: true });
  await env.KV.delete(params.id);
  return new Response(null, { status: 204 });
};
