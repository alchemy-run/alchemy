import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:contactcenterinsights", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const alnum = name.replace(/[^a-z0-9]/g, "");
      yield* expectAllMissing(stack, {
        "missing-assessment-rule": GCP.ContactCenterInsights.AssessmentRule.lookup({
          assessmentRuleId: alnum,
        }).name,
        "missing-authorized-view-set": GCP.ContactCenterInsights.AuthorizedViewSet.lookup({
          authorizedViewSetId: name,
        }).name,
        "missing-authorized-view-sets-authorized-view":
          GCP.ContactCenterInsights.AuthorizedViewSetsAuthorizedView.lookup({
            authorizedViewId: name,
            parent: name,
          }).name,
        "missing-auto-labeling-rule": GCP.ContactCenterInsights.AutoLabelingRule.lookup({
          autoLabelingRuleId: name,
        }).name,
        "missing-conversation": GCP.ContactCenterInsights.Conversation.lookup({
          conversationId: name,
        }).name,
        "missing-dashboard": GCP.ContactCenterInsights.Dashboard.lookup({ dashboardId: name }).name,
        "missing-qa-scorecard": GCP.ContactCenterInsights.QaScorecard.lookup({
          qaScorecardId: name,
        }).name,
        "missing-qa-scorecards-revision": GCP.ContactCenterInsights.QaScorecardsRevision.lookup({
          qaScorecardRevisionId: name,
          parent: name,
        }).name,
        "missing-qa-scorecards-revisions-qa-question":
          GCP.ContactCenterInsights.QaScorecardsRevisionsQaQuestion.lookup({
            qaQuestionId: name,
            parent: name,
          }).name,
      });
    }),
  { tags, timeout: 210000 },
);
