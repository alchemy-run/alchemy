/**
 * Credential requirements an AWS resource provider declares via
 * `metadata.aws`. Consumed by deploy-time preflight (rendering the required
 * actions on authorization failures), a future `alchemy aws create-policy`
 * (least-privilege deploy-role policy generation), and generated docs. See
 * `processes/ProviderMetadata/DESIGN.md`.
 *
 * Values must be plain literals — no `Output`s, Effects, or environment reads.
 */
export interface AwsProviderMetadata {
  iam?: {
    /**
     * IAM actions the full lifecycle (precreate/reconcile/delete) may call,
     * e.g. `"s3:CreateBucket"`. Derived from the operations the provider's
     * lifecycle code actually invokes.
     */
    actions?: string[];
    /**
     * Narrower set sufficient for read/list/diff/logs/tail (plan-only).
     * @default actions
     */
    readActions?: string[];
    /**
     * Free-form caveats surfaced in docs and preflight output — e.g.
     * "requires iam:PassRole on the function role".
     */
    notes?: string;
  };
}

declare module "../Provider.ts" {
  interface AlchemyProviderMetadata {
    aws?: AwsProviderMetadata;
  }
}
