import { stepsSlides, stepsVideo } from "./steps";
import { launchSlides, launchVideo, povVideo, problemSlides, problemVideo, spotlightSlides, spotlightVideo } from "./others";
import type { TemplateDef, TemplateId } from "./types";

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  "how-it-works": {
    id: "how-it-works",
    label: "How it works",
    description: "4–6 steps, one real screen each, App Store-screenshot style: carousel and animated video.",
    bestFor: "new apps, first posts, explaining the core loop",
    outputs: ["carousel", "video"],
    minSteps: 3,
    maxSteps: 6,
    video: (i) => stepsVideo(i, "steps"),
    slides: (i, r) => stepsSlides(i, r, "steps"),
  },
  "whats-new": {
    id: "whats-new",
    label: "What's new",
    description: "The release's changes, one screen each, with \"New\" badges — from the release notes.",
    bestFor: "after a release with visible changes",
    outputs: ["carousel", "video"],
    minSteps: 1,
    maxSteps: 4,
    video: (i) => stepsVideo(i, "new"),
    slides: (i, r) => stepsSlides(i, r, "new"),
  },
} as Record<TemplateId, TemplateDef>;

export const TEMPLATE_LIST = (): TemplateDef[] => TEMPLATE_IDS_ORDER.map((id) => TEMPLATES[id]);

TEMPLATES["feature-spotlight"] = {
  id: "feature-spotlight",
  label: "Feature spotlight",
  description: "One real screen; the camera zooms to what matters with captions; a still with the detail lifted off the screen.",
  bestFor: "one strong feature, a tip, a detail people miss",
  outputs: ["video", "still"],
  minSteps: 1,
  maxSteps: 3,
  video: spotlightVideo,
  slides: spotlightSlides,
};
TEMPLATES["pov-hook"] = {
  id: "pov-hook",
  label: "POV hook",
  description: "A relatable real-life moment (b-roll from the Creative library or a creator tool) with a POV line, then a hard cut to the app moment.",
  bestFor: "reach: relatable situations the audience knows",
  outputs: ["video"],
  minSteps: 1,
  maxSteps: 2,
  video: povVideo,
};
TEMPLATES["problem-solution"] = {
  id: "problem-solution",
  label: "Problem → solution",
  description: "Before: the everyday hassle as a chat; after: the app solving it on its real screen.",
  bestFor: "apps that replace a clumsy habit",
  outputs: ["video", "carousel"],
  minSteps: 1,
  maxSteps: 2,
  video: problemVideo,
  slides: problemSlides,
};
TEMPLATES.launch = {
  id: "launch",
  label: "Launch",
  description: "The real icon on the brand's burst, the announcement, the app's screens fanned out.",
  bestFor: "launch day, a big new version",
  outputs: ["video", "still"],
  minSteps: 1,
  maxSteps: 3,
  video: launchVideo,
  slides: launchSlides,
};
const TEMPLATE_IDS_ORDER: TemplateId[] = ["how-it-works", "feature-spotlight", "pov-hook", "problem-solution", "launch", "whats-new"];
export type { TemplateDef, TemplateId };
