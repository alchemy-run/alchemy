import type { RequestEvent } from "@sveltejs/kit";
import assert from "node:assert";

export const GET = async ({ platform, params }: RequestEvent) => {
  assert(params.key, "key is required");
  assert(platform, "platform is required");
  const key = params.key;
  const value = await platform!.env.AUTH_STORE.get(key);
  if (!value) {
    return new Response(null, { status: 404 });
  }
  return new Response(value);
};

export const PUT = async ({ platform, params, request }: RequestEvent) => {
  assert(params.key, "key is required");
  assert(platform, "platform is required");
  const key = params.key;
  const value = await request.text();
  await platform.env.AUTH_STORE.put(key, value);
  return new Response(null, {
    status: 201,
    headers: { Location: `/api/test/kv/${key}` },
  });
};

export const DELETE = async ({ platform, params }: RequestEvent) => {
  assert(params.key, "key is required");
  assert(platform, "platform is required");
  const key = params.key;
  await platform.env.AUTH_STORE.delete(key);
  return new Response(null, { status: 204 });
};
