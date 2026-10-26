// Learn more https://docs.expo.dev/guides/customizing-metro
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Share desktop's utilities, original icons and fonts, excluding its Rust build output.
config.watchFolders = [
  path.resolve(__dirname, "../desktop/src/utils"),
  path.resolve(__dirname, "../desktop/public"),
  path.resolve(__dirname, "../desktop/src/assets/fonts"),
];

// Shared desktop assets also import React Native's asset registry. Their parent
// directories cannot see mobile/node_modules, so include it as a resolution root.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  ...(config.resolver.nodeModulesPaths ?? []),
];

module.exports = config;
