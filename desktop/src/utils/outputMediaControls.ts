type Output = { endpointId: string } | null | undefined;

/** Headsets and OS media controls belong to the endpoint actually producing the audio. */
export function ownsPlaybackOutput(output: Output, clientId: string | undefined) {
  return !!clientId && output?.endpointId === clientId;
}

export function createOutputMediaControlHandler(
  clientId: string | undefined,
  currentOutput: () => Output,
  command: (action: string) => Promise<unknown>,
) {
  return (action: string) => {
    // Read ownership on delivery: an event queued before an output switch must not
    // pause or restart playback on the device that just took over.
    if (!ownsPlaybackOutput(currentOutput(), clientId)) return;
    if (!["play", "pause", "toggle", "next", "previous"].includes(action)) return;
    void command(action).catch(() => {});
  };
}
