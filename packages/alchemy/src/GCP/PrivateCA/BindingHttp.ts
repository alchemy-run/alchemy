import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { CertificateAuthority } from "./CertificateAuthority.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";
import { type GcpHttpOp } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Certificate Authority Service bindings.
 * NOT exported from index.ts.
 */
export const makeCertificateAuthorityHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  role?: string;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (ca: CertificateAuthority) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: ca,
        iam: [{ role: options.role ?? defaultRoleFor(options.tag) }],
      });
      const name = yield* ca.name;
      return Effect.fn(`${options.tag}(${ca.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });
