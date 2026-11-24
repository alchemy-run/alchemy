import { createDomainOwnershipVerify } from "@distilled.cloud/prisma/management";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";
import { AuthoritativeRecordCheck } from "./AuthoritativeDns.ts";
import { DomainOwnershipOperationFailed } from "./DomainOwnership.ts";
import {
  type ApiDomainOwnership,
  attrsFrom,
  type DomainOwnershipProof,
  getOwnership,
  VERIFY_GIVE_UPS,
} from "./DomainOwnershipProof.ts";

export interface DomainOwnershipCheckProps {
  /** The row whose record this deploy published. */
  domainOwnershipId: string;
  /** Name of the published `TXT` record. */
  recordName: string;
  /** Value of the published `TXT` record. */
  recordValue: string;
}

/**
 * Prisma's answer for a domain ownership whose `TXT` record `Prisma.DomainOwnership`
 * published in this deploy: it waits for the record at the authoritative
 * nameservers, then asks Prisma to verify. It never fails because the record
 * is missing or Prisma has not verified it. Deleting it does nothing.
 */
export interface DomainOwnershipCheck extends Resource<
  "Prisma.DomainOwnershipCheck",
  DomainOwnershipCheckProps,
  DomainOwnershipProof["Attributes"],
  never,
  Providers
> {}

export const DomainOwnershipCheck = Resource<DomainOwnershipCheck>("Prisma.DomainOwnershipCheck");

/** How long a deploy waits for the published record at every authoritative nameserver. */
const RECORD_WAIT = Duration.minutes(3);

/** Seven verify requests, five seconds apart, until Prisma reports `verified`. */
const verifyUntilVerified = (ownership: ApiDomainOwnership) =>
  createDomainOwnershipVerify({ domainOwnershipId: ownership.id }).pipe(
    Effect.map((response) => response.data),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (checked) => checked.status === "verified",
      times: 6,
    }),
    Effect.catchTag(VERIFY_GIVE_UPS, () => Effect.succeed(ownership)),
  );

export const DomainOwnershipCheckProvider = () =>
  Provider.effect(
    DomainOwnershipCheck,
    Effect.gen(function* () {
      const checkRecord = yield* AuthoritativeRecordCheck;
      return {
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const visibility = yield* checkRecord(
            { type: "TXT", name: news.recordName, value: news.recordValue },
            {
              margin: "always",
              nameservers: "parent",
              attempts: "until-seen",
              waitFor: RECORD_WAIT,
            },
          );
          const ownership = yield* getOwnership(news.domainOwnershipId);
          if (ownership === undefined) {
            return yield* new DomainOwnershipOperationFailed({
              message: `Prisma domain ownership '${news.domainOwnershipId}' was deleted during the deploy.`,
            });
          }
          if (visibility === "absent" || ownership.status === "verified") {
            return attrsFrom(ownership);
          }
          return attrsFrom(yield* verifyUntilVerified(ownership));
        }),
        delete: Effect.fn(function* () {}),
      };
    }),
  );
