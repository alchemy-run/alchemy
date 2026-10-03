import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kr from "@distilled.cloud/azure/kubernetesruntime";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { arcClusterId, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPeer = (clusterId: string, bgpPeerName: string) =>
  kr.GetBgpPeer({ resourceUri: clusterId, bgpPeerName });

const program = (props: { peerAsn: number; name?: string }) =>
  Effect.gen(function* () {
    const networking = yield* Azure.KubernetesRuntime.Service("Networking", {
      clusterId: arcClusterId!,
      serviceName: "networking",
    });
    const peer = yield* Azure.KubernetesRuntime.BgpPeer("Peer", {
      clusterId: networking.clusterId,
      name: props.name,
      myAsn: 64500,
      peerAsn: props.peerAsn,
      peerAddress: "10.0.0.1",
    });
    return { peer };
  });

// Needs a connected Arc cluster with Arc networking (see util.ts); the peer
// object itself is free (the session never establishes without a router).
test.provider.skipIf(!arcClusterId)(
  "create, update, replace, and delete a bgp peer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const clusterId = arcClusterId!;

      const { peer } = yield* stack.deploy(program({ peerAsn: 64501 }));
      expect(peer.bgpPeerName).toMatch(/^[a-z0-9-]{3,24}$/);
      const observed = yield* getPeer(clusterId, peer.bgpPeerName);
      expect(observed.properties?.peerAsn).toEqual(64501);
      expect(observed.properties?.peerAddress).toEqual("10.0.0.1");

      // In place: the peer ASN is mutable via PUT.
      const updated = yield* stack.deploy(program({ peerAsn: 64502 }));
      expect(updated.peer.bgpPeerId).toEqual(peer.bgpPeerId);
      const reobserved = yield* getPeer(clusterId, peer.bgpPeerName);
      expect(reobserved.properties?.peerAsn).toEqual(64502);

      // Replacement: the name is the identity.
      const replaced = yield* stack.deploy(
        program({ peerAsn: 64502, name: "alchemy-peer-b" }),
      );
      expect(replaced.peer.bgpPeerName).toEqual("alchemy-peer-b");
      expect(
        (yield* getPeer(clusterId, "alchemy-peer-b")).properties?.peerAsn,
      ).toEqual(64502);
      expect(yield* waitGone(getPeer(clusterId, peer.bgpPeerName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(getPeer(clusterId, "alchemy-peer-b"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
