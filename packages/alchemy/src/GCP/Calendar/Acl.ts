import * as calendar from "@distilled.cloud/gcp/calendar_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type AclRuleScope,
  aclRuleIdOf,
  findAcl,
  getAcl,
  ignoreMissing,
  isManagedAcl,
  listManagedAcls,
  sameText,
  scopeOf,
} from "./internal.ts";

export type AclProps = {
  /**
   * Parent calendar id. Immutable — changing it replaces the rule.
   */
  calendarId: string;
  /**
   * ACL rule id (`user:email`, `group:email`, `domain:name`, or
   * `default`). Server-assigned from `scope` on create. Immutable —
   * changing it replaces the rule.
   */
  ruleId?: string;
  /**
   * Role granted to the scope: `none`, `freeBusyReader`, `reader`,
   * `writer`, or `owner`.
   */
  role: string;
  /**
   * Scope of the rule. Type is `default`, `user`, `group`, or
   * `domain`. Immutable — changing it replaces the rule.
   */
  scope: AclRuleScope;
  /**
   * Send sharing notifications. Create-only.
   * @default false
   */
  sendNotifications?: boolean;
};

export type Acl = Resource<
  "GCP.Calendar.Acl",
  AclProps,
  {
    /** ACL rule id. */
    ruleId: string;
    /** Parent calendar id. */
    calendarId: string;
    /** Project id used when the rule was reconciled. */
    project: string;
    /** Role. */
    role: string | undefined;
    /** Scope. */
    scope: AclRuleScope | undefined;
    /** ETag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An access control rule on a Google Calendar.
 *
 * ACL rules have no labels or description, so Alchemy lists non-owner
 * rules on alchemy-owned calendars for `list` / nuke. Parent calendar
 * and scope are identity — changing them replaces the rule. Role
 * updates in place.
 *
 * ### Creating a Rule
 * **Example:** Share with a user as a reader
 * ```typescript
 * const rule = yield* GCP.Calendar.Acl("Ada", {
 *   calendarId: cal.calendarId,
 *   role: "reader",
 *   scope: { type: "user", value: "ada@example.com" },
 *   sendNotifications: false,
 * });
 * ```
 *
 * ### Updating a Rule
 * **Example:** Promote to writer
 * ```typescript
 * const rule = yield* GCP.Calendar.Acl("Ada", {
 *   calendarId: existing.calendarId,
 *   ruleId: existing.ruleId,
 *   role: "writer",
 *   scope: { type: "user", value: "ada@example.com" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Calendar
 */
export const Acl = Resource<Acl>("GCP.Calendar.Acl");

export class AclNotResolved extends Data.TaggedError(
  "GCP.Calendar.AclNotResolved",
)<{
  calendarId: string;
  ruleId: string;
}> {}

const toAttrs = (
  rule: calendar.AclRule,
  calendarId: string,
  project: string,
) => ({
  ruleId: rule.id ?? "",
  calendarId,
  project,
  role: rule.role,
  scope: scopeOf(rule.scope),
  etag: rule.etag,
});

export const AclProvider = () =>
  Provider.succeed(Acl, {
    stables: ["ruleId", "calendarId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCalendar = olds?.calendarId ?? output?.calendarId;
      if (
        previousCalendar !== undefined &&
        news.calendarId !== previousCalendar
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.ruleId ?? output?.ruleId;
      const nextId = news.ruleId ?? aclRuleIdOf(news.scope);
      if (
        previousId !== undefined &&
        nextId.length > 0 &&
        nextId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousType = olds?.scope?.type ?? output?.scope?.type;
      if (
        previousType !== undefined &&
        news.scope.type !== undefined &&
        news.scope.type !== previousType
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousValue = (
        olds?.scope?.value ??
        output?.scope?.value ??
        ""
      ).toLowerCase();
      const nextValue = (news.scope.value ?? "").toLowerCase();
      if (
        nextValue.length > 0 &&
        previousValue.length > 0 &&
        nextValue !== previousValue
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const calendarId = olds?.calendarId ?? output?.calendarId ?? "";
      const existing = yield* findAcl(calendarId, {
        ruleId: olds?.ruleId ?? output?.ruleId,
        scope: olds?.scope ?? output?.scope,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, calendarId, env.project);
      return output !== undefined || isManagedAcl(existing)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rules = yield* listManagedAcls();
        return rules.map((rule) => toAttrs(rule, rule.calendarId, env.project));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const calendarId = news.calendarId;
      const desired: calendar.AclRule = {
        role: news.role,
        scope: news.scope,
      };

      let current = yield* findAcl(calendarId, {
        ruleId: news.ruleId ?? output?.ruleId,
        scope: news.scope,
      });

      if (current === undefined) {
        const created = yield* calendar
          .insertAcl({
            calendarId,
            sendNotifications: news.sendNotifications ?? false,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findAcl(calendarId, {
                ruleId: news.ruleId ?? output?.ruleId,
                scope: news.scope,
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AclNotResolved({
          calendarId,
          ruleId: news.ruleId ?? output?.ruleId ?? aclRuleIdOf(news.scope),
        });
      }

      const ruleId =
        current.id ?? news.ruleId ?? output?.ruleId ?? aclRuleIdOf(news.scope);
      const roleChanged =
        news.role !== undefined && !sameText(current.role, news.role);

      if (roleChanged) {
        current = yield* calendar.patchAcl({
          calendarId,
          ruleId,
          sendNotifications: news.sendNotifications ?? false,
          body: { role: news.role },
        });
      }

      const fresh = yield* getAcl(calendarId, ruleId);
      return toAttrs(fresh ?? current, calendarId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.calendarId.length === 0 || output.ruleId.length === 0) {
        return;
      }
      yield* ignoreMissing(
        calendar.deleteAcl({
          calendarId: output.calendarId,
          ruleId: output.ruleId,
        }),
      );
    }),
  });
