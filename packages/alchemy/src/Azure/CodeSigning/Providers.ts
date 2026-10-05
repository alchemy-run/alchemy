import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import {
  CertificateProfile,
  CertificateProfileProvider,
} from "./CertificateProfile.ts";

export const resources = [Account, CertificateProfile];
export const layers = () =>
  Layer.mergeAll(AccountProvider(), CertificateProfileProvider());
