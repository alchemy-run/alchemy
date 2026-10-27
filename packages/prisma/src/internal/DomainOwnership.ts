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

/** The `domain-ownership-required` rejection, with the record its hint names. */
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
  const body = Redacted.value(error.body);
  if (!body.includes("domain-ownership-required")) return undefined;
  const hint = parseErrorHint(body) ?? "";
  const match = /TXT record named\s+(\S+)\s+with value\s+(\S+?)\.?(?:\s|$)/.exec(hint);
  const recordName = match?.[1] ?? `_prisma-verification.${hostname}`;
  const recordValue = match?.[2] ?? "";
  return new PrismaDomainOwnershipRequired({
    hostname,
    recordName,
    recordValue,
    message: `Prisma requires proof that this workspace owns '${hostname}'. Publish a TXT record named '${recordName}'${recordValue ? ` with value '${recordValue}'` : ""}, keep it, and redeploy.${recordValue ? "" : ` ${hint}`}`,
  });
};

const parseErrorHint = (body: string): string | undefined => {
  try {
    const hint = JSON.parse(body)?.error?.hint;
    return typeof hint === "string" ? hint : undefined;
  } catch {
    return undefined;
  }
};
