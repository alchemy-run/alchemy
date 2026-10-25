import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

const C = Azure.Communication;

/** The communication service the fixture binds. Module-scope so the test stack yields the same declaration. */
export const Acs = C.CommunicationService("AcsCallingService");

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/** A binding callable; each takes its own request type. */
type Call = (request: never) => Effect.Effect<unknown, unknown, RuntimeContext>;

/** CallAutomation bindings. */
const CallAutomationHttp = Layer.mergeAll(
  C.CreateCallHttp,
  C.AnswerCallHttp,
  C.RedirectCallHttp,
  C.RejectCallHttp,
  C.ConnectCallHttp,
  C.GetCallHttp,
  C.HangUpCallHttp,
  C.TerminateCallHttp,
  C.TransferCallHttp,
  C.AddCallParticipantHttp,
  C.RemoveCallParticipantHttp,
  C.CancelAddCallParticipantHttp,
  C.MoveCallParticipantsHttp,
  C.MuteCallParticipantsHttp,
  C.GetCallParticipantHttp,
  C.ListCallParticipantsHttp,
  C.PlayCallMediaHttp,
  C.RecognizeCallMediaHttp,
  C.HoldCallParticipantHttp,
  C.UnholdCallParticipantHttp,
  C.CancelAllCallMediaOperationsHttp,
  C.SendCallDtmfTonesHttp,
  C.StartCallDtmfRecognitionHttp,
  C.StopCallDtmfRecognitionHttp,
  C.StartCallMediaStreamingHttp,
  C.StopCallMediaStreamingHttp,
  C.StartCallTranscriptionHttp,
  C.StopCallTranscriptionHttp,
  C.UpdateCallTranscriptionHttp,
  C.StartCallRecordingHttp,
  C.StopCallRecordingHttp,
  C.PauseCallRecordingHttp,
  C.ResumeCallRecordingHttp,
  C.GetCallRecordingHttp,
);

/** JobRouter bindings. */
const JobRouterHttp = Layer.mergeAll(
  C.UpsertRouterDistributionPolicyHttp,
  C.GetRouterDistributionPolicyHttp,
  C.DeleteRouterDistributionPolicyHttp,
  C.ListRouterDistributionPoliciesHttp,
  C.UpsertRouterClassificationPolicyHttp,
  C.GetRouterClassificationPolicyHttp,
  C.DeleteRouterClassificationPolicyHttp,
  C.ListRouterClassificationPoliciesHttp,
  C.UpsertRouterExceptionPolicyHttp,
  C.GetRouterExceptionPolicyHttp,
  C.DeleteRouterExceptionPolicyHttp,
  C.ListRouterExceptionPoliciesHttp,
  C.UpsertRouterQueueHttp,
  C.GetRouterQueueHttp,
  C.DeleteRouterQueueHttp,
  C.ListRouterQueuesHttp,
  C.GetRouterQueueStatisticsHttp,
  C.UpsertRouterJobHttp,
  C.GetRouterJobHttp,
  C.DeleteRouterJobHttp,
  C.ListRouterJobsHttp,
  C.ReclassifyRouterJobHttp,
  C.CancelRouterJobHttp,
  C.CompleteRouterJobHttp,
  C.CloseRouterJobHttp,
  C.UnassignRouterJobHttp,
  C.GetRouterJobQueuePositionHttp,
  C.UpsertRouterWorkerHttp,
  C.GetRouterWorkerHttp,
  C.DeleteRouterWorkerHttp,
  C.ListRouterWorkersHttp,
  C.AcceptRouterJobOfferHttp,
  C.DeclineRouterJobOfferHttp,
);

/** Messages bindings. */
const MessagesHttp = Layer.mergeAll(
  C.SendNotificationMessageHttp,
  C.ListMessageTemplatesHttp,
  C.GetMessageMediaHttp,
);

/** PhoneNumbers bindings. */
const PhoneNumbersHttp = Layer.mergeAll(
  C.ListPhoneNumberCountriesHttp,
  C.ListPhoneNumberAreaCodesHttp,
  C.ListPhoneNumberLocalitiesHttp,
  C.ListPhoneNumberOfferingsHttp,
  C.ListPhoneNumbersHttp,
  C.GetPhoneNumberHttp,
  C.BrowsePhoneNumbersHttp,
  C.SearchPhoneNumbersHttp,
  C.GetPhoneNumberSearchResultHttp,
  C.PurchasePhoneNumbersHttp,
  C.UpsertPhoneNumberReservationHttp,
  C.GetPhoneNumberReservationHttp,
  C.DeletePhoneNumberReservationHttp,
  C.ListPhoneNumberReservationsHttp,
  C.PurchasePhoneNumberReservationHttp,
  C.GetPhoneNumberOperationHttp,
  C.CancelPhoneNumberOperationHttp,
  C.UpdatePhoneNumberCapabilitiesHttp,
  C.ReleasePhoneNumberHttp,
  C.SearchPhoneNumberOperatorInformationHttp,
);

/** SipRouting bindings. */
const SipRoutingHttp = Layer.mergeAll(C.GetSipRoutingHttp, C.UpdateSipRoutingHttp);

/**
 * Effect Function with one route per Call Automation, Job Router, Advanced
 * Messaging, Phone Numbers, and SIP routing binding: `POST /<Binding>` with
 * the binding's request as the JSON body calls it and answers
 * `{ ok, result | error }` (a 500 on error, so a caller retries through
 * role propagation and a real failure shows the Azure error).
 * `POST /events` accepts Call Automation callbacks.
 */
export default class CommunicationCallingFunction extends Azure.Functions.Function<CommunicationCallingFunction>()(
  "CommunicationCallingFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const acs = yield* Acs;
    const calls: Record<string, Call> = {
      // Call Automation
      CreateCall: yield* C.CreateCall(acs),
      AnswerCall: yield* C.AnswerCall(acs),
      RedirectCall: yield* C.RedirectCall(acs),
      RejectCall: yield* C.RejectCall(acs),
      ConnectCall: yield* C.ConnectCall(acs),
      GetCall: yield* C.GetCall(acs),
      HangUpCall: yield* C.HangUpCall(acs),
      TerminateCall: yield* C.TerminateCall(acs),
      TransferCall: yield* C.TransferCall(acs),
      AddCallParticipant: yield* C.AddCallParticipant(acs),
      RemoveCallParticipant: yield* C.RemoveCallParticipant(acs),
      CancelAddCallParticipant: yield* C.CancelAddCallParticipant(acs),
      MoveCallParticipants: yield* C.MoveCallParticipants(acs),
      MuteCallParticipants: yield* C.MuteCallParticipants(acs),
      GetCallParticipant: yield* C.GetCallParticipant(acs),
      ListCallParticipants: yield* C.ListCallParticipants(acs),
      PlayCallMedia: yield* C.PlayCallMedia(acs),
      RecognizeCallMedia: yield* C.RecognizeCallMedia(acs),
      HoldCallParticipant: yield* C.HoldCallParticipant(acs),
      UnholdCallParticipant: yield* C.UnholdCallParticipant(acs),
      CancelAllCallMediaOperations: yield* C.CancelAllCallMediaOperations(acs),
      SendCallDtmfTones: yield* C.SendCallDtmfTones(acs),
      StartCallDtmfRecognition: yield* C.StartCallDtmfRecognition(acs),
      StopCallDtmfRecognition: yield* C.StopCallDtmfRecognition(acs),
      StartCallMediaStreaming: yield* C.StartCallMediaStreaming(acs),
      StopCallMediaStreaming: yield* C.StopCallMediaStreaming(acs),
      StartCallTranscription: yield* C.StartCallTranscription(acs),
      StopCallTranscription: yield* C.StopCallTranscription(acs),
      UpdateCallTranscription: yield* C.UpdateCallTranscription(acs),
      StartCallRecording: yield* C.StartCallRecording(acs),
      StopCallRecording: yield* C.StopCallRecording(acs),
      PauseCallRecording: yield* C.PauseCallRecording(acs),
      ResumeCallRecording: yield* C.ResumeCallRecording(acs),
      GetCallRecording: yield* C.GetCallRecording(acs),
      // Job Router
      UpsertRouterDistributionPolicy: yield* C.UpsertRouterDistributionPolicy(acs),
      GetRouterDistributionPolicy: yield* C.GetRouterDistributionPolicy(acs),
      DeleteRouterDistributionPolicy: yield* C.DeleteRouterDistributionPolicy(acs),
      ListRouterDistributionPolicies: yield* C.ListRouterDistributionPolicies(acs),
      UpsertRouterClassificationPolicy: yield* C.UpsertRouterClassificationPolicy(acs),
      GetRouterClassificationPolicy: yield* C.GetRouterClassificationPolicy(acs),
      DeleteRouterClassificationPolicy: yield* C.DeleteRouterClassificationPolicy(acs),
      ListRouterClassificationPolicies: yield* C.ListRouterClassificationPolicies(acs),
      UpsertRouterExceptionPolicy: yield* C.UpsertRouterExceptionPolicy(acs),
      GetRouterExceptionPolicy: yield* C.GetRouterExceptionPolicy(acs),
      DeleteRouterExceptionPolicy: yield* C.DeleteRouterExceptionPolicy(acs),
      ListRouterExceptionPolicies: yield* C.ListRouterExceptionPolicies(acs),
      UpsertRouterQueue: yield* C.UpsertRouterQueue(acs),
      GetRouterQueue: yield* C.GetRouterQueue(acs),
      DeleteRouterQueue: yield* C.DeleteRouterQueue(acs),
      ListRouterQueues: yield* C.ListRouterQueues(acs),
      GetRouterQueueStatistics: yield* C.GetRouterQueueStatistics(acs),
      UpsertRouterJob: yield* C.UpsertRouterJob(acs),
      GetRouterJob: yield* C.GetRouterJob(acs),
      DeleteRouterJob: yield* C.DeleteRouterJob(acs),
      ListRouterJobs: yield* C.ListRouterJobs(acs),
      ReclassifyRouterJob: yield* C.ReclassifyRouterJob(acs),
      CancelRouterJob: yield* C.CancelRouterJob(acs),
      CompleteRouterJob: yield* C.CompleteRouterJob(acs),
      CloseRouterJob: yield* C.CloseRouterJob(acs),
      UnassignRouterJob: yield* C.UnassignRouterJob(acs),
      GetRouterJobQueuePosition: yield* C.GetRouterJobQueuePosition(acs),
      UpsertRouterWorker: yield* C.UpsertRouterWorker(acs),
      GetRouterWorker: yield* C.GetRouterWorker(acs),
      DeleteRouterWorker: yield* C.DeleteRouterWorker(acs),
      ListRouterWorkers: yield* C.ListRouterWorkers(acs),
      AcceptRouterJobOffer: yield* C.AcceptRouterJobOffer(acs),
      DeclineRouterJobOffer: yield* C.DeclineRouterJobOffer(acs),
      // Advanced Messaging
      SendNotificationMessage: yield* C.SendNotificationMessage(acs),
      ListMessageTemplates: yield* C.ListMessageTemplates(acs),
      GetMessageMedia: yield* C.GetMessageMedia(acs),
      // Phone Numbers
      ListPhoneNumberCountries: yield* C.ListPhoneNumberCountries(acs),
      ListPhoneNumberAreaCodes: yield* C.ListPhoneNumberAreaCodes(acs),
      ListPhoneNumberLocalities: yield* C.ListPhoneNumberLocalities(acs),
      ListPhoneNumberOfferings: yield* C.ListPhoneNumberOfferings(acs),
      ListPhoneNumbers: yield* C.ListPhoneNumbers(acs),
      GetPhoneNumber: yield* C.GetPhoneNumber(acs),
      BrowsePhoneNumbers: yield* C.BrowsePhoneNumbers(acs),
      SearchPhoneNumbers: yield* C.SearchPhoneNumbers(acs),
      GetPhoneNumberSearchResult: yield* C.GetPhoneNumberSearchResult(acs),
      PurchasePhoneNumbers: yield* C.PurchasePhoneNumbers(acs),
      UpsertPhoneNumberReservation: yield* C.UpsertPhoneNumberReservation(acs),
      GetPhoneNumberReservation: yield* C.GetPhoneNumberReservation(acs),
      DeletePhoneNumberReservation: yield* C.DeletePhoneNumberReservation(acs),
      ListPhoneNumberReservations: yield* C.ListPhoneNumberReservations(acs),
      PurchasePhoneNumberReservation: yield* C.PurchasePhoneNumberReservation(acs),
      GetPhoneNumberOperation: yield* C.GetPhoneNumberOperation(acs),
      CancelPhoneNumberOperation: yield* C.CancelPhoneNumberOperation(acs),
      UpdatePhoneNumberCapabilities: yield* C.UpdatePhoneNumberCapabilities(acs),
      ReleasePhoneNumber: yield* C.ReleasePhoneNumber(acs),
      SearchPhoneNumberOperatorInformation: yield* C.SearchPhoneNumberOperatorInformation(acs),
      // SIP routing
      GetSipRouting: yield* C.GetSipRouting(acs),
      UpdateSipRouting: yield* C.UpdateSipRouting(acs),
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const name = url.pathname.slice(1);
        if (name === "events") {
          return HttpServerResponse.text("ok");
        }
        const call = calls[name];
        if (call === undefined) {
          return HttpServerResponse.text("not found", { status: 404 });
        }
        const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed({})));
        // The test sends the binding's own request type as JSON.
        return yield* respond(call(body as never));
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        CallAutomationHttp,
        JobRouterHttp,
        MessagesHttp,
        PhoneNumbersHttp,
        SipRoutingHttp,
      ),
    ),
  ),
) {}
