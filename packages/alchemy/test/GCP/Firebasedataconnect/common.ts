import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Firebase Data Connect is entitlement-gated. Live create returns Forbidden:
// "Firebase SQL Connect API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled. Enable it by visiting
// https://console.developers.google.com/apis/api/firebasedataconnect.googleapis.com/overview?project=alchemy-gcp-testing-83661"
export const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_FIREBASE_DATA_CONNECT === "1";

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
export const location = "us-central1";

export const probeTags = ["NotFound", "Forbidden", "BadRequest"];

export const missingService = (serviceId = "alchemy-missing-service") =>
  `projects/${project}/locations/${location}/services/${serviceId}`;

export const missingSchema = (serviceId = "alchemy-missing-service") =>
  `${missingService(serviceId)}/schemas/main`;

export const missingConnector = (serviceId = "alchemy-missing-service") =>
  `${missingService(serviceId)}/connectors/alchemy-missing-connector`;

export const schemaSource = (extraField?: string) => ({
  files: [
    {
      path: "schema.gql",
      content:
        extraField === undefined
          ? "type AlchemyNote @table { title: String! }"
          : `type AlchemyNote @table { title: String! ${extraField} }`,
    },
  ],
});

export const unlinkedDatasources = [
  { postgresql: { unlinked: true as const } },
];

export const connectorSource = {
  files: [
    {
      path: "queries.gql",
      content:
        "query ListAlchemyNotes @auth(level: PUBLIC) { alchemyNotes { id title } }",
    },
  ],
};
