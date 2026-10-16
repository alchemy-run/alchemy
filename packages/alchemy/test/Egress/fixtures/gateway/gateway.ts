import * as Egress from "@/Egress/index.ts";
import * as GitHub from "@/GitHub/index.ts";

/** A public repository the gateway may read (and nothing else). */
export const READ_REPO = "alchemy-run/alchemy";

/** The harmless upstream the HTTP egress points at; it echoes requests back. */
export const ECHO_HOST = "httpbin.org";

/** The header the HTTP egress adds, and its value. */
export const ECHO_HEADER = "x-egress-test";
export const ECHO_VALUE = "added-by-the-gateway";

export class TestGateway extends Egress.Gateway<TestGateway>()("EgressTestGateway", {
  repo: GitHub.Egress,
  echo: Egress.Http,
}) {}
