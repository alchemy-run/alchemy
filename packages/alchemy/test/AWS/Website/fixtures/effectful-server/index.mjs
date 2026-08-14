// Minimal stand-in for a framework-built AWS server artifact whose entry
// mounts the effect program via `alchemy/Serve`. The literal below is the
// wiring-handshake sentinel (`SERVE_SENTINEL`) that the deploy-time scan
// greps the shipped directory for.
const SENTINEL = "__ALCHEMY_SERVE_v1__";

export const handler = async () => ({
  statusCode: 200,
  body: `ok ${SENTINEL}`,
});
