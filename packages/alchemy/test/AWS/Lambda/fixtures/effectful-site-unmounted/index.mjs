// Prebuilt "framework server artifact" fixture WITHOUT the alchemy/Serve
// wiring-handshake byte sequence — the deploy-time scan must fail the
// handshake for a collect-only Function with "external" runtime delivery.
export const handler = async () => ({
  statusCode: 200,
  body: "framework only",
});
