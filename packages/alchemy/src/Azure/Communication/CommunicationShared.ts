import * as communication from "@distilled.cloud/azure/communication";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Communication resources are global; data residency is `dataLocation`. */
export const GLOBAL_LOCATION = "global";

/** Default data residency for services and email services. */
export const DEFAULT_DATA_LOCATION = "United States";

export const lower = (value: string | undefined) => value?.toLowerCase();

/**
 * Deterministic name for a communication/email service or child: letters,
 * digits, and hyphens, starting and ending with a letter or digit.
 */
export const createCommunicationName = Effect.fn(function* (
  id: string,
  maxLength = 63,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
});

const ownedByStack = (tags: Record<string, string | undefined> | undefined) =>
  Effect.gen(function* () {
    const { stack, stage } = yield* stackAndStage;
    const record = tagRecord(tags);
    return (
      record["alchemy::stack"] === stack && record["alchemy::stage"] === stage
    );
  });

/**
 * Whether the email service is tagged as owned by the current stack and
 * stage. Untaggable children (sender usernames, suppression lists) inherit
 * ownership from it.
 */
export const isEmailServiceOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  emailServiceName: string,
) {
  const service = yield* orUndefinedIfNotFound(
    communication.GetEmailService({
      subscriptionId,
      resourceGroupName,
      emailServiceName,
    }),
  );
  return service !== undefined && (yield* ownedByStack(service.tags));
});

/**
 * Whether the communication service is tagged as owned by the current stack
 * and stage. Untaggable children (SMTP usernames) inherit ownership from it.
 */
export const isCommunicationServiceOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  communicationServiceName: string,
) {
  const service = yield* orUndefinedIfNotFound(
    communication.GetCommunicationService({
      subscriptionId,
      resourceGroupName,
      communicationServiceName,
    }),
  );
  return service !== undefined && (yield* ownedByStack(service.tags));
});
