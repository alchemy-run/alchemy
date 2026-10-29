import * as GCP from "@alchemy.run/gcp";

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
