import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { ChatTranscript } from "../transcript.ts";

/** ContactCenterInsights resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeAnalysisRule = GCP.ContactCenterInsights.AnalysisRule("ProbeAnalysisRule", {
  displayName: "draft",
  active: false,
  analysisPercentage: 0,
  annotatorSelector: { runSentimentAnnotator: true },
});
export const ProbeQaQuestionTag = GCP.ContactCenterInsights.QaQuestionTag("ProbeQaQuestionTag", {
  location: "us-central1",
  displayName: "billing",
});
export const ProbeView = GCP.ContactCenterInsights.View("ProbeView", {
  location: "us-central1",
  displayName: "chat",
  value: 'medium="CHAT"',
});

export const ProbeConversation = Effect.gen(function* () {
  return yield* GCP.ContactCenterInsights.Conversation("ProbeConversation", {
    dataSource: yield* ChatTranscript,
    medium: "CHAT",
    languageCode: "en-US",
    agentId: "agent-1",
  });
});
export const ProbeAnalysis = Effect.gen(function* () {
  const conversation = yield* ProbeConversation;
  return yield* GCP.ContactCenterInsights.ConversationsAnalyses("ProbeAnalysis", {
    parent: conversation.name,
    annotatorSelector: { runSilenceAnnotator: true },
  });
});
export const ProbePhraseMatcher = GCP.ContactCenterInsights.PhraseMatcher("ProbePhraseMatcher", {
  location: "us-central1",
  displayName: "refunds",
  type: "ALL_OF",
  active: false,
  phraseMatchRuleGroups: [
    {
      type: "ANY_OF",
      phraseMatchRules: [
        { query: "refund", config: { exactMatchConfig: { caseSensitive: false } } },
      ],
    },
  ],
});
