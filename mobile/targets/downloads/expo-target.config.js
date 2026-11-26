/** Downloads to this phone, shown in the Dynamic Island and on the Lock Screen as a Live Activity. */
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  name: "AmbraDownloads",
  displayName: "Ambra Downloads",
  bundleIdentifier: ".downloads",
  deploymentTarget: "16.4",
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit"],
};
