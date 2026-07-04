import React from "react";
import { Composition } from "remotion";
import { aStagePerPullRequest } from "./storyboards/a-stage-per-pull-request";
import { durableObjectsAndContainers } from "./storyboards/durable-objects-and-containers";
import { firecrackerFromAWorker } from "./storyboards/firecracker-from-a-worker";
import { infrastructureAsEffects } from "./storyboards/infrastructure-as-effects";
import { planetscaleBranchPerPr } from "./storyboards/planetscale-branch-per-pr";
import { schemalessRpc } from "./storyboards/schemaless-rpc";
import { testAndDevAgainstTheRealCloud } from "./storyboards/test-and-dev-against-the-real-cloud";
import { zeroToWorkerInFiveMinutes } from "./storyboards/zero-to-worker-in-five-minutes";
import { FPS, HEIGHT, totalFrames, WIDTH, type Storyboard } from "./storyboard";
import { Video } from "./Video";

const STORYBOARDS: Storyboard[] = [infrastructureAsEffects, zeroToWorkerInFiveMinutes, testAndDevAgainstTheRealCloud, schemalessRpc, durableObjectsAndContainers, firecrackerFromAWorker, planetscaleBranchPerPr, aStagePerPullRequest];

export const Root: React.FC = () => (
  <>
    {STORYBOARDS.map((sb) => (
      <Composition
        key={sb.id}
        id={sb.id}
        component={Video as React.FC<{ storyboard: Storyboard }>}
        durationInFrames={totalFrames(sb)}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={{ storyboard: sb }}
      />
    ))}
  </>
);
