// Minimal stand-in for a framework-built AWS server artifact whose entry
// does NOT mount the effect program — no serve sentinel anywhere in the
// shipped directory, so the external-tier wiring handshake must fail.
export const handler = async () => ({
  statusCode: 200,
  body: "ok",
});
