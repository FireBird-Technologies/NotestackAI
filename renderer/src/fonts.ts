import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";

// Remotion waits for these before rendering each frame.
export const fonts = {
  display: loadSpaceGrotesk("normal", { weights: ["500", "600", "700"], subsets: ["latin"] }).fontFamily,
  body: loadInter("normal", { weights: ["400", "600"], subsets: ["latin"] }).fontFamily,
  mono: loadMono("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily,
};
