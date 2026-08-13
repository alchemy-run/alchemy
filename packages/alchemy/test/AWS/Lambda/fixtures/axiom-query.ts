import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const queryRetrySchedule = Schedule.max([
  Schedule.spaced("5 seconds"),
  Schedule.recurs(36),
]);

export interface AxiomQuery {
  readonly dataset: string;
  readonly markers: readonly string[];
}

const datasetName = (name: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid Axiom dataset name: ${name}`);
  }
  return name;
};

const apiBaseUrl = () =>
  (process.env.AXIOM_URL ?? "https://api.axiom.co").replace(/\/$/, "");

const apiToken = () => {
  const token = process.env.AXIOM_TOKEN ?? process.env.AXIOM_API_KEY;
  if (token === undefined || token.length === 0) {
    throw new Error("Axiom query credentials are not configured");
  }
  return token;
};

const queryHeaders = () => ({
  Authorization: `Bearer ${apiToken()}`,
  "Content-Type": "application/json",
  ...(process.env.AXIOM_ORG_ID
    ? { "X-Axiom-Org-Id": process.env.AXIOM_ORG_ID }
    : {}),
});

const queryDataset = ({ dataset }: AxiomQuery) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(
        `${apiBaseUrl()}/v1/datasets/_apl?format=legacy`,
      ).pipe(
        HttpClientRequest.setHeaders(queryHeaders()),
        HttpClientRequest.bodyJsonUnsafe({
          apl: `['${datasetName(dataset)}'] | where _time > ago(15m) | limit 1000`,
        }),
      ),
    );
    return yield* response.text;
  });

export const expectAxiomContains = (query: AxiomQuery) =>
  queryDataset(query).pipe(
    Effect.filterOrFail(
      (body) => query.markers.every((marker) => body.includes(marker)),
      (body) => {
        const missing = query.markers.filter(
          (marker) => !body.includes(marker),
        );
        return new Error(
          `Axiom dataset ${query.dataset} has not received: ${missing.join(", ")}`,
        );
      },
    ),
    Effect.retry({ schedule: queryRetrySchedule }),
  );
