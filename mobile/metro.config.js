const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// @notestack/shared is linked from ../packages/shared (a file: dependency, not a workspace), so Metro must watch it.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../packages")];

module.exports = config;
