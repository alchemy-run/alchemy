import { Composition } from "remotion";
import { deck } from "../deck.ts";
import { VIDEO } from "../shared/types.ts";
import { calculateIntroMetadata, Intro } from "./intro/Intro.tsx";
import { calculateSceneMetadata, Scene } from "./scene/Scene.tsx";
import { Slide } from "./slides/Slide.tsx";

/** One composition per deck item; composition ids are the deck ids. */
export const Root = () => (
  <>
    {deck.map((item) =>
      item.kind === "intro" ? (
        <Composition
          key={item.id}
          id={item.id}
          component={Intro}
          calculateMetadata={calculateIntroMetadata}
          durationInFrames={1}
          fps={VIDEO.fps}
          width={VIDEO.width}
          height={VIDEO.height}
          defaultProps={{}}
        />
      ) : item.kind === "slide" ? (
        <Composition
          key={item.id}
          id={item.id}
          component={Slide}
          durationInFrames={Math.round((item.seconds ?? 2) * VIDEO.fps)}
          fps={VIDEO.fps}
          width={VIDEO.width}
          height={VIDEO.height}
          defaultProps={{ layout: item.layout, props: item.props }}
        />
      ) : (
        <Composition
          key={item.id}
          id={item.id}
          component={Scene}
          calculateMetadata={calculateSceneMetadata}
          durationInFrames={1}
          fps={VIDEO.fps}
          width={VIDEO.width}
          height={VIDEO.height}
          defaultProps={{ id: item.id }}
        />
      ),
    )}
  </>
);
