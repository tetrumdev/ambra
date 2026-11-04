import "./DownloadDialog.css";
import "./TrackMenus.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { closeDialog, openDialog } from "../utils/dialogs";
import { getServerConnection, subscribeServerConnection } from "../api/serverConnection";
import {
  closeDownloadDialog,
  downloadClients,
  downloadQualities,
  requestDownloads,
  useDownloadDialogRequest,
  useDownloads,
  type DownloadClient,
  type DownloadQuality,
} from "../utils/offlineDownloads";

type Step = "target" | "clients" | "started";

function songs(count: number) {
  return `${count} ${count === 1 ? "song" : "songs"}`;
}

/** The menu every Download action opens: where to download to, and at what quality. */
export function DownloadDialog() {
  const request = useDownloadDialogRequest();
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const { jobs } = useDownloads();
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("target");
  const [quality, setQuality] = useState<DownloadQuality>("max");
  const [clients, setClients] = useState<DownloadClient[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedJobs, setStartedJobs] = useState<number[]>([]);

  useEffect(() => {
    if (request) {
      setStep("target");
      setQuality("max");
      setChosen(new Set());
      setError(null);
      setStartedJobs([]);
      openDialog(dialog.current);
    } else {
      closeDialog(dialog.current);
    }
  }, [request]);

  // The open apps, kept current while they're being chosen.
  useEffect(() => {
    if (step !== "clients") return;
    const abort = new AbortController();
    const refresh = () => downloadClients(abort.signal)
      .then(list => {
        setClients(list);
        // A device that closes can't stay chosen.
        setChosen(current => new Set([...current].filter(id => list.some(client => client.id === id))));
      })
      .catch(reason => { if (!abort.signal.aborted) setError(String(reason instanceof Error ? reason.message : reason)); });
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [step]);

  const count = request?.trackIds.length ?? 0;
  const noServer = !!connection && !connection.server;

  async function start(target: Parameters<typeof requestDownloads>[2]) {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await requestDownloads(request.trackIds, quality, target);
      setStartedJobs(created.map(job => job.id));
      setStep("started");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const progress = jobs.filter(job => startedJobs.includes(job.id));

  return (
    <dialog
      ref={dialog}
      className="playlistEditDialog downloadDialog"
      aria-label="Download"
      onCancel={event => { event.preventDefault(); closeDownloadDialog(); }}
      onKeyDown={event => event.stopPropagation()}
    >
      <button type="button" className="playlistEditCancel" onClick={() => {
        if (step === "clients") { setStep("target"); setError(null); } else closeDownloadDialog();
      }}>
        {step === "clients" ? "Back" : step === "started" ? "Close" : "Cancel"}
      </button>
      <div className="downloadDialogContent">
        <h2>Download {request?.title ?? ""}</h2>
        <p>{songs(count)}</p>
        {count === 0 ? (
          <p role="alert">None of these songs can be downloaded. Only songs from a streaming service can.</p>
        ) : noServer ? (
          <p role="alert">Connect to a server to download.</p>
        ) : step === "started" ? (
          <ul className="downloadProgress">
            {progress.length === 0 && <li>Download started.</li>}
            {progress.map(job => (
              <li key={job.id}>
                <span>{job.target === "server" ? "Server" : job.targetName}</span>
                <span>
                  {job.finished
                    ? job.failed ? `${job.done} downloaded, ${job.failed} failed` : "Done"
                    : `${job.done + job.failed} of ${job.total}`}
                </span>
                {job.error && <small role="alert">{job.error}</small>}
              </li>
            ))}
          </ul>
        ) : (
          <>
            <label className="downloadQuality">
              <span>Quality</span>
              <select value={quality} onChange={event => setQuality(event.target.value as DownloadQuality)}>
                {downloadQualities.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            {step === "target" ? (
              <div className="downloadTargets">
                <button type="button" className="menuItem" disabled={busy} onClick={() => void start({ kind: "server" })}>
                  <img className="menuIcon" src="/download.svg" alt="" aria-hidden="true" />
                  Download to Server
                </button>
                <button type="button" className="menuItem" disabled={busy} onClick={() => { setClients(null); setError(null); setStep("clients"); }}>
                  <img className="menuIcon" src="/download.svg" alt="" aria-hidden="true" />
                  Download to Client
                </button>
              </div>
            ) : (
              <>
                <fieldset className="downloadClients">
                  <legend>Download to</legend>
                  {clients === null && <p>Looking for open apps…</p>}
                  {clients?.length === 0 && <p>No apps are open on this server.</p>}
                  {clients?.map(client => (
                    <label key={client.id}>
                      <input
                        type="checkbox"
                        checked={chosen.has(client.id)}
                        onChange={event => setChosen(current => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(client.id); else next.delete(client.id);
                          return next;
                        })}
                      />
                      <span>{client.name}{client.id === connection?.clientId ? " (this device)" : ""}</span>
                    </label>
                  ))}
                </fieldset>
                <div className="playlistEditButtons downloadStart">
                  <button type="button" disabled={busy || chosen.size === 0}
                    onClick={() => void start({ kind: "clients", clientIds: [...chosen] })}>
                    {busy ? "Starting…" : "Download"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </dialog>
  );
}
