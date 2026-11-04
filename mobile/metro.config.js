const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// @notestack/shared is linked from ../packages/shared (a file: dependency, not a workspace), so Metro must watch it.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../packages")];

// Keep "show source" directives through minifying: the slide editor (packages/shared/src/slideDeck.ts) is sent into
// a slide's web view as its own source text, which Hermes only keeps for a function that asks for it.
config.transformer.minifierConfig = {
  ...config.transformer.minifierConfig,
  compress: { ...config.transformer.minifierConfig?.compress, directives: false },
};

module.exports = config;
