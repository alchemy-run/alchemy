// Prebuilt "framework server artifact" fixture for the effectful
// (collect-only) Function tests. The literal below is the alchemy/Serve
// wiring-handshake sentinel — its presence marks this artifact as
// "bridge mounted" for the deploy-time sentinel scan.
const SENTINEL = "__ALCHEMY_SERVE_v1__";

export const handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sentinel: SENTINEL }),
});
