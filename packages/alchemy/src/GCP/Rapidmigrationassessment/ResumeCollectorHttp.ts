import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeCollectorHttpBinding } from "./BindingHttp.ts";
import { ResumeCollector } from "./ResumeCollector.ts";

/**
 * HTTP implementation of {@link ResumeCollector}.
 *
 * @layer
 * @provides GCP.Rapidmigrationassessment.ResumeCollector
 */
export const ResumeCollectorHttp: Layer.Layer<
  ResumeCollector,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  ResumeCollector,
  makeCollectorHttpBinding<
    rma.ResumeProjectsLocationsCollectorsRequest,
    rma.Operation,
    rma.ResumeProjectsLocationsCollectorsError
  >({
    tag: "GCP.Rapidmigrationassessment.ResumeCollector",
    operation: rma.resumeProjectsLocationsCollectors,
  }),
);
