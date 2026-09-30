import { Profiler, type ReactNode } from "react";
import { perfEnabled, record } from "../utils/perf";

const tracing = perfEnabled();

// Records React commit durations per view when tracing is on (`ambra.perf=1` or a
// development build). Read them with `window.__ambraPerf()`. Adds no DOM and no
// overhead otherwise.
export function PerfProfiler({ id, children }: { id: string; children: ReactNode }) {
  if (!tracing) return <>{children}</>;
  return (
    <Profiler
      id={id}
      onRender={(_id, phase, actualDuration) => record(`render.${id}.${phase}`, actualDuration)}
    >
      {children}
    </Profiler>
  );
}
