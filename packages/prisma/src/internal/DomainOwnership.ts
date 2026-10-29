import * as Data from "effect/Data";
import * as Redacted from "effect/Redacted";

/**
 * Prisma refused the hostname because this workspace has not proved it owns
 * it. Publish a `TXT` record named `recordName` with the value `recordValue`
 * (keep it — later domains on the same hostname reuse it), then redeploy.
 */
export class PrismaDomainOwnershipRequired extends Data.TaggedError(
  "PrismaDomainOwnershipRequired",
)<{
  /** Hostname Prisma refused. */
  readonly hostname: string;
  /** Name of the `TXT` record to publish, e.g. `_prisma-verification.app.example.com`. */
  readonly recordName: string;
  /** Value of the `TXT` record to publish, e.g. `prisma-verification=<token>`. */
  readonly recordValue: string;
  readonly message: string;
}> {}

/** The `domain-ownership-required` rejection, with the record Prisma returns. */
export const ownershipRequiredOf = (
  error: {
    readonly _tag: string;
    readonly status?: number;
    readonly body?: Redacted.Redacted<string>;
  },
  hostname: string,
) => {
  if (error._tag !== "PrismaApiError" || error.status !== 422 || error.body === undefined) {
    return undefined;
  }
  const rejection = parseErrorBody(Redacted.value(error.body));
  if (rejection?.code !== "domain-ownership-required") return undefined;
  const recordName = rejection.verification?.name ?? `_prisma-verification.${hostname}`;
  const recordValue = rejection.verification?.value ?? "";
  return new PrismaDomainOwnershipRequired({
    hostname,
    recordName,
    recordValue,
    message: `Prisma requires proof that this workspace owns '${hostname}'. Publish a TXT record named '${recordName}'${recordValue ? ` with value '${recordValue}'` : ""}, keep it, and redeploy.${recordValue ? "" : ` ${rejection.hint ?? ""}`}`,
  });
};

/** Prisma's error envelope; `verification` is set on `domain-ownership-required`. */
interface PrismaErrorBody {
  readonly code?: string;
  readonly hint?: string;
  readonly verification?: { readonly name?: string; readonly value?: string };
}

const parseErrorBody = (body: string): PrismaErrorBody | undefined => {
  try {
    return JSON.parse(body)?.error;
  } catch {
    return undefined;
  }
};
