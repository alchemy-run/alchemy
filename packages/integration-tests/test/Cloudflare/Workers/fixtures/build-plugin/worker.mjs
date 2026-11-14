import answer from "virtual:answer";

export default { fetch: () => new Response(String(answer)) };
