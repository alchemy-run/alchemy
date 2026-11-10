/**
 * The regional switchboard a custom hostname CNAMEs to, derived from the
 * app endpoint (`https://{app}.{region}.prisma.build` →
 * `switchboard.{region}.prisma.build`).
 */
export const switchboardTarget = (endpoint: string | undefined) => {
  const host = (endpoint ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const dot = host.indexOf(".");
  return dot < 0 ? host : `switchboard${host.slice(dot)}`;
};
