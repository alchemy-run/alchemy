import { expect, it } from "alchemy-test";
import type * as Cloudflare from "@/Cloudflare";
import type { InferEnv } from "@/Cloudflare/Workers/InferEnv";
import { toBinding } from "@/Cloudflare/Workers/WorkerAsyncBindings";
import type { WorkerBindingResource } from "@/Cloudflare/Workers/WorkerBinding";

// A resource ref carries its `Type` and attribute fields; this stands in for
// a deployed `MtlsCertificate` without any cloud call.
const certificate = {
  Type: "Cloudflare.MtlsCertificate.MtlsCertificate",
  mtlsCertificateId: "11111111-2222-3333-4444-555555555555",
  // Safety: only the `Type` marker and `mtlsCertificateId` are read by the
  // classifier under test.
} as unknown as Cloudflare.MtlsCertificate.MtlsCertificate;

it("a Worker env MtlsCertificate becomes an mtls_certificate binding", () => {
  expect(toBinding("ORIGIN_CERT", certificate)).toEqual({
    type: "mtls_certificate",
    name: "ORIGIN_CERT",
    certificateId: certificate.mtlsCertificateId,
  });
});

it("a Worker env MtlsCertificate is typed as a Fetcher at runtime", () => {
  // Compile-time assertions: `env` accepts the resource and `InferEnv`
  // yields a `Fetcher`.
  const accepted: WorkerBindingResource = certificate;
  const env: InferEnv<{ ORIGIN_CERT: Cloudflare.MtlsCertificate.MtlsCertificate }> = {
    // Safety: type-level check only; the value is never used.
    ORIGIN_CERT: undefined as unknown as Fetcher,
  };
  expect(accepted).toBeDefined();
  expect(env).toBeDefined();
});

it("control: a plain string env value is still a plain_text binding", () => {
  expect(toBinding("GREETING", "hello")).toMatchObject({
    type: "plain_text",
    name: "GREETING",
    text: "hello",
  });
});
