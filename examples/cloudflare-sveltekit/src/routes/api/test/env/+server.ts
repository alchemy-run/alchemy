import type { RequestEvent } from "@sveltejs/kit";

export const GET = async ({ platform }: RequestEvent) => {
  return Response.json({
    ALCHEMY_TEST_VALUE: platform!.env.ALCHEMY_TEST_VALUE,
  });
};
