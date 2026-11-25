/** Timings shared by desktop, the browser remote, and native touch controls. */
export const interactionTiming = {
  press: { duration: 90, curve: [0.2, 0, 0, 1] },
  settle: { duration: 150, curve: [0.2, 0.7, 0.2, 1] },
} as const;
