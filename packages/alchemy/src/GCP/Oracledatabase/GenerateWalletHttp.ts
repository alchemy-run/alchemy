import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Layer from "effect/Layer";
import { makeOracleNameHttpBinding } from "./BindingHttp.ts";
import { GenerateWallet } from "./GenerateWallet.ts";

/**
 * HTTP implementation of {@link GenerateWallet}.
 *
 * @layer
 * @provides GCP.Oracledatabase.GenerateWallet
 */
export const GenerateWalletHttp = Layer.effect(
  GenerateWallet,
  makeOracleNameHttpBinding({
    tag: "GCP.Oracledatabase.GenerateWallet",
    operation: oracle.generateWalletProjectsLocationsAutonomousDatabases,
  }),
);
