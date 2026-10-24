import * as Azure from "@alchemy.run/azure";
import * as logic from "@distilled.cloud/azure/logic";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { freeAccount, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const HOST = { qualifier: "ZZ", value: "CONTOSO" };
const GUEST = { qualifier: "ZZ", value: "FABRIKAM" };

/** Unsigned, unencrypted AS2 settings; duplicate checking is the setting under test. */
const as2Settings = (checkDuplicateMessage: boolean): logic.AS2ProtocolSettings => ({
  messageConnectionSettings: {
    ignoreCertificateNameMismatch: false,
    supportHttpStatusCodeContinue: true,
    keepHttpConnectionAlive: true,
    unfoldHttpHeaders: true,
  },
  acknowledgementConnectionSettings: {
    ignoreCertificateNameMismatch: false,
    supportHttpStatusCodeContinue: false,
    keepHttpConnectionAlive: false,
    unfoldHttpHeaders: false,
  },
  mdnSettings: {
    needMDN: false,
    signMDN: false,
    sendMDNAsynchronously: false,
    signOutboundMDNIfOptional: false,
    sendInboundMDNToMessageBox: true,
    micHashingAlgorithm: "SHA1",
  },
  securitySettings: {
    overrideGroupSigningCertificate: false,
    enableNRRForInboundEncodedMessages: false,
    enableNRRForInboundDecodedMessages: false,
    enableNRRForOutboundMDN: false,
    enableNRRForOutboundEncodedMessages: false,
    enableNRRForOutboundDecodedMessages: false,
    enableNRRForInboundMDN: false,
  },
  validationSettings: {
    overrideMessageProperties: false,
    encryptMessage: false,
    signMessage: false,
    compressMessage: false,
    checkDuplicateMessage,
    interchangeDuplicatesValidityDays: 5,
    checkCertificateRevocationListOnSend: false,
    checkCertificateRevocationListOnReceive: false,
    encryptionAlgorithm: "DES3",
    signingAlgorithm: "Default",
  },
  envelopeSettings: {
    messageContentType: "text/plain",
    transmitFileNameInMimeHeader: false,
    fileNameTemplate: "%FILE().ReceivedFileName%",
    suspendMessageOnFileNameGenerationError: true,
    autogenerateFileName: false,
  },
  errorSettings: {
    suspendDuplicateMessage: false,
    resendIfMDNNotReceived: false,
  },
});

const as2Content = (checkDuplicates: boolean): logic.AgreementContent => ({
  aS2: {
    receiveAgreement: {
      senderBusinessIdentity: GUEST,
      receiverBusinessIdentity: HOST,
      protocolSettings: as2Settings(checkDuplicates),
    },
    sendAgreement: {
      senderBusinessIdentity: HOST,
      receiverBusinessIdentity: GUEST,
      protocolSettings: as2Settings(checkDuplicates),
    },
  },
});

const program = (props: { name?: string; checkDuplicates: boolean; owner: string }) =>
  Effect.gen(function* () {
    // One Free account per region per subscription: this file owns eastus2.
    const { group, account } = yield* freeAccount("eastus2");
    const host = yield* Azure.Logic.IntegrationAccountPartner("Contoso", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      businessIdentities: [HOST],
    });
    const guest = yield* Azure.Logic.IntegrationAccountPartner("Fabrikam", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      businessIdentities: [GUEST],
    });
    const agreement = yield* Azure.Logic.IntegrationAccountAgreement("As2", {
      resourceGroup: group.resourceGroupName,
      integrationAccount: account.integrationAccountName,
      name: props.name,
      agreementType: "AS2",
      hostPartner: host.partnerName,
      guestPartner: guest.partnerName,
      hostIdentity: HOST,
      guestIdentity: GUEST,
      content: as2Content(props.checkDuplicates),
      metadata: { owner: props.owner },
    });
    return { group, account, host, guest, agreement };
  });

const getAgreement = (rg: string, account: string, agreementName: string) =>
  Effect.gen(function* () {
    return yield* logic.GetIntegrationAccountAgreement({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      integrationAccountName: account,
      agreementName,
    });
  });

// Free integration account: no cost, synchronous.
test.provider(
  "create, update, replace, and delete an integration account agreement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, host, guest, agreement } = yield* stack.deploy(
        program({ checkDuplicates: false, owner: "a" }),
      );
      const rg = group.resourceGroupName;
      const ia = account.integrationAccountName;
      expect(agreement.agreementType).toEqual("AS2");
      expect(agreement.hostPartner).toEqual(host.partnerName);
      expect(agreement.guestPartner).toEqual(guest.partnerName);
      expect(agreement.metadata).toEqual({ owner: "a" });
      const observed = yield* getAgreement(rg, ia, agreement.agreementName);
      expect(observed.properties.hostIdentity).toEqual(HOST);
      expect(observed.properties.guestIdentity).toEqual(GUEST);
      expect(
        observed.properties.content.aS2?.sendAgreement.protocolSettings.validationSettings
          .checkDuplicateMessage,
      ).toEqual(false);
      const metadata = observed.properties.metadata as Record<string, unknown>;
      expect(metadata.owner).toEqual("a");
      expect(metadata["alchemy::id"]).toEqual("As2");

      // In-place: protocol settings and metadata.
      const updated = yield* stack.deploy(program({ checkDuplicates: true, owner: "b" }));
      expect(updated.agreement.agreementId).toEqual(agreement.agreementId);
      const reobserved = yield* getAgreement(rg, ia, agreement.agreementName);
      expect(
        reobserved.properties.content.aS2?.sendAgreement.protocolSettings.validationSettings
          .checkDuplicateMessage,
      ).toEqual(true);
      expect((reobserved.properties.metadata as Record<string, unknown>).owner).toEqual("b");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "contoso-fabrikam-as2", checkDuplicates: true, owner: "b" }),
      );
      expect(replaced.agreement.agreementName).toEqual("contoso-fabrikam-as2");
      expect(yield* waitGone(getAgreement(rg, ia, agreement.agreementName))).toEqual("gone");
      const replacedObserved = yield* getAgreement(rg, ia, "contoso-fabrikam-as2");
      expect(replacedObserved.properties.agreementType).toEqual("AS2");

      yield* stack.destroy();
      expect(yield* waitGone(getAgreement(rg, ia, "contoso-fabrikam-as2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
