import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Track } from "../types/music";
import { downloadQualities, useDownloads, type DownloadJob } from "../utils/offlineDownloads";
import { DropdownChevron } from "./DropdownChevron";
import "./DownloadActivity.css";

const jobKey = (job: DownloadJob) => `${job.createdAt}:${job.id}:${job.target}:${job.clientId ?? ""}`;
const processed = (job: DownloadJob) => Math.min(job.total, job.done + job.failed);

/**
 * Download work stays on the server; this nonmodal panel follows it across pages. `hidden`
 * keeps it mounted out of sight (the big screen and lyrics), so it returns as it was left.
 */
export function DownloadActivity({ tracks = [], hidden = false }: { tracks?: Pick<Track, "globalId" | "name" | "artist">[]; hidden?: boolean }) {
  const { jobs } = useDownloads();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const observedActive = useRef(new Set<string>());
  useEffect(() => {
    for (const job of jobs) if (!job.finished) observedActive.current.add(jobKey(job));
  }, [jobs]);
  const trackNames = useMemo(() => new Map(tracks.map(track => [track.globalId, `${track.name} · ${track.artist}`])), [tracks]);
  const visible = jobs.filter(job => !dismissed.has(jobKey(job)) && (!job.finished || observedActive.current.has(jobKey(job))));
  if (hidden || !visible.length) return null;

  const active = visible.filter(job => !job.finished);
  const progressJobs = active.length ? active : visible;
  const total = progressJobs.reduce((sum, job) => sum + job.total, 0);
  const done = progressJobs.reduce((sum, job) => sum + processed(job), 0);
  const failures = visible.reduce((sum, job) => sum + job.failed, 0);
  const summary = active.length ? "Downloading" : failures ? "Downloads finished with errors" : "Downloads complete";
  const collapse = () => { setExpanded(false); trigger.current?.focus(); };

  return <aside className="downloadActivity" aria-label="Downloads"
    onKeyDown={event => {
      if (event.key !== "Escape" || !expanded) return;
      event.preventDefault();
      event.stopPropagation();
      collapse();
    }}>
    <section id={id} className="downloadActivityPanel" aria-label="Download details" hidden={!expanded}>
      <header>
        <h2>Downloads</h2>
        <button type="button" onClick={collapse} aria-label="Collapse downloads">Hide</button>
      </header>
      <ul>
        {visible.map(job => {
          const destination = job.target === "server" ? "Server" : job.targetName;
          const quality = downloadQualities.find(option => option.id === job.quality)?.label.split(" (")[0];
          const current = job.current ? trackNames.get(job.current) : null;
          const status = job.finished ? job.failed ? "Finished with errors" : "Complete"
            : job.current || processed(job) > 0 ? "Downloading" : "Queued";
          return <li key={jobKey(job)}>
            <div className="downloadActivityRow">
              <span className="downloadActivityDestination">{destination}<small>{quality}</small></span>
              <span>{Math.round(processed(job) / Math.max(1, job.total) * 100)}%</span>
            </div>
            <progress max={Math.max(1, job.total)} value={processed(job)} aria-label={`Download to ${destination}`} />
            <div className="downloadActivityRow downloadActivityMuted">
              <span>{status}</span><span>{job.done} of {job.total} saved</span>
            </div>
            {current && !job.finished && <p className="downloadActivityTrack" title={current}>{current}</p>}
            {job.failed > 0 && <details className="downloadActivityError">
              <summary>{job.failed} {job.failed === 1 ? "song failed" : "songs failed"}</summary>
              <p>{job.error ?? "Some songs could not be downloaded."}</p>
            </details>}
          </li>;
        })}
      </ul>
      <footer>
        <span>Keep browsing. Downloads continue in the background.</span>
        {visible.some(job => job.finished) && <button type="button" onClick={() => {
          setDismissed(current => new Set([...current, ...visible.filter(job => job.finished).map(jobKey)]));
        }}>Clear completed</button>}
      </footer>
    </section>
    <button ref={trigger} type="button" className="downloadActivitySummary" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}>
      <img src="/download.svg" alt="" aria-hidden="true" />
      <span aria-live="polite" aria-atomic="true">{summary}</span>
      <span className="downloadActivityCount">{done} / {total}</span>
      <DropdownChevron />
      <progress max={Math.max(1, total)} value={done} aria-label="Overall download progress" />
    </button>
  </aside>;
}
