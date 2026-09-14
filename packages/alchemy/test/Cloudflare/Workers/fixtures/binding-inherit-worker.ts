export default {
  fetch(_request: Request, env: { VALUE: string }) {
    return new Response(env.VALUE);
  },
};
