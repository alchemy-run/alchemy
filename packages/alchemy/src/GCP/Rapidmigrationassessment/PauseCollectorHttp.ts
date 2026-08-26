import * as rma from "@distilled.cloud/gcp/rapidmigrationassessment_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { makeCollectorHttpBinding } from "./BindingHttp.ts";
import { PauseCollector } from "./PauseCollector.ts";

/**
 * HTTP implementation of {@link PauseCollector}.
 *
 * @layer
 * @provides GCP.Rapidmigrationassessment.PauseCollector
 */
export const PauseCollectorHttp: Layer.Layer<
  PauseCollector,
  never,
  Credentials | HttpClient.HttpClient
> = Layer.effect(
  PauseCollector,
  makeCollectorHttpBinding<
    rma.PauseProjectsLocationsCollectorsRequest,
    rma.Operation,
    rma.PauseProjectsLocationsCollectorsError
  >({
    tag: "GCP.Rapidmigrationassessment.PauseCollector",
    operation: rma.pauseProjectsLocationsCollectors,
  }),
);
