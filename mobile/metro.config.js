// Learn more https://docs.expo.dev/guides/customizing-metro
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The swirl and its palette are shared with the desktop app. Watch only that folder:
// the rest of the repository holds Rust build output Metro shouldn't crawl.
config.watchFolders = [path.resolve(__dirname, "../desktop/src/utils")];

module.exports = config;
