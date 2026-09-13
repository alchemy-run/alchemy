import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import { Dashboard } from "alchemy/Dashboard/Hosted/AWS";
import * as Effect from "effect/Effect";

// A hosted alchemy dashboard on AWS: the dashboard SPA on S3 + CloudFront
// with `/api/*` routed to a Lambda that reads the S3 state store this stack
// (and every other stack in this account and region) uses.
export default Alchemy.Stack(
  "DashboardAws",
  {
    providers: AWS.providers(),
    state: AWS.state(),
  },
  Effect.gen(function* () {
    const dashboard = yield* Dashboard("Dashboard");
    return {
      url: dashboard.url,
    };
  }),
);
