import * as iam from "@distilled.cloud/gcp/iam_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  sanitizeLabelValue,
  toLabels,
} from "../Labels.ts";

export const MAX_POLICY_ID = 63;

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.IAM.ResourceNotResolved",
)<{
  name: string;
}> {}

export class OperationFailed extends Data.TaggedError(
  "GCP.IAM.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class OperationPending extends Data.TaggedError(
  "GCP.IAM.OperationPending",
)<{
  operation: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const attachmentPointOf = (
  project: string,
  attachmentPoint?: string,
) => {
  if (attachmentPoint && attachmentPoint.length > 0) {
    return attachmentPoint.includes("%2F")
      ? attachmentPoint
      : encodeURIComponent(attachmentPoint);
  }
  return encodeURIComponent(
    `cloudresourcemanager.googleapis.com/projects/${project}`,
  );
};

export const denypoliciesParent = (attachmentPoint: string) =>
  `policies/${attachmentPoint}/denypolicies`;

export const policyName = (attachmentPoint: string, policyId: string) =>
  `${denypoliciesParent(attachmentPoint)}/${policyId}`;

export const parsePolicyName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const policiesAt = parts.indexOf("policies");
  const denyAt = parts.lastIndexOf("denypolicies");
  return {
    attachmentPoint:
      policiesAt >= 0 && parts[policiesAt + 1] ? parts[policiesAt + 1]! : "",
    policyId:
      denyAt >= 0 && parts[denyAt + 1] ? parts[denyAt + 1]! : lastSegment(name),
  };
};

const rfc1035 = (value: string) => {
  let next = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `p${next}`;
  next = next.slice(0, MAX_POLICY_ID).replace(/-+$/g, "");
  if (next.length < 3) next = `${next}xxx`.slice(0, MAX_POLICY_ID);
  return next;
};

export const toPolicyId = (
  id: string,
  requested: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return rfc1035(requested);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_POLICY_ID,
        lowercase: true,
      }),
    );
  });

export const ownershipAnnotations = (id: string) =>
  Effect.gen(function* () {
    return toLabels(yield* createInternalLabels(id));
  });

export const hasOwnershipAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
) => Object.keys(annotations ?? {}).some((key) => key.startsWith("alchemy-"));

export const ownedByAlchemy = (
  id: string,
  annotations: Record<string, string | undefined> | null | undefined,
) =>
  hasAlchemyLabels(
    id,
    Object.fromEntries(
      Object.entries(annotations ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  );

export const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(annotations ?? {}).filter(
      ([key, value]) =>
        !key.startsWith("alchemy-") && typeof value === "string",
    ),
  ) as Record<string, string>;

const isAlreadyExists = (error: iam.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFound = (error: iam.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

export const waitForOperation = (
  operation: iam.GoogleLongrunningOperation,
  options?: { notFoundOk?: boolean },
): Effect.Effect<
  iam.GoogleLongrunningOperation,
  OperationFailed | OperationPending | iam.GetPoliciesOperationsError,
  iam.GcpOpContext
> =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (isAlreadyExists(operation.error)) return operation;
        if (options?.notFoundOk === true && isNotFound(operation.error)) {
          return operation;
        }
        return yield* new OperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (!name) {
      return yield* new OperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }
    return yield* iam.getPoliciesOperations({ name }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.fail(new OperationPending({ operation: name })),
      ),
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new OperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        if (!current.error) return Effect.succeed(current);
        if (isAlreadyExists(current.error)) return Effect.succeed(current);
        if (options?.notFoundOk === true && isNotFound(current.error)) {
          return Effect.succeed(current);
        }
        return Effect.fail(
          new OperationFailed({
            operation: name,
            message: current.error.message ?? "operation failed",
          }),
        );
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.IAM.OperationPending",
        times: 8,
        schedule: Schedule.spaced("2 seconds"),
      }),
    );
  });

export { alchemyLabelKeys, sanitizeLabelValue };
