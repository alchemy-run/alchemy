import * as Egress from "alchemy/Egress";

/** The upstream the echo egress points at: it echoes requests back. */
export const ECHO_HOST = "httpbin.org";
export const ECHO_HEADER = "x-workspace-egress";
export const ECHO_VALUE = "added-by-the-gateway";

/** Adds {@link ECHO_HEADER} to requests to {@link ECHO_HOST}. */
export class EchoGateway extends Egress.Gateway<EchoGateway>()("WorkspaceEchoGateway", {
  echo: Egress.Http,
}) {}
