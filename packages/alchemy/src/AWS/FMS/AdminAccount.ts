import * as fms from "@distilled.cloud/aws/fms";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface AdminAccountProps {
  /**
   * The AWS account ID to designate as the AWS Firewall Manager administrator
   * account for the organization. Must be an account in the same AWS
   * Organization as the caller (which must be the Organizations management
   * account). If omitted, the caller's account is used.
   */
  adminAccount?: string;
}

/** @resource */
export interface AdminAccount extends Resource<
  "AWS.FMS.AdminAccount",
  AdminAccountProps,
  {
    /** The account designated as the FMS administrator. */
    adminAccount: string;
    /** Status of the FMS administrator IAM role (`READY` / `CREATING` / ...). */
    roleStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The AWS Firewall Manager administrator account — an organization-level
 * singleton that designates which account manages FMS security policies.
 *
 * :::caution
 * FMS requires the caller to be the AWS Organizations **management account**,
 * and the organization must have AWS Config enabled. On accounts that are not
 * an Organizations management account this resource fails at association time
 * with a typed `InvalidOperationException`.
 * :::
 *
 * This is a capture-and-restore singleton: FMS exposes no tags, so ownership is
 * tracked by Alchemy state — adopting a pre-existing admin account that Alchemy
 * did not create requires `--adopt`, and destroy disassociates the admin.
 *
 * @section Designating the FMS admin
 * @example Designate the caller as the FMS admin
 * ```typescript
 * const admin = yield* FMS.AdminAccount("FmsAdmin", {});
 * ```
 *
 * @example Designate a specific member account
 * ```typescript
 * const admin = yield* FMS.AdminAccount("FmsAdmin", {
 *   adminAccount: "123456789012",
 * });
 * ```
 */
const AdminAccountResource = Resource<AdminAccount>("AWS.FMS.AdminAccount");

export { AdminAccountResource as AdminAccount };

// `getAdminAccount` throws `ResourceNotFoundException` when no FMS admin has
// been designated — collapse to `undefined`.
const getAdmin = fms.getAdminAccount({}).pipe(
  Effect.map((r) => r as fms.GetAdminAccountResponse | undefined),
  Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)),
);

export const AdminAccountProvider = () =>
  Provider.effect(
    AdminAccountResource,
    Effect.gen(function* () {
      // Association is asynchronous; the FMS role transitions CREATING → READY.
      const waitUntilReady = getAdmin.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (a) => a?.RoleStatus === "READY",
          times: 20,
        }),
      );

      return {
        read: Effect.fn(function* ({ output }) {
          const admin = yield* getAdmin;
          if (!admin?.AdminAccount) return undefined;
          const attrs = {
            adminAccount: admin.AdminAccount,
            roleStatus: admin.RoleStatus,
          };
          // FMS admin has no tags — ownership can't be verified from the cloud.
          // With no prior state, treat an existing admin as foreign.
          return output ? attrs : Unowned(attrs);
        }),

        // Organization-level singleton — report the single admin account.
        list: () =>
          getAdmin.pipe(
            Effect.map((a) =>
              a?.AdminAccount
                ? [{ adminAccount: a.AdminAccount, roleStatus: a.RoleStatus }]
                : [],
            ),
          ),

        reconcile: Effect.fn(function* ({ news = {}, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const desired = news.adminAccount ?? accountId;

          // 1. OBSERVE
          let admin = yield* getAdmin;

          // 2. ENSURE — associate the admin account if none is set.
          if (!admin?.AdminAccount) {
            yield* fms.associateAdminAccount({ AdminAccount: desired });
            admin = yield* waitUntilReady;
          }

          // 3. RETURN fresh attributes.
          const final = yield* getAdmin;
          yield* session.note(desired);
          return {
            adminAccount: final?.AdminAccount ?? desired,
            roleStatus: final?.RoleStatus,
          };
        }),

        delete: Effect.fn(function* () {
          yield* fms.disassociateAdminAccount({}).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.catchTag("InvalidOperationException", () => Effect.void),
          );
        }),
      };
    }),
  );
