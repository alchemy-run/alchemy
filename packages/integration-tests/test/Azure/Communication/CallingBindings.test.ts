import * as Azure from "@alchemy.run/azure";
import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as identity from "@distilled.cloud/azure/communication-identity";
import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as rooms from "@distilled.cloud/azure/communication-rooms";
import * as sipRouting from "@distilled.cloud/azure/communication-sip-routing";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import CommunicationCallingFunction, { Acs } from "./fixtures/calling-function.ts";

// Bindings over the Call Automation, Job Router, Advanced Messaging, Phone
// Numbers, and SIP routing data planes. Kept apart from `Bindings.test.ts`
// (Email, SMS, Identity, Rooms, Chat) so each suite deploys only the
// service and bindings it drives.

const {
  test: baseTest,
  beforeAll,
  afterAll,
  deploy,
  destroy,
} = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureCommunicationCallingBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* CommunicationCallingFunction;
    const acs = yield* Acs;
    return { url: fn.url, endpoint: acs.endpoint };
  }),
);

// A communication service is free (billed per use: every call here is a
// free read, a free Job Router write, or an unanswered call) + a Flex
// Consumption app; ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Azure credentials and environment for out-of-band checks as the deployer. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

const live = { timeout: 600_000 };

/** A test whose body also gets the deployer's Azure credentials for out-of-band checks. */
const test = <A, E>(name: string, body: Effect.Effect<A, E, any>, options = live) =>
  baseTest(name, body.pipe(Effect.provide(azure)), options);

type Body = { ok: boolean; result?: any; error?: string };

/** POST the binding's request to `/<binding>` once. */
const post = (binding: string, request: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${url}/${binding}`).pipe(HttpClientRequest.bodyJsonUnsafe(request)),
    ).pipe(Effect.timeout("60 seconds"));
    return (yield* response.json) as Body;
  });

/**
 * Whether a failed answer is the host starting (no JSON yet), the role
 * still propagating (the data plane answers 401/403), or throttling.
 */
const transient = (body: Body | undefined) =>
  body?.ok === undefined ||
  /^(Unauthorized|Forbidden|RequestRateLimitExceeded|TooManyRequests|ServiceUnavailable|TimeoutError)\b/.test(
    body.error ?? "",
  );

/**
 * Call a binding, retrying through the Flex Consumption cold start and role
 * propagation only, then return the answer so a real failure shows its
 * Azure error.
 */
const call = (binding: string, request: unknown = {}) =>
  post(binding, request).pipe(
    Effect.flatMap((body) => (transient(body) ? Effect.fail(body) : Effect.succeed(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 72 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

/**
 * Call a binding whose call fails with the typed error `tag` (a probe),
 * retrying through the cold start and role propagation only.
 */
const probe = (binding: string, request: unknown, tag: string) =>
  post(binding, request).pipe(
    Effect.flatMap((body) =>
      body?.error?.includes(tag) || !transient(body) ? Effect.succeed(body) : Effect.fail(body),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 72 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The probe failed with `tag`, not with an untyped or unrelated error. */
const expectTag = (body: Body, tag: string) =>
  expect({ ok: body.ok, typed: body.error?.includes(tag) ?? false, error: body.error }).toEqual({
    ok: false,
    typed: true,
    error: body.error,
  });

const endpoint = Effect.map(stack, ({ endpoint }) => endpoint!);

/** The tag of an out-of-band failure, or `"ok"`. */
const outcome = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("ok" as string),
    Effect.catch((e) => Effect.succeed(e._tag)),
  );

/** Poll an out-of-band read until it fails with `tag`. */
const waitTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
  tag: string,
) =>
  outcome(effect).pipe(
    Effect.repeat({ schedule: Schedule.spaced("2 seconds"), until: (t) => t === tag, times: 15 }),
  );

/** Last path segment of an operation URL (`.../searchResults/<id>?api-version=...`). */
const lastSegment = (url: string) => new URL(url, "https://localhost").pathname.split("/").pop()!;

const NO_SUCH_ID = "00000000-0000-0000-0000-000000000000";

// Reservation IDs are request data, not resource names: an expired
// reservation keeps its ID and cannot be updated or deleted, so each case
// reserves under a fresh one.

/**
 * A well-formed recording ID that names no recording: unpadded base64 of
 * `{"PlatformEndpointId":"<NO_SUCH_ID>","ResourceSpecificId":"<NO_SUCH_ID>"}`.
 */
const NO_SUCH_RECORDING =
  "eyJQbGF0Zm9ybUVuZHBvaW50SWQiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAiLCJSZXNvdXJjZVNwZWNpZmljSWQiOiIwMDAwMDAwMC0wMDAwLTAwMDAtMDAwMC0wMDAwMDAwMDAwMDAifQ";

describe(
  "Azure Communication Services calling and routing bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:communication", "live"] },
  () => {
    // --- SIP routing ---------------------------------------------------

    describe("GetSipRouting", () => {
      test(
        "reads the service's SIP configuration",
        Effect.gen(function* () {
          const body = yield* call("GetSipRouting");
          expectOk(body);
          const url = yield* endpoint;
          const observed = yield* sipRouting.GetSipRouting({ endpoint: url });
          expect(body.result).toEqual(observed);
        }),
      );
    });

    describe("UpdateSipRouting", () => {
      test(
        "replaces the route list",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const route = { name: "alchemy-binding", numberPattern: "^\\+1425[0-9]{7}$" };
          const body = yield* call("UpdateSipRouting", { routes: [route] });
          expectOk(body);
          const observed = yield* sipRouting.GetSipRouting({ endpoint: url });
          expect(
            observed.routes?.map((r) => ({ name: r.name, numberPattern: r.numberPattern })),
          ).toEqual([route]);
          yield* sipRouting.UpdateSipRouting({ endpoint: url, routes: [] });
        }),
      );
    });

    // --- Phone Numbers -------------------------------------------------

    describe("ListPhoneNumberCountries", () => {
      test(
        "lists the countries with phone numbers",
        Effect.gen(function* () {
          const body = yield* call("ListPhoneNumberCountries");
          expectOk(body);
          const observed = yield* phoneNumbers.ListPhoneNumberAvailableCountries({
            endpoint: yield* endpoint,
          });
          const codes = (page: { countries: readonly { countryCode: string }[] }) =>
            page.countries.map((c) => c.countryCode).sort();
          expect(codes(body.result)).toEqual(codes(observed));
          expect(codes(body.result)).toContain("US");
        }),
      );
    });

    describe("ListPhoneNumberAreaCodes", () => {
      test(
        "lists US toll-free area codes",
        Effect.gen(function* () {
          const request = {
            countryCode: "US",
            phoneNumberType: "tollFree",
            assignmentType: "application",
          } as const;
          const body = yield* call("ListPhoneNumberAreaCodes", request);
          expectOk(body);
          const observed = yield* phoneNumbers.ListPhoneNumberAreaCodes({
            endpoint: yield* endpoint,
            ...request,
          });
          const codes = (page: phoneNumbers.PhoneNumberAreaCodes) =>
            page.areaCodes.map((a) => a.areaCode).sort();
          expect(codes(body.result)).toEqual(codes(observed));
          expect(codes(body.result).length).toBeGreaterThan(0);
          expect(codes(body.result).every((code) => /^8[0-9]{2}$/.test(code ?? ""))).toBe(true);
        }),
      );
    });

    describe("ListPhoneNumberLocalities", () => {
      test(
        "lists US localities",
        Effect.gen(function* () {
          const body = yield* call("ListPhoneNumberLocalities", { countryCode: "US" });
          expectOk(body);
          const observed = yield* phoneNumbers.ListPhoneNumberAvailableLocalities({
            endpoint: yield* endpoint,
            countryCode: "US",
          });
          const names = (page: phoneNumbers.PhoneNumberLocalities) =>
            page.phoneNumberLocalities.map((l) => l.localizedName).sort();
          expect(names(body.result)).toEqual(names(observed));
        }),
      );
    });

    describe("ListPhoneNumberOfferings", () => {
      test(
        "lists US offerings",
        Effect.gen(function* () {
          const body = yield* call("ListPhoneNumberOfferings", { countryCode: "US" });
          expectOk(body);
          const observed = yield* phoneNumbers.ListPhoneNumberOfferings({
            endpoint: yield* endpoint,
            countryCode: "US",
          });
          expect(body.result.phoneNumberOfferings.length).toEqual(
            observed.phoneNumberOfferings.length,
          );
        }),
      );
    });

    describe("ListPhoneNumbers", () => {
      test(
        "lists the service's numbers (none)",
        Effect.gen(function* () {
          const body = yield* call("ListPhoneNumbers");
          expectOk(body);
          const observed = yield* phoneNumbers.ListPhoneNumberPhoneNumbers({
            endpoint: yield* endpoint,
          });
          expect(body.result.phoneNumbers).toEqual(observed.phoneNumbers);
        }),
      );
    });

    describe("BrowsePhoneNumbers", () => {
      test(
        "browses US toll-free numbers",
        Effect.gen(function* () {
          const body = yield* call("BrowsePhoneNumbers", {
            countryCode: "US",
            phoneNumberType: "tollFree",
          });
          expectOk(body);
          const numbers: phoneNumbers.AvailablePhoneNumber[] = body.result.phoneNumbers;
          expect(numbers.length).toBeGreaterThan(0);
          expect(numbers.every((n) => n.countryCode === "US")).toBe(true);
        }),
      );
    });

    /** Out of band: one browsed US toll-free number, as a reservation entry. */
    const browsedNumber = Effect.gen(function* () {
      const browsed = yield* phoneNumbers.PhoneNumbersBrowseAvailableNumbers({
        endpoint: yield* endpoint,
        countryCode: "US",
        phoneNumberType: "tollFree",
      });
      return browsed.phoneNumbers[0]!;
    });

    describe("UpsertPhoneNumberReservation", () => {
      test(
        "reserves a number",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const number = yield* browsedNumber;
          const reservationId = yield* Effect.sync(() => crypto.randomUUID());
          const body = yield* call("UpsertPhoneNumberReservation", {
            reservationId,
            phoneNumbers: { [number.id!]: number },
          });
          expectOk(body);
          const observed = yield* phoneNumbers.GetPhoneNumberReservation({
            endpoint: url,
            reservationId,
          });
          expect(Object.keys(observed.phoneNumbers ?? {})).toEqual([number.id]);
          yield* phoneNumbers.DeletePhoneNumberReservation({ endpoint: url, reservationId });
        }),
      );
    });

    describe("GetPhoneNumberReservation", () => {
      test(
        "reads a reservation",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const number = yield* browsedNumber;
          const reservationId = yield* Effect.sync(() => crypto.randomUUID());
          yield* phoneNumbers.PhoneNumbersCreateOrUpdateReservation({
            endpoint: url,
            reservationId,
            phoneNumbers: { [number.id!]: number },
          });
          const body = yield* call("GetPhoneNumberReservation", { reservationId });
          expectOk(body);
          expect(Object.keys(body.result.phoneNumbers)).toEqual([number.id]);
          yield* phoneNumbers.DeletePhoneNumberReservation({ endpoint: url, reservationId });
        }),
      );
    });

    describe("ListPhoneNumberReservations", () => {
      test(
        "lists reservations",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const number = yield* browsedNumber;
          const reservationId = yield* Effect.sync(() => crypto.randomUUID());
          yield* phoneNumbers.PhoneNumbersCreateOrUpdateReservation({
            endpoint: url,
            reservationId,
            phoneNumbers: { [number.id!]: number },
          });
          const body = yield* call("ListPhoneNumberReservations");
          expectOk(body);
          const ids = (body.result.reservations as { id: string }[]).map((r) => r.id);
          expect(ids).toContain(reservationId);
          yield* phoneNumbers.DeletePhoneNumberReservation({ endpoint: url, reservationId });
        }),
      );
    });

    describe("DeletePhoneNumberReservation", () => {
      test(
        "deletes a reservation",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const number = yield* browsedNumber;
          const reservationId = yield* Effect.sync(() => crypto.randomUUID());
          yield* phoneNumbers.PhoneNumbersCreateOrUpdateReservation({
            endpoint: url,
            reservationId,
            phoneNumbers: { [number.id!]: number },
          });
          const body = yield* call("DeletePhoneNumberReservation", { reservationId });
          expectOk(body);
          const tag = yield* waitTag(
            phoneNumbers.GetPhoneNumberReservation({ endpoint: url, reservationId }),
            "PhoneNumberReservationNotFound",
          );
          expect(tag).toEqual("PhoneNumberReservationNotFound");
        }),
      );
    });

    let sharedSearch: { operationId: string; searchId: string } | undefined;

    describe("SearchPhoneNumbers", () => {
      test(
        "starts a search that finds a number",
        Effect.gen(function* () {
          const body = yield* call("SearchPhoneNumbers", {
            countryCode: "US",
            phoneNumberType: "tollFree",
            assignmentType: "application",
            capabilities: { calling: "outbound", sms: "none" },
            quantity: 1,
          });
          expectOk(body);
          const operationId = lastSegment(body.result.operationLocation);
          const searchId = lastSegment(body.result.location);
          const operation = yield* phoneNumbers
            .GetPhoneNumberOperation({ endpoint: yield* endpoint, operationId })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("3 seconds"),
                until: (o) => o.status === "succeeded" || o.status === "failed",
                times: 20,
              }),
            );
          expect({ type: operation.operationType, status: operation.status }).toEqual({
            type: "search",
            status: "succeeded",
          });
          sharedSearch = { operationId, searchId };
        }),
      );
    });

    /**
     * Out of band: a finished search for one US toll-free number. Back-to-back
     * searches on one service answered HTTP 400 "internal error" in
     * testing, so the cases share the `SearchPhoneNumbers` case's search,
     * and `CancelPhoneNumberOperation` (last) cancels it.
     */
    const search = Effect.gen(function* () {
      const url = yield* endpoint;
      const started = yield* phoneNumbers.SearchPhoneNumberAvailablePhoneNumbers({
        endpoint: url,
        countryCode: "US",
        phoneNumberType: "tollFree",
        assignmentType: "application",
        capabilities: { calling: "outbound", sms: "none" },
        quantity: 1,
      });
      const operationId = lastSegment(started.operationLocation!);
      yield* phoneNumbers.GetPhoneNumberOperation({ endpoint: url, operationId }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (o) => o.status === "succeeded" || o.status === "failed",
          times: 20,
        }),
      );
      return { operationId, searchId: lastSegment(started.location!) };
    });
    const finishedSearch = Effect.gen(function* () {
      sharedSearch ??= yield* search;
      return sharedSearch;
    });

    describe("GetPhoneNumberSearchResult", () => {
      test(
        "reads a search result",
        Effect.gen(function* () {
          const { searchId } = yield* finishedSearch;
          const body = yield* call("GetPhoneNumberSearchResult", { searchId });
          expectOk(body);
          expect(body.result.searchId).toEqual(searchId);
          expect(body.result.phoneNumbers.length).toEqual(1);
        }),
      );
    });

    describe("GetPhoneNumberOperation", () => {
      test(
        "reads a search operation",
        Effect.gen(function* () {
          const { operationId } = yield* finishedSearch;
          const body = yield* call("GetPhoneNumberOperation", { operationId });
          expectOk(body);
          expect({ id: body.result.id, type: body.result.operationType }).toEqual({
            id: operationId,
            type: "search",
          });
        }),
      );
    });

    describe("CancelPhoneNumberOperation", () => {
      test(
        "cancels a finished search, which then no longer resolves",
        Effect.gen(function* () {
          const { operationId } = yield* finishedSearch;
          const body = yield* call("CancelPhoneNumberOperation", { operationId });
          expectOk(body);
          const tag = yield* waitTag(
            phoneNumbers.GetPhoneNumberOperation({ endpoint: yield* endpoint, operationId }),
            "PhoneNumberOperationNotFound",
          );
          expect(tag).toEqual("PhoneNumberOperationNotFound");
        }),
      );
    });

    describe("SearchPhoneNumberOperatorInformation", () => {
      test(
        "formats a phone number",
        Effect.gen(function* () {
          const body = yield* call("SearchPhoneNumberOperatorInformation", {
            phoneNumbers: ["+14255550123"],
            options: { includeAdditionalOperatorDetails: false },
          });
          expectOk(body);
          expect(body.result.values[0].phoneNumber).toEqual("+14255550123");
        }),
      );
    });

    describe("GetPhoneNumber", () => {
      test(
        "fails typed for a number the service does not own",
        Effect.gen(function* () {
          const body = yield* probe(
            "GetPhoneNumber",
            { phoneNumber: "+18005550100" },
            "PhoneNumberNotFound",
          );
          expectTag(body, "PhoneNumberNotFound");
        }),
      );
    });

    describe("ReleasePhoneNumber", () => {
      test(
        "starts a release operation (a no-op for a number the service does not own)",
        Effect.gen(function* () {
          const body = yield* call("ReleasePhoneNumber", { phoneNumber: "+18005550100" });
          expectOk(body);
          const operation = yield* phoneNumbers.GetPhoneNumberOperation({
            endpoint: yield* endpoint,
            operationId: lastSegment(body.result.operationLocation),
          });
          expect(operation.operationType).toEqual("releasePhoneNumber");
        }),
      );
    });

    describe("UpdatePhoneNumberCapabilities", () => {
      test(
        "fails typed for a number the service does not own",
        Effect.gen(function* () {
          const body = yield* probe(
            "UpdatePhoneNumberCapabilities",
            { phoneNumber: "+18005550100", calling: "inbound+outbound", sms: "none" },
            "PhoneNumberNotOwned",
          );
          expectTag(body, "PhoneNumberNotOwned");
        }),
      );
    });

    describe("PurchasePhoneNumbers", () => {
      // ~$2/month per US toll-free number (released at the end), 3 min.
      baseTest.skipIf(!runPaidOnly)(
        "purchases a searched number, then updates and releases it",
        Effect.gen(function* () {
          const url = yield* endpoint;
          const { searchId } = yield* finishedSearch;
          const result = yield* phoneNumbers.PhoneNumbersGetSearchResult({
            endpoint: url,
            searchId,
          });
          const number = result.phoneNumbers[0]!;
          const bought = yield* call("PurchasePhoneNumbers", { searchId, agreeToNotResell: true });
          expectOk(bought);
          const owned = yield* call("GetPhoneNumber", { phoneNumber: number });
          expectOk(owned);
          expect(owned.result.phoneNumber).toEqual(number);
          const updated = yield* call("UpdatePhoneNumberCapabilities", {
            phoneNumber: number,
            calling: "inbound+outbound",
            sms: "none",
          });
          expectOk(updated);
          const released = yield* call("ReleasePhoneNumber", { phoneNumber: number });
          expectOk(released);
          const tag = yield* waitTag(
            phoneNumbers.GetPhoneNumberByNumber({ endpoint: url, phoneNumber: number }),
            "PhoneNumberNotFound",
          );
          expect(tag).toEqual("PhoneNumberNotFound");
        }).pipe(Effect.provide(azure)),
        live,
      );
      test(
        "fails typed for a search that does not exist",
        Effect.gen(function* () {
          const body = yield* probe(
            "PurchasePhoneNumbers",
            { searchId: NO_SUCH_ID, agreeToNotResell: true },
            "PhoneNumberSearchNotFound",
          );
          expectTag(body, "PhoneNumberSearchNotFound");
        }),
      );
    });

    describe("PurchasePhoneNumberReservation", () => {
      test(
        "fails typed for a reservation that does not exist",
        Effect.gen(function* () {
          const body = yield* probe(
            "PurchasePhoneNumberReservation",
            { reservationId: NO_SUCH_ID, agreeToNotResell: true },
            "PhoneNumberReservationNotFound",
          );
          expectTag(body, "PhoneNumberReservationNotFound");
        }),
      );
    });

    // --- Job Router ----------------------------------------------------

    const router = Effect.map(endpoint, (url) => ({ endpoint: url }));

    describe("UpsertRouterDistributionPolicy", () => {
      test(
        "creates a distribution policy",
        Effect.gen(function* () {
          const body = yield* call("UpsertRouterDistributionPolicy", {
            distributionPolicyId: "alchemy-upsert-dp",
            offerExpiresAfterSeconds: 60,
            mode: { kind: "longestIdle" },
          });
          expectOk(body);
          const observed = yield* jobRouter.GetJobRouterAdministrationOperationDistributionPolicy({
            ...(yield* router),
            distributionPolicyId: "alchemy-upsert-dp",
          });
          expect({ offer: observed.offerExpiresAfterSeconds, mode: observed.mode?.kind }).toEqual({
            offer: 60,
            mode: "longestIdle",
          });
        }),
      );
    });

    /** Out of band: a longest-idle distribution policy with this ID. */
    const distributionPolicy = (distributionPolicyId: string) =>
      Effect.gen(function* () {
        return yield* jobRouter.UpsertJobRouterAdministrationOperationDistributionPolicy({
          ...(yield* router),
          distributionPolicyId,
          offerExpiresAfterSeconds: 300,
          mode: { kind: "longestIdle" },
        });
      });

    /** Out of band: a queue with this ID on its own distribution policy. */
    const queue = (queueId: string) =>
      Effect.gen(function* () {
        yield* distributionPolicy(`${queueId}-dp`);
        return yield* jobRouter.UpsertJobRouterAdministrationOperationQueue({
          ...(yield* router),
          queueId,
          distributionPolicyId: `${queueId}-dp`,
        });
      });

    describe("GetRouterDistributionPolicy", () => {
      test(
        "reads a distribution policy",
        Effect.gen(function* () {
          yield* distributionPolicy("alchemy-get-dp");
          const body = yield* call("GetRouterDistributionPolicy", {
            distributionPolicyId: "alchemy-get-dp",
          });
          expectOk(body);
          expect({ id: body.result.id, offer: body.result.offerExpiresAfterSeconds }).toEqual({
            id: "alchemy-get-dp",
            offer: 300,
          });
        }),
      );
    });

    describe("ListRouterDistributionPolicies", () => {
      test(
        "lists distribution policies",
        Effect.gen(function* () {
          yield* distributionPolicy("alchemy-list-dp");
          const body = yield* call("ListRouterDistributionPolicies");
          expectOk(body);
          expect((body.result.value as { id: string }[]).map((p) => p.id)).toContain(
            "alchemy-list-dp",
          );
        }),
      );
    });

    describe("DeleteRouterDistributionPolicy", () => {
      test(
        "deletes a distribution policy",
        Effect.gen(function* () {
          yield* distributionPolicy("alchemy-delete-dp");
          const body = yield* call("DeleteRouterDistributionPolicy", {
            distributionPolicyId: "alchemy-delete-dp",
          });
          expectOk(body);
          const tag = yield* waitTag(
            jobRouter.GetJobRouterAdministrationOperationDistributionPolicy({
              ...(yield* router),
              distributionPolicyId: "alchemy-delete-dp",
            }),
            "RouterEntityNotFound",
          );
          expect(tag).toEqual("RouterEntityNotFound");
        }),
      );
    });

    describe("UpsertRouterQueue", () => {
      test(
        "creates a queue",
        Effect.gen(function* () {
          yield* distributionPolicy("alchemy-upsert-q-dp");
          const body = yield* call("UpsertRouterQueue", {
            queueId: "alchemy-upsert-q",
            distributionPolicyId: "alchemy-upsert-q-dp",
            labels: { language: "en" },
          });
          expectOk(body);
          const observed = yield* jobRouter.GetJobRouterAdministrationOperationQueue({
            ...(yield* router),
            queueId: "alchemy-upsert-q",
          });
          expect({
            dp: observed.distributionPolicyId,
            language: observed.labels?.language,
          }).toEqual({
            dp: "alchemy-upsert-q-dp",
            language: "en",
          });
        }),
      );
    });

    describe("GetRouterQueue", () => {
      test(
        "reads a queue",
        Effect.gen(function* () {
          yield* queue("alchemy-get-q");
          const body = yield* call("GetRouterQueue", { queueId: "alchemy-get-q" });
          expectOk(body);
          expect({ id: body.result.id, dp: body.result.distributionPolicyId }).toEqual({
            id: "alchemy-get-q",
            dp: "alchemy-get-q-dp",
          });
        }),
      );
    });

    describe("ListRouterQueues", () => {
      test(
        "lists queues",
        Effect.gen(function* () {
          yield* queue("alchemy-list-q");
          const body = yield* call("ListRouterQueues");
          expectOk(body);
          expect((body.result.value as { id: string }[]).map((q) => q.id)).toContain(
            "alchemy-list-q",
          );
        }),
      );
    });

    describe("DeleteRouterQueue", () => {
      test(
        "deletes a queue",
        Effect.gen(function* () {
          yield* queue("alchemy-delete-q");
          const body = yield* call("DeleteRouterQueue", { queueId: "alchemy-delete-q" });
          expectOk(body);
          const tag = yield* waitTag(
            jobRouter.GetJobRouterAdministrationOperationQueue({
              ...(yield* router),
              queueId: "alchemy-delete-q",
            }),
            "RouterEntityNotFound",
          );
          expect(tag).toEqual("RouterEntityNotFound");
        }),
      );
    });

    describe("UpsertRouterClassificationPolicy", () => {
      test(
        "creates a classification policy with a static priority",
        Effect.gen(function* () {
          yield* queue("alchemy-cp-q");
          const body = yield* call("UpsertRouterClassificationPolicy", {
            classificationPolicyId: "alchemy-upsert-cp",
            fallbackQueueId: "alchemy-cp-q",
            prioritizationRule: { kind: "static", value: 5 },
          });
          expectOk(body);
          const observed = yield* jobRouter.GetJobRouterAdministrationOperationClassificationPolicy(
            {
              ...(yield* router),
              classificationPolicyId: "alchemy-upsert-cp",
            },
          );
          expect({
            fallback: observed.fallbackQueueId,
            rule: observed.prioritizationRule,
          }).toEqual({ fallback: "alchemy-cp-q", rule: { kind: "static", value: 5 } });
        }),
      );
    });

    /** Out of band: a classification policy sending jobs to `fallbackQueueId`. */
    const classificationPolicy = (classificationPolicyId: string, fallbackQueueId: string) =>
      Effect.gen(function* () {
        return yield* jobRouter.UpsertJobRouterAdministrationOperationClassificationPolicy({
          ...(yield* router),
          classificationPolicyId,
          fallbackQueueId,
        });
      });

    describe("GetRouterClassificationPolicy", () => {
      test(
        "reads a classification policy",
        Effect.gen(function* () {
          yield* queue("alchemy-cp-q");
          yield* classificationPolicy("alchemy-get-cp", "alchemy-cp-q");
          const body = yield* call("GetRouterClassificationPolicy", {
            classificationPolicyId: "alchemy-get-cp",
          });
          expectOk(body);
          expect({ id: body.result.id, fallback: body.result.fallbackQueueId }).toEqual({
            id: "alchemy-get-cp",
            fallback: "alchemy-cp-q",
          });
        }),
      );
    });

    describe("ListRouterClassificationPolicies", () => {
      test(
        "lists classification policies",
        Effect.gen(function* () {
          yield* queue("alchemy-cp-q");
          yield* classificationPolicy("alchemy-list-cp", "alchemy-cp-q");
          const body = yield* call("ListRouterClassificationPolicies");
          expectOk(body);
          expect((body.result.value as { id: string }[]).map((p) => p.id)).toContain(
            "alchemy-list-cp",
          );
        }),
      );
    });

    describe("DeleteRouterClassificationPolicy", () => {
      test(
        "deletes a classification policy",
        Effect.gen(function* () {
          yield* queue("alchemy-cp-q");
          yield* classificationPolicy("alchemy-delete-cp", "alchemy-cp-q");
          const body = yield* call("DeleteRouterClassificationPolicy", {
            classificationPolicyId: "alchemy-delete-cp",
          });
          expectOk(body);
          const tag = yield* waitTag(
            jobRouter.GetJobRouterAdministrationOperationClassificationPolicy({
              ...(yield* router),
              classificationPolicyId: "alchemy-delete-cp",
            }),
            "RouterEntityNotFound",
          );
          expect(tag).toEqual("RouterEntityNotFound");
        }),
      );
    });

    const exceptionRules = [
      {
        id: "wait-5m",
        trigger: { kind: "waitTime", thresholdSeconds: 300 },
        actions: [{ kind: "cancel", note: "waited too long", dispositionCode: "timeout" }],
      },
    ];

    describe("UpsertRouterExceptionPolicy", () => {
      test(
        "creates an exception policy",
        Effect.gen(function* () {
          const body = yield* call("UpsertRouterExceptionPolicy", {
            exceptionPolicyId: "alchemy-upsert-ep",
            exceptionRules,
          });
          expectOk(body);
          const observed = yield* jobRouter.GetJobRouterAdministrationOperationExceptionPolicy({
            ...(yield* router),
            exceptionPolicyId: "alchemy-upsert-ep",
          });
          const rule = observed.exceptionRules![0]!;
          expect({
            trigger: rule.trigger,
            action: { ...rule.actions[0], id: undefined },
          }).toEqual({
            trigger: { kind: "waitTime", thresholdSeconds: 300 },
            action: {
              kind: "cancel",
              note: "waited too long",
              dispositionCode: "timeout",
              id: undefined,
            },
          });
        }),
      );
    });

    /** Out of band: an exception policy with one wait-time rule. */
    const exceptionPolicy = (exceptionPolicyId: string) =>
      Effect.gen(function* () {
        return yield* jobRouter.UpsertJobRouterAdministrationOperationExceptionPolicy({
          ...(yield* router),
          exceptionPolicyId,
          exceptionRules,
        });
      });

    describe("GetRouterExceptionPolicy", () => {
      test(
        "reads an exception policy",
        Effect.gen(function* () {
          yield* exceptionPolicy("alchemy-get-ep");
          const body = yield* call("GetRouterExceptionPolicy", {
            exceptionPolicyId: "alchemy-get-ep",
          });
          expectOk(body);
          expect(body.result.exceptionRules[0].id).toEqual("wait-5m");
        }),
      );
    });

    describe("ListRouterExceptionPolicies", () => {
      test(
        "lists exception policies",
        Effect.gen(function* () {
          yield* exceptionPolicy("alchemy-list-ep");
          const body = yield* call("ListRouterExceptionPolicies");
          expectOk(body);
          expect((body.result.value as { id: string }[]).map((p) => p.id)).toContain(
            "alchemy-list-ep",
          );
        }),
      );
    });

    describe("DeleteRouterExceptionPolicy", () => {
      test(
        "deletes an exception policy",
        Effect.gen(function* () {
          yield* exceptionPolicy("alchemy-delete-ep");
          const body = yield* call("DeleteRouterExceptionPolicy", {
            exceptionPolicyId: "alchemy-delete-ep",
          });
          expectOk(body);
          const tag = yield* waitTag(
            jobRouter.GetJobRouterAdministrationOperationExceptionPolicy({
              ...(yield* router),
              exceptionPolicyId: "alchemy-delete-ep",
            }),
            "RouterEntityNotFound",
          );
          expect(tag).toEqual("RouterEntityNotFound");
        }),
      );
    });

    /** Out of band: a job in `queueId` (a queue with no workers stays queued). */
    const job = (jobId: string, queueId: string) =>
      Effect.gen(function* () {
        return yield* jobRouter.UpsertJobRouterOperationJob({
          ...(yield* router),
          jobId,
          queueId,
          channelId: "voice",
          priority: 1,
        });
      });

    /** Out of band: read a job until its status is `status`. */
    const jobStatus = (jobId: string, status: string) =>
      Effect.gen(function* () {
        const r = yield* router;
        return yield* jobRouter.GetJobRouterOperationJob({ ...r, jobId }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (j) => j.status === status,
            times: 30,
          }),
        );
      });

    /** Out of band: cancel (if active) and delete a job. */
    const dropJob = (jobId: string) =>
      Effect.gen(function* () {
        const r = yield* router;
        yield* outcome(jobRouter.CancelJobRouterOperationJob({ ...r, jobId }));
        yield* jobStatus(jobId, "cancelled").pipe(Effect.ignore);
        yield* outcome(jobRouter.DeleteJobRouterOperationJob({ ...r, jobId }));
      });

    describe("UpsertRouterJob", () => {
      test(
        "creates a job that queues",
        Effect.gen(function* () {
          yield* queue("alchemy-idle-q");
          const body = yield* call("UpsertRouterJob", {
            jobId: "alchemy-upsert-job",
            queueId: "alchemy-idle-q",
            channelId: "voice",
            priority: 2,
          });
          expectOk(body);
          const observed = yield* jobStatus("alchemy-upsert-job", "queued");
          expect({ status: observed.status, priority: observed.priority }).toEqual({
            status: "queued",
            priority: 2,
          });
          yield* dropJob("alchemy-upsert-job");
        }),
      );
    });

    describe("GetRouterJob", () => {
      test(
        "reads a job",
        Effect.gen(function* () {
          yield* queue("alchemy-idle-q");
          yield* job("alchemy-get-job", "alchemy-idle-q");
          const body = yield* call("GetRouterJob", { jobId: "alchemy-get-job" });
          expectOk(body);
          expect({ id: body.result.id, queue: body.result.queueId }).toEqual({
            id: "alchemy-get-job",
            queue: "alchemy-idle-q",
          });
          yield* dropJob("alchemy-get-job");
        }),
      );
    });

    describe("ListRouterJobs", () => {
      test(
        "lists the jobs of a queue",
        Effect.gen(function* () {
          yield* queue("alchemy-list-jobs-q");
          yield* job("alchemy-list-job", "alchemy-list-jobs-q");
          yield* jobStatus("alchemy-list-job", "queued");
          const body = yield* call("ListRouterJobs", { queueId: "alchemy-list-jobs-q" });
          expectOk(body);
          expect((body.result.value as { id: string }[]).map((j) => j.id)).toEqual([
            "alchemy-list-job",
          ]);
          yield* dropJob("alchemy-list-job");
        }),
      );
    });

    describe("GetRouterJobQueuePosition", () => {
      test(
        "reads a queued job's position",
        Effect.gen(function* () {
          yield* queue("alchemy-position-q");
          yield* job("alchemy-position-job", "alchemy-position-q");
          yield* jobStatus("alchemy-position-job", "queued");
          const body = yield* call("GetRouterJobQueuePosition", { jobId: "alchemy-position-job" });
          expectOk(body);
          expect({ position: body.result.position, queue: body.result.queueId }).toEqual({
            position: 1,
            queue: "alchemy-position-q",
          });
          yield* dropJob("alchemy-position-job");
        }),
      );
    });

    describe("GetRouterQueueStatistics", () => {
      test(
        "counts a queue's jobs",
        Effect.gen(function* () {
          yield* queue("alchemy-stats-q");
          yield* job("alchemy-stats-job", "alchemy-stats-q");
          yield* jobStatus("alchemy-stats-job", "queued");
          const body = yield* call("GetRouterQueueStatistics", { queueId: "alchemy-stats-q" });
          expectOk(body);
          expect({ queue: body.result.queueId, length: body.result.length }).toEqual({
            queue: "alchemy-stats-q",
            length: 1,
          });
          yield* dropJob("alchemy-stats-job");
        }),
      );
    });

    describe("CancelRouterJob", () => {
      test(
        "cancels a job",
        Effect.gen(function* () {
          yield* queue("alchemy-idle-q");
          yield* job("alchemy-cancel-job", "alchemy-idle-q");
          const body = yield* call("CancelRouterJob", { jobId: "alchemy-cancel-job" });
          expectOk(body);
          const observed = yield* jobStatus("alchemy-cancel-job", "cancelled");
          expect(observed.status).toEqual("cancelled");
          yield* dropJob("alchemy-cancel-job");
        }),
      );
    });

    describe("DeleteRouterJob", () => {
      test(
        "deletes a cancelled job",
        Effect.gen(function* () {
          yield* queue("alchemy-idle-q");
          yield* job("alchemy-delete-job", "alchemy-idle-q");
          yield* jobRouter.CancelJobRouterOperationJob({
            ...(yield* router),
            jobId: "alchemy-delete-job",
          });
          yield* jobStatus("alchemy-delete-job", "cancelled");
          const body = yield* call("DeleteRouterJob", { jobId: "alchemy-delete-job" });
          expectOk(body);
          const tag = yield* waitTag(
            jobRouter.GetJobRouterOperationJob({ ...(yield* router), jobId: "alchemy-delete-job" }),
            "RouterEntityNotFound",
          );
          expect(tag).toEqual("RouterEntityNotFound");
        }),
      );
    });

    describe("ReclassifyRouterJob", () => {
      // Live: reclassifying a queued job answers `{}` and leaves it queued
      // where it is (no observable change), so the case checks the job is
      // still queued and the probe checks the typed error.
      test(
        "reclassifies a queued job",
        Effect.gen(function* () {
          yield* queue("alchemy-reclassify-q");
          yield* classificationPolicy("alchemy-reclassify-cp", "alchemy-reclassify-q");
          yield* jobRouter.UpsertJobRouterOperationJob({
            ...(yield* router),
            jobId: "alchemy-reclassify-job",
            channelId: "voice",
            classificationPolicyId: "alchemy-reclassify-cp",
          });
          yield* jobStatus("alchemy-reclassify-job", "queued");
          const body = yield* call("ReclassifyRouterJob", { jobId: "alchemy-reclassify-job" });
          expectOk(body);
          const observed = yield* jobStatus("alchemy-reclassify-job", "queued");
          expect({ status: observed.status, queue: observed.queueId }).toEqual({
            status: "queued",
            queue: "alchemy-reclassify-q",
          });
          yield* dropJob("alchemy-reclassify-job");
        }),
      );
      test(
        "fails typed for a job that does not exist",
        Effect.gen(function* () {
          const body = yield* probe(
            "ReclassifyRouterJob",
            { jobId: "alchemy-no-such-job" },
            "RouterEntityNotFound",
          );
          expectTag(body, "RouterEntityNotFound");
        }),
      );
    });

    /** Out of band: a worker on `queueId` that takes one voice job. */
    const worker = (workerId: string, queueId: string) =>
      Effect.gen(function* () {
        return yield* jobRouter.UpsertJobRouterOperationWorker({
          ...(yield* router),
          workerId,
          queues: [queueId],
          capacity: 1,
          channels: [{ channelId: "voice", capacityCostPerJob: 1 }],
          availableForOffers: true,
        });
      });

    /** Out of band: take a worker offline and delete it. */
    const dropWorker = (workerId: string) =>
      Effect.gen(function* () {
        const r = yield* router;
        yield* outcome(
          jobRouter.UpsertJobRouterOperationWorker({ ...r, workerId, availableForOffers: false }),
        );
        yield* outcome(jobRouter.DeleteJobRouterOperationWorker({ ...r, workerId })).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (t) => t === "ok",
            times: 10,
          }),
        );
      });

    /** Out of band: read a worker until it holds an offer, and return the offer. */
    const offerFor = (workerId: string) =>
      Effect.gen(function* () {
        const observed = yield* jobRouter
          .GetJobRouterOperationWorker({ ...(yield* router), workerId })
          .pipe(
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              until: (w) => (w.offers?.length ?? 0) > 0,
              times: 30,
            }),
          );
        return observed.offers![0]!;
      });

    describe("UpsertRouterWorker", () => {
      test(
        "registers a worker",
        Effect.gen(function* () {
          yield* queue("alchemy-worker-q");
          const body = yield* call("UpsertRouterWorker", {
            workerId: "alchemy-upsert-worker",
            queues: ["alchemy-worker-q"],
            capacity: 2,
            channels: [{ channelId: "voice", capacityCostPerJob: 1 }],
            availableForOffers: false,
          });
          expectOk(body);
          const observed = yield* jobRouter.GetJobRouterOperationWorker({
            ...(yield* router),
            workerId: "alchemy-upsert-worker",
          });
          expect({ queues: observed.queues, capacity: observed.capacity }).toEqual({
            queues: ["alchemy-worker-q"],
            capacity: 2,
          });
          yield* dropWorker("alchemy-upsert-worker");
        }),
      );
    });

    describe("GetRouterWorker", () => {
      test(
        "reads a worker",
        Effect.gen(function* () {
          yield* queue("alchemy-worker-q");
          yield* worker("alchemy-get-worker", "alchemy-worker-q");
          const body = yield* call("GetRouterWorker", { workerId: "alchemy-get-worker" });
          expectOk(body);
          expect({ id: body.result.id, queues: body.result.queues }).toEqual({
            id: "alchemy-get-worker",
            queues: ["alchemy-worker-q"],
          });
          yield* dropWorker("alchemy-get-worker");
        }),
      );
    });

    describe("ListRouterWorkers", () => {
      test(
        "lists the workers of a queue",
        Effect.gen(function* () {
          yield* queue("alchemy-list-workers-q");
          yield* worker("alchemy-list-worker", "alchemy-list-workers-q");
          const body = yield* call("ListRouterWorkers", { queueId: "alchemy-list-workers-q" });
          expectOk(body);
          expect((body.result.value as { id: string }[]).map((w) => w.id)).toEqual([
            "alchemy-list-worker",
          ]);
          yield* dropWorker("alchemy-list-worker");
        }),
      );
    });

    describe("DeleteRouterWorker", () => {
      test(
        "deletes a worker",
        Effect.gen(function* () {
          yield* queue("alchemy-worker-q");
          yield* jobRouter.UpsertJobRouterOperationWorker({
            ...(yield* router),
            workerId: "alchemy-delete-worker",
            queues: ["alchemy-worker-q"],
            capacity: 1,
            availableForOffers: false,
          });
          const body = yield* call("DeleteRouterWorker", { workerId: "alchemy-delete-worker" });
          expectOk(body);
          const tag = yield* waitTag(
            jobRouter.GetJobRouterOperationWorker({
              ...(yield* router),
              workerId: "alchemy-delete-worker",
            }),
            "RouterEntityNotFound",
          );
          expect(tag).toEqual("RouterEntityNotFound");
        }),
      );
    });

    describe("AcceptRouterJobOffer", () => {
      test(
        "assigns an offered job to the worker",
        Effect.gen(function* () {
          yield* queue("alchemy-accept-q");
          yield* worker("alchemy-accept-worker", "alchemy-accept-q");
          yield* job("alchemy-accept-job", "alchemy-accept-q");
          const offer = yield* offerFor("alchemy-accept-worker");
          const body = yield* call("AcceptRouterJobOffer", {
            workerId: "alchemy-accept-worker",
            offerId: offer.offerId,
          });
          expectOk(body);
          const observed = yield* jobStatus("alchemy-accept-job", "assigned");
          expect(Object.keys(observed.assignments ?? {})).toEqual([body.result.assignmentId]);
          yield* dropJob("alchemy-accept-job");
          yield* dropWorker("alchemy-accept-worker");
        }),
      );
    });

    describe("DeclineRouterJobOffer", () => {
      test(
        "declines an offered job",
        Effect.gen(function* () {
          yield* queue("alchemy-decline-q");
          yield* worker("alchemy-decline-worker", "alchemy-decline-q");
          yield* job("alchemy-decline-job", "alchemy-decline-q");
          const offer = yield* offerFor("alchemy-decline-worker");
          const body = yield* call("DeclineRouterJobOffer", {
            workerId: "alchemy-decline-worker",
            offerId: offer.offerId,
            retryOfferAt: "2099-01-01T00:00:00Z",
          });
          expectOk(body);
          const observed = yield* jobRouter
            .GetJobRouterOperationWorker({ ...(yield* router), workerId: "alchemy-decline-worker" })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (w) => (w.offers ?? []).every((o) => o.offerId !== offer.offerId),
                times: 15,
              }),
            );
          expect((observed.offers ?? []).map((o) => o.offerId)).not.toContain(offer.offerId);
          yield* dropJob("alchemy-decline-job");
          yield* dropWorker("alchemy-decline-worker");
        }),
      );
    });

    /** Out of band: an offered job the worker accepted; returns the assignment. */
    const assigned = (name: string) =>
      Effect.gen(function* () {
        yield* queue(`${name}-q`);
        yield* worker(`${name}-worker`, `${name}-q`);
        yield* job(`${name}-job`, `${name}-q`);
        const offer = yield* offerFor(`${name}-worker`);
        return yield* jobRouter.AcceptJobRouterOperationJobOffer({
          ...(yield* router),
          workerId: `${name}-worker`,
          offerId: offer.offerId,
        });
      });

    describe("CompleteRouterJob", () => {
      test(
        "completes an assigned job",
        Effect.gen(function* () {
          const { jobId, assignmentId } = yield* assigned("alchemy-complete");
          const body = yield* call("CompleteRouterJob", { jobId, assignmentId });
          expectOk(body);
          const observed = yield* jobStatus(jobId, "completed");
          expect(observed.status).toEqual("completed");
          const r = yield* router;
          yield* jobRouter.JobRouterOperationsCloseJob({ ...r, jobId, assignmentId });
          yield* jobStatus(jobId, "closed");
          yield* outcome(jobRouter.DeleteJobRouterOperationJob({ ...r, jobId }));
          yield* dropWorker("alchemy-complete-worker");
        }),
      );
    });

    describe("CloseRouterJob", () => {
      test(
        "closes a completed job",
        Effect.gen(function* () {
          const { jobId, assignmentId } = yield* assigned("alchemy-close");
          const r = yield* router;
          yield* jobRouter.CompleteJobRouterOperationJob({
            ...r,
            jobId,
            assignmentId,
          });
          yield* jobStatus(jobId, "completed");
          const body = yield* call("CloseRouterJob", { jobId, assignmentId });
          expectOk(body);
          const observed = yield* jobStatus(jobId, "closed");
          expect(observed.status).toEqual("closed");
          yield* outcome(jobRouter.DeleteJobRouterOperationJob({ ...r, jobId }));
          yield* dropWorker("alchemy-close-worker");
        }),
      );
    });

    describe("UnassignRouterJob", () => {
      test(
        "takes an assigned job back into its queue",
        Effect.gen(function* () {
          const { jobId, assignmentId } = yield* assigned("alchemy-unassign");
          const body = yield* call("UnassignRouterJob", { jobId, assignmentId });
          expectOk(body);
          expect(body.result).toEqual({ jobId, unassignmentCount: 1 });
          const observed = yield* jobRouter
            .GetJobRouterOperationJob({ ...(yield* router), jobId })
            .pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (j) => j.status !== "assigned",
                times: 15,
              }),
            );
          expect(observed.status === "assigned").toBe(false);
          yield* dropJob(jobId);
          yield* dropWorker("alchemy-unassign-worker");
        }),
      );
    });

    // --- Call Automation -----------------------------------------------

    /** Out of band: a Communication Services user to call. */
    const newUser = Effect.gen(function* () {
      const url = yield* endpoint;
      const created = yield* identity.CreateIdentityOperation({ endpoint: url });
      return created.identity.id;
    });

    /** Out of band: an outbound call to a fresh (never answering) user. */
    const outboundCall = Effect.gen(function* () {
      const { url } = yield* stack;
      const userId = yield* newUser;
      const created = yield* callAutomation.CreateCall({
        endpoint: yield* endpoint,
        targets: [{ communicationUser: { id: userId } }],
        callbackUri: `${url}/events`,
      });
      return created.callConnectionId!;
    });

    describe("CreateCall", () => {
      test(
        "places an outbound call",
        Effect.gen(function* () {
          const { url } = yield* stack;
          const userId = yield* newUser;
          const body = yield* call("CreateCall", {
            targets: [{ communicationUser: { id: userId } }],
            callbackUri: `${url}/events`,
          });
          expectOk(body);
          const callConnectionId: string = body.result.callConnectionId;
          const observed = yield* callAutomation.GetCallConnectionCall({
            endpoint: yield* endpoint,
            callConnectionId,
          });
          expect(observed.targets?.map((t) => t.communicationUser?.id)).toEqual([userId]);
          yield* outcome(
            callAutomation.TerminateCallConnectionCall({
              endpoint: yield* endpoint,
              callConnectionId,
            }),
          );
        }),
      );
    });

    describe("GetCall", () => {
      test(
        "reads a call",
        Effect.gen(function* () {
          const callConnectionId = yield* outboundCall;
          const body = yield* call("GetCall", { callConnectionId });
          expectOk(body);
          expect(body.result.callConnectionId).toEqual(callConnectionId);
          yield* outcome(
            callAutomation.TerminateCallConnectionCall({
              endpoint: yield* endpoint,
              callConnectionId,
            }),
          );
        }),
      );
    });

    describe("TerminateCall", () => {
      test(
        "ends a call",
        Effect.gen(function* () {
          const callConnectionId = yield* outboundCall;
          const body = yield* call("TerminateCall", { callConnectionId });
          expectOk(body);
          const tag = yield* waitTag(
            callAutomation.GetCallConnectionCall({ endpoint: yield* endpoint, callConnectionId }),
            "CallConnectionNotFound",
          );
          expect(tag).toEqual("CallConnectionNotFound");
        }),
      );
    });

    describe("HangUpCall", () => {
      test(
        "leaves a call",
        Effect.gen(function* () {
          const callConnectionId = yield* outboundCall;
          const body = yield* call("HangUpCall", { callConnectionId });
          expectOk(body);
          const tag = yield* waitTag(
            callAutomation.GetCallConnectionCall({ endpoint: yield* endpoint, callConnectionId }),
            "CallConnectionNotFound",
          );
          expect(tag).toEqual("CallConnectionNotFound");
        }),
      );
    });

    // Operations on an established call need a participant that answers
    // (a phone or a Calling SDK client), which a test cannot provide: each
    // gets a probe that addresses a call that does not exist and asserts
    // the typed error, proving the binding reaches the data plane with its
    // role.
    const user = { communicationUser: { id: `8:acs:${NO_SUCH_ID}_${NO_SUCH_ID}` } };
    const onMissingCall: [string, Record<string, unknown>][] = [
      ["ListCallParticipants", {}],
      ["GetCallParticipant", { participantRawId: user.communicationUser.id }],
      ["TransferCall", { targetParticipant: user }],
      ["AddCallParticipant", { participantToAdd: user }],
      ["RemoveCallParticipant", { participantToRemove: user }],
      ["CancelAddCallParticipant", { invitationId: NO_SUCH_ID }],
      ["MoveCallParticipants", { fromCall: NO_SUCH_ID, targetParticipants: [user] }],
      ["MuteCallParticipants", { targetParticipants: [user] }],
      [
        "PlayCallMedia",
        { playSources: [{ kind: "text", text: { text: "hello", voiceName: "en-US-AvaNeural" } }] },
      ],
      [
        "RecognizeCallMedia",
        {
          recognizeInputType: "dtmf",
          recognizeOptions: { targetParticipant: user, dtmfOptions: { maxTonesToCollect: 1 } },
        },
      ],
      ["HoldCallParticipant", { targetParticipant: user }],
      ["UnholdCallParticipant", { targetParticipant: user }],
      ["CancelAllCallMediaOperations", {}],
      ["SendCallDtmfTones", { tones: ["one"], targetParticipant: user }],
      ["StartCallDtmfRecognition", { targetParticipant: user }],
      ["StopCallDtmfRecognition", { targetParticipant: user }],
      ["StartCallMediaStreaming", {}],
      ["StopCallMediaStreaming", {}],
      ["StartCallTranscription", { locale: "en-US" }],
      ["StopCallTranscription", {}],
      ["UpdateCallTranscription", { locale: "en-US" }],
    ];
    for (const [binding, request] of onMissingCall) {
      describe(binding, () => {
        test(
          "fails typed on a call that does not exist",
          Effect.gen(function* () {
            const body = yield* probe(
              binding,
              { callConnectionId: NO_SUCH_ID, ...request },
              "CallConnectionNotFound",
            );
            expectTag(body, "CallConnectionNotFound");
          }),
        );
      });
    }

    const incomingCallContext = "eyJhbGciOiJub25lIn0.eyJjYyI6Im5vbmUifQ.";
    const onMissingIncomingCall: [string, Record<string, unknown>][] = [
      ["AnswerCall", { incomingCallContext, callbackUri: "https://example.com/events" }],
      ["RedirectCall", { incomingCallContext, target: user }],
      ["RejectCall", { incomingCallContext, callRejectReason: "busy" }],
    ];
    for (const [binding, request] of onMissingIncomingCall) {
      describe(binding, () => {
        test(
          "fails typed on an incoming call context that is not valid",
          Effect.gen(function* () {
            const body = yield* probe(binding, request, "InvalidIncomingCallContext");
            expectTag(body, "InvalidIncomingCallContext");
          }),
        );
      });
    }

    describe("ConnectCall", () => {
      test(
        "connects to a room call",
        Effect.gen(function* () {
          const { url } = yield* stack;
          const acsEndpoint = yield* endpoint;
          const room = yield* rooms.CreateRoom({ endpoint: acsEndpoint });
          const body = yield* call("ConnectCall", {
            callLocator: { kind: "roomCallLocator", roomId: room.id },
            callbackUri: `${url}/events`,
          });
          expectOk(body);
          const callConnectionId: string = body.result.callConnectionId;
          const observed = yield* callAutomation.GetCallConnectionCall({
            endpoint: acsEndpoint,
            callConnectionId,
          });
          expect(observed.callConnectionId).toEqual(callConnectionId);
          yield* outcome(
            callAutomation.TerminateCallConnectionCall({
              endpoint: acsEndpoint,
              callConnectionId,
            }),
          );
          yield* rooms.DeleteRoom({ endpoint: acsEndpoint, roomId: room.id });
        }),
      );
    });

    describe("StartCallRecording", () => {
      test(
        "fails typed on a call that does not exist",
        Effect.gen(function* () {
          const body = yield* probe(
            "StartCallRecording",
            { callConnectionId: NO_SUCH_ID },
            "CallConnectionNotFound",
          );
          expectTag(body, "CallConnectionNotFound");
        }),
      );
    });

    for (const binding of [
      "GetCallRecording",
      "StopCallRecording",
      "PauseCallRecording",
      "ResumeCallRecording",
    ]) {
      describe(binding, () => {
        test(
          "fails typed on a recording that does not exist",
          Effect.gen(function* () {
            const body = yield* probe(
              binding,
              { recordingId: NO_SUCH_RECORDING },
              "RecordingNotFound",
            );
            expectTag(body, "RecordingNotFound");
          }),
        );
      });
    }

    // --- Advanced Messaging --------------------------------------------

    // Sending needs a WhatsApp Business channel registered on the service
    // (an external system): each binding gets a probe on a channel that
    // does not exist.
    describe("SendNotificationMessage", () => {
      test(
        "fails typed on a channel that is not registered",
        Effect.gen(function* () {
          const body = yield* probe(
            "SendNotificationMessage",
            {
              channelRegistrationId: NO_SUCH_ID,
              to: ["+14255550123"],
              kind: "text",
              content: "hello",
            },
            "ChannelNotFound",
          );
          expectTag(body, "ChannelNotFound");
        }),
      );
    });

    describe("ListMessageTemplates", () => {
      test(
        "fails typed on a channel that is not registered",
        Effect.gen(function* () {
          const body = yield* probe(
            "ListMessageTemplates",
            { channelId: NO_SUCH_ID },
            "ChannelNotFound",
          );
          expectTag(body, "ChannelNotFound");
        }),
      );
    });

    describe("GetMessageMedia", () => {
      test(
        "fails typed on media that does not exist",
        Effect.gen(function* () {
          const body = yield* probe("GetMessageMedia", { id: NO_SUCH_ID }, "MediaNotFound");
          expectTag(body, "MediaNotFound");
        }),
      );
    });
  },
);
