/**
 * Public posts about Alchemy, curated from X (see the sentiment thread at
 * https://x.com/samgoodwin89/status/2102459555573793216). Text is verbatim
 * except for trimming, marked with "…". Only first-party team posts are
 * excluded.
 */
export interface Post {
  name: string;
  handle: string;
  url: string;
  text: string;
}

export const POSTS: Post[] = [
  {
    name: "Rhys",
    handle: "RhysSullivan",
    url: "https://x.com/RhysSullivan/status/2102515675931799843",
    text: "Alchemy enables me to be more ambitious in shipping large projects to multiple targets. It gives my agents the capability to debug issues against real deployments of my systems, enabling the best feedback loop I've ever had resulting in several large perf wins.",
  },
  {
    name: "Maxwell Brown",
    handle: "maxwellbrown",
    url: "https://x.com/maxwellbrown/status/2081323853171556739",
    text: "Alchemy is literally the only reason I gave Cloudflare's dev platform a shot. The fact that I can just write Effect code to describe / deploy my infra and then use those same resources in my program is unparalleled DX IMO.",
  },
  {
    name: "Maximilian",
    handle: "maxedapps",
    url: "https://x.com/maxedapps/status/2099771815786582351",
    text: "Cloudflare + Alchemy + Effect is such a winning stack with AI agents, it's not even real. … And all the infra lives in code - which is how it should be with AI agents.",
  },
  {
    name: "Dillon Mulroy",
    handle: "dillon_mulroy",
    url: "https://x.com/dillon_mulroy/status/2081108173935522081",
    text: "alchemy is so good for IAC, esp. cloudflare IAC",
  },
  {
    name: "Michael Arnaldi",
    handle: "MichaelArnaldi",
    url: "https://x.com/MichaelArnaldi/status/2102384731912388802",
    text: "Thanks to Alchemy the CF primitives finally shine in DX, I couldn't get over the DX issues before, now it's amazing",
  },
  {
    name: "arth",
    handle: "arthty",
    url: "https://x.com/arthty/status/2090156386353299742",
    text: "choosing alchemy as a core foundation on @op0ai is probably a top 3 decision long-term. so far, the dx and velocity has gone thru the roof.",
  },
  {
    name: "Nick Blow",
    handle: "NickBlow",
    url: "https://x.com/NickBlow/status/2102814433315578050",
    text: "The fact it's truly \u201cjust typescript\u201d and not the abomination of codegen … Allows it to be far more easily extended than other iac platforms.",
  },
  {
    name: "Superlinear",
    handle: "superlinear_fm",
    url: "https://x.com/superlinear_fm/status/2101946564260294900",
    text: "We use @alchemy_run bc it's truly declarative, written in TypeScript with Effect, and gives agents a clean, code-native way to understand and modify infrastructure.",
  },
  {
    name: "Michael Arnaldi",
    handle: "MichaelArnaldi",
    url: "https://x.com/MichaelArnaldi/status/2100076857638957346",
    text: "Effect + Alchemy + DOs (and cf primitives) is an insanely powerful combo",
  },
  {
    name: "Alireza Najafi",
    handle: "alire8za",
    url: "https://x.com/alire8za/status/2102777097148068137",
    text: "Alchemy made working with Cloudflare joyful",
  },
  {
    name: "joel",
    handle: "joelhooks",
    url: "https://x.com/joelhooks/status/2102230916164886939",
    text: "nobody talking about the effect+alchemy+cloudflare combo to literally build f'n anything",
  },
  {
    name: "Harry Solovay",
    handle: "harrysolovay",
    url: "https://x.com/harrysolovay/status/2081854670960488857",
    text: "It just hit me: @alchemy_run is going to Effect-pill literally everyone who wants to ditch Wrangler. ... that's pretty magical.",
  },
  {
    name: "Andrew Jefferson",
    handle: "EastlondonDev",
    url: "https://x.com/EastlondonDev/status/1944020116955361658",
    text: "Alchemy is next gen infrastructure as code & it's helping us make the most of Cloudflare's global scale",
  },
  {
    name: "Nipsuli",
    handle: "Nipsuli",
    url: "https://x.com/Nipsuli/status/2090153816289079318",
    text: "Alchemy is freaking amazing! I've run with cloudflare workers for few years now in different projects and alchemy made the experience so freaking much better.",
  },
  {
    name: "Michael Arnaldi",
    handle: "MichaelArnaldi",
    url: "https://x.com/MichaelArnaldi/status/2094818796204634535",
    text: "v4 + alchemy solved most of the issues, we are now focusing on higher level design of things like Cluster on CF",
  },
];

/** Profile photo, saved from X into public/testimonials (96px WebP). */
export const avatar = (p: Post) =>
  `/testimonials/${p.handle.toLowerCase()}.webp`;

const by = (url: string) => POSTS.find((p) => p.url.endsWith(url))!;

/** The wall's three columns, top to bottom (order is hand-picked). */
export const WALL_COLUMNS: Post[][] = [
  [
    by("2102814433315578050"), // Nick Blow
    by("2102384731912388802"), // Michael Arnaldi, CF primitives
    by("2099771815786582351"), // Maximilian
    by("2081854670960488857"), // Harry Solovay
    by("1944020116955361658"), // Andrew Jefferson
  ],
  [
    by("2081108173935522081"), // Dillon Mulroy
    by("2090156386353299742"), // arth
    by("2101946564260294900"), // Superlinear
    by("2090153816289079318"), // Nipsuli
    by("2094818796204634535"), // Michael Arnaldi, Cluster on CF
  ],
  [
    by("2102515675931799843"), // Rhys
    by("2081323853171556739"), // Maxwell Brown
    by("2100076857638957346"), // Michael Arnaldi, DOs combo
    by("2102777097148068137"), // Alireza Najafi
    by("2102230916164886939"), // joel
  ],
];
