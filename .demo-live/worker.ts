export default {
  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({ ok: true, from: "alchemy dashboard live demo" }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
// touch 1782966277
// touch 1782966800
