import * as Layer from "effect/Layer";
import {
  CommunicationService,
  CommunicationServiceProvider,
} from "./CommunicationService.ts";
import { EmailDomain, EmailDomainProvider } from "./EmailDomain.ts";
import { EmailService, EmailServiceProvider } from "./EmailService.ts";
import { SenderUsername, SenderUsernameProvider } from "./SenderUsername.ts";
import { SmtpUsername, SmtpUsernameProvider } from "./SmtpUsername.ts";
import { SuppressionList, SuppressionListProvider } from "./SuppressionList.ts";

export const resources = [
  CommunicationService,
  EmailDomain,
  EmailService,
  SenderUsername,
  SmtpUsername,
  SuppressionList,
];
export const layers = () =>
  Layer.mergeAll(
    CommunicationServiceProvider(),
    EmailDomainProvider(),
    EmailServiceProvider(),
    SenderUsernameProvider(),
    SmtpUsernameProvider(),
    SuppressionListProvider(),
  );
