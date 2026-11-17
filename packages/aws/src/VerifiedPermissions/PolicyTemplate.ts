import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";

const unwrap = (v: string | Redacted.Redacted<string> | undefined) =>
  v === undefined ? undefined : Redacted.isRedacted(v) ? Redacted.value(v) : v;

export interface PolicyTemplateProps {
  /**
   * The ID of the policy store the template belongs to. Changing the store
   * replaces the template.
   */
  policyStoreId: string;
  /**
   * The Cedar policy-template statement. Templates use the `?principal` and
   * `?resource` placeholders which are filled in when a template-linked
   * policy is created, e.g.
   * `permit(principal == ?principal, action == PhotoApp::Action::"viewPhoto", resource);`.
   * Mutable — updating re-submits the statement via `UpdatePolicyTemplate`.
   */
  statement: string;
  /**
   * An optional description stored alongside the template statement.
   */
  description?: string;
}

export interface PolicyTemplate extends Resource<
  "AWS.VerifiedPermissions.PolicyTemplate",
  PolicyTemplateProps,
  {
    /**
     * ID of the policy store the template belongs to.
     */
    policyStoreId: string;
    /**
     * Service-assigned unique ID of the policy template within the store —
     * pass it as the `templateId` of a template-linked {@link Policy}.
     */
    policyTemplateId: string;
  },
  {},
  Providers,
  PolicyTemplateLookup
> {}

/**
 * Props for {@link PolicyTemplate.lookup}: find a policy template this stack doesn't
 * manage, in the ambient account and region.
 */
export interface PolicyTemplateLookup {
  /** The policy store the template belongs to. */
  policyStoreId: string;
  /** The id of the existing template. */
  policyTemplateId: string;
}

/**
 * A Cedar policy template in a Verified Permissions policy store. Templates
 * contain `?principal` / `?resource` placeholders; template-linked policies
 * instantiate the template for a concrete principal and resource, and every
 * linked policy automatically picks up template updates.
 * ### Creating Policy Templates
 * **Example:** Template with a Principal Placeholder
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 *
 * const store = yield* AWS.VerifiedPermissions.PolicyStore("Store", {});
 *
 * const template = yield* AWS.VerifiedPermissions.PolicyTemplate("ViewPhoto", {
 *   policyStoreId: store.policyStoreId,
 *   statement: `permit(
 *     principal == ?principal,
 *     action == PhotoApp::Action::"viewPhoto",
 *     resource
 *   );`,
 *   description: "Grant a user access to view photos",
 * });
 * ```
 *
 * **Example:** Link a Policy to the Template
 * ```typescript
 * yield* AWS.VerifiedPermissions.Policy("AliceCanView", {
 *   policyStoreId: store.policyStoreId,
 *   templateId: template.policyTemplateId,
 *   principal: { entityType: "PhotoApp::User", entityId: "alice" },
 * });
 * ```
 *
 * ### Looking up an existing policy template
 * `PolicyTemplate.lookup` references a policy template Alchemy doesn't manage (created in the
 * console or by another stack), found by `policyStoreId` and `policyTemplateId`. It is read during
 * plan/deploy and never created, updated or deleted.
 *
 * **Example:** Reference an existing policy template
 * ```typescript
 * const owner = AWS.VerifiedPermissions.PolicyTemplate.lookup({ policyStoreId, policyTemplateId });
 * ```
 *
 * @resource
 */
export const PolicyTemplate = Resource<PolicyTemplate>("AWS.VerifiedPermissions.PolicyTemplate");

export const PolicyTemplateProvider = () =>
  Provider.effect(
    PolicyTemplate,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (policyStoreId: string, policyTemplateId: string) {
        return yield* avp
          .getPolicyTemplate({ policyStoreId, policyTemplateId })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
      });

      return PolicyTemplate.Provider.of({
        stables: ["policyStoreId", "policyTemplateId"],

        // child of a policy store — not enumerable account-wide
        list: () => Effect.succeed([]),

        lookup: Effect.fn(function* ({ policyStoreId, policyTemplateId }) {
          const template = yield* observe(policyStoreId, policyTemplateId);
          return template === undefined
            ? undefined
            : { policyStoreId, policyTemplateId: template.policyTemplateId };
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const policyStoreId = output?.policyStoreId ?? olds?.policyStoreId;
          const policyTemplateId = output?.policyTemplateId;
          if (policyStoreId === undefined || policyTemplateId === undefined) {
            return undefined;
          }
          const template = yield* observe(policyStoreId, policyTemplateId);
          if (template === undefined) return undefined;
          return { policyStoreId, policyTemplateId: template.policyTemplateId };
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds.policyStoreId !== news.policyStoreId) {
            return { action: "replace" } as const;
          }
          // statement / description are mutable → default update path
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // 1. OBSERVE — cloud state is authoritative
          const existing =
            output?.policyTemplateId !== undefined
              ? yield* observe(news.policyStoreId, output.policyTemplateId)
              : undefined;

          // 2. ENSURE
          if (existing === undefined) {
            const created = yield* avp.createPolicyTemplate({
              policyStoreId: news.policyStoreId,
              statement: news.statement,
              description: news.description,
            });
            yield* session.note(created.policyTemplateId);
            return {
              policyStoreId: news.policyStoreId,
              policyTemplateId: created.policyTemplateId,
            };
          }

          // 3. SYNC — diff observed statement/description against desired
          const observedStatement = unwrap(existing.statement);
          const observedDescription = unwrap(existing.description);
          if (
            observedStatement !== news.statement ||
            observedDescription !== (news.description ?? undefined)
          ) {
            yield* avp.updatePolicyTemplate({
              policyStoreId: news.policyStoreId,
              policyTemplateId: existing.policyTemplateId,
              statement: news.statement,
              description: news.description,
            });
          }

          yield* session.note(existing.policyTemplateId);
          return {
            policyStoreId: news.policyStoreId,
            policyTemplateId: existing.policyTemplateId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* avp
            .deletePolicyTemplate({
              policyStoreId: output.policyStoreId,
              policyTemplateId: output.policyTemplateId,
            })
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
        }),
      });
    }),
  );
