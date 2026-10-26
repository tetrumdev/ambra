// Starts Metro on this computer's Tailscale address instead of the Wi-Fi one in .env.local, so a
// development build can load the app (and the pairing screen suggests the server) from anywhere.
// Expo never overwrites a variable that is already set, so this takes precedence over .env.local.
const { execFileSync, spawn } = require("node:child_process");

let address;
try {
  address = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
} catch {
  console.error("Couldn't ask Tailscale for this computer's address. Is Tailscale installed and connected?");
  process.exit(1);
}
if (!address) {
  console.error("Tailscale isn't connected on this computer.");
  process.exit(1);
}

console.log(`Metro will be reachable at ${address}:8081; pair with ${address}:38147.`);
const expo = spawn(process.execPath, ["x", "expo", "start", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, REACT_NATIVE_PACKAGER_HOSTNAME: address },
});
expo.on("exit", code => process.exit(code ?? 0));
