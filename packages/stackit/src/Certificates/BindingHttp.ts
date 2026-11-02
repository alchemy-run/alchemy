import type { BindingScope } from "../LoadBalancer/BindingScope.ts";
import * as StackitBindings from "../StackitBindings.ts";
import type { Certificate } from "./Certificate.ts";

/**
 * Shared HTTP scaffolding for Certificates bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the certificates: STACKIT has no role binding
 * on a single certificate (see `StackitBindings`). The permissions come from the
 * spec's `x-stackit-authorization` on each operation.
 */
interface HttpBindingOptions<I, A, E> {
  /** Fully-qualified binding tag, e.g. `Stackit.Certificates.GetCertificate`. */
  tag: string;
  /** The permission the operation needs on the project holding the certificate. */
  permission: string;
  /** The distilled operation; the bound resource's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}

/** A binding over one operation on a certificate. */
export const makeCertificateHttpBinding = <
  I extends { projectId: string; region: string; id: string },
  A,
  E,
>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (certificate: Certificate) => ({
      projectId: certificate.projectId,
      region: certificate.region,
      id: certificate.certificateId,
    }),
    grants: (certificate) => [
      StackitBindings.grantOn(certificate, { permissions: [options.permission] }),
    ],
  });

/** A binding on the whole project and region of the bound resource. */
export const makeScopeHttpBinding = <I extends { projectId: string; region: string }, A, E>(
  options: HttpBindingOptions<I, A, E>,
) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (scope: BindingScope) => ({
      projectId: scope.projectId,
      region: scope.region,
    }),
    grants: (scope) => [StackitBindings.grantOn(scope, { permissions: [options.permission] })],
  });
