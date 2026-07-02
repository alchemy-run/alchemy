import type {
  ProviderMetadataIndex,
  StackProviderMetadata,
} from "../Provider.ts";

/**
 * Cloud-specific analysis of {@link StackProviderMetadata} for AWS — the
 * union of IAM actions the stack's resources require. Consumed by the future
 * `alchemy aws create-policy` (least-privilege deploy-role generation) and by
 * error rendering on authorization failures.
 *
 * Every action carries the resource types that demanded it so output can
 * explain *why* a grant is needed.
 */
export interface AwsRequirements {
  /** IAM action → resource types requiring it (full lifecycle). */
  actions: Map<string, string[]>;
  /** IAM action → resource types requiring it (read/list/diff only). */
  readActions: Map<string, string[]>;
  /** Per-resource caveats from `iam.notes` (e.g. PassRole conditions). */
  notes: { resourceType: string; note: string }[];
}

const push = (
  map: Map<string, string[]>,
  key: string,
  resourceType: string,
) => {
  const list = map.get(key);
  if (list) list.push(resourceType);
  else map.set(key, [resourceType]);
};

/**
 * Union the `aws` metadata namespaces across the given index. Prefers the
 * exact-mode `used` subset; falls back to `all` (whole-cloud — over-asks)
 * when the stack couldn't be compiled.
 */
export const collectAwsRequirements = (
  metadata: StackProviderMetadata,
): AwsRequirements => {
  const index: ProviderMetadataIndex = metadata.used ?? metadata.all;
  const requirements: AwsRequirements = {
    actions: new Map(),
    readActions: new Map(),
    notes: [],
  };
  for (const [resourceType, entry] of index) {
    const iam = entry.aws?.iam;
    if (iam === undefined) continue;
    for (const action of iam.actions ?? []) {
      push(requirements.actions, action, resourceType);
    }
    for (const action of iam.readActions ?? []) {
      push(requirements.readActions, action, resourceType);
    }
    if (iam.notes) {
      requirements.notes.push({ resourceType, note: iam.notes });
    }
  }
  return requirements;
};

/**
 * Render the requirements as an IAM policy document (statements with
 * `Resource: "*"` — ARN-level least privilege is future work). `planOnly`
 * emits just the read tier.
 */
export const toPolicyDocument = (
  requirements: AwsRequirements,
  options?: { planOnly?: boolean },
) => ({
  Version: "2012-10-17" as const,
  Statement: [
    {
      Sid: options?.planOnly ? "AlchemyPlan" : "AlchemyDeploy",
      Effect: "Allow" as const,
      Action: [
        ...new Set(
          options?.planOnly
            ? requirements.readActions.keys()
            : [
                ...requirements.actions.keys(),
                ...requirements.readActions.keys(),
              ],
        ),
      ].sort(),
      Resource: "*" as const,
    },
  ],
});
