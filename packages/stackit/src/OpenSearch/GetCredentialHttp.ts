import * as opensearch from "@distilled.cloud/stackit/opensearch";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetCredential } from "./GetCredential.ts";

/**
 * HTTP implementation of {@link GetCredential}.
 *
 * @layer
 * @provides Stackit.OpenSearch.GetCredential
 */
export const GetCredentialHttp = Layer.effect(
  GetCredential,
  makeInstanceHttpBinding({
    tag: "Stackit.OpenSearch.GetCredential",
    permission: "opensearch.credential.get",
    operation: opensearch.getCredentials,
  }),
);
