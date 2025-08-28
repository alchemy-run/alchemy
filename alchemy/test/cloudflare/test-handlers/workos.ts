import { WorkOS } from "@workos-inc/node";

export default {
  async fetch(request: Request) {
    const workos = new WorkOS("sk_test_1234567890");

    return new Response(null, { status: 204 });
  },
};
