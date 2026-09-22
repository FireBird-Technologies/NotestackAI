import { fonts } from "./fonts";

// Browser side only (loads Google fonts). Keep out of server imports.
export const theme = {
  black: "#000000",
  blue: "#217cff",
  white: "#ffffff",
  display: `${fonts.display}, ${fonts.body}, sans-serif`,
  body: `${fonts.body}, sans-serif`,
  mono: `${fonts.mono}, monospace`,
} as const;
