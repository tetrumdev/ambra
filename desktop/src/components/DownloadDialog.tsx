import "./ExtraCtrls.css";
import "./DownloadDialog.css";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { DropdownChevron } from "./DropdownChevron";
import { closeDialog, openDialog } from "../utils/dialogs";
import { getServerConnection, subscribeServerConnection } from "../api/serverConnection";
import {
  closeDownloadDialog,
  downloadClients,
  downloadQualities,
  requestDownloads,
  useDownloadDialogRequest,
  type DownloadClient,
  type DownloadQuality,
} from "../utils/offlineDownloads";

type Step = "target" | "clients";

function songs(count: number) {
  return `${count} ${count === 1 ? "song" : "songs"}`;
}

function QualityPicker({ quality, disabled, onChange }: {
  quality: DownloadQuality; disabled: boolean; onChange: (quality: DownloadQuality) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const bounds = trigger.current!.getBoundingClientRect();
      const width = Math.min(bounds.width, window.innerWidth - 24);
      // Measure at the trigger's width, before text wrapping determines placement.
      menu.current!.style.width = `${width}px`;
      const height = menu.current!.offsetHeight;
      const below = bounds.bottom + 6;
      setPosition({
        left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
        top: Math.max(12, below + height <= window.innerHeight - 12 ? below : bounds.top - height - 6),
        width,
      });
    };
    reposition();
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const close = () => {
    menu.current?.hidePopover();
    trigger.current?.focus();
  };

  return <div className="downloadQuality">
    <span id={`${id}-label`}>Quality</span>
    <button ref={trigger} type="button" className="downloadQualityTrigger" disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => menu.current?.togglePopover()}
      onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        menu.current?.showPopover();
      }}>
      <span id={`${id}-value`}>{downloadQualities.find(option => option.id === quality)?.label}</span>
      <DropdownChevron />
    </button>
    {/* A popover stays above the modal without being clipped by the dialog's scrolling area. */}
    <div ref={menu} id={id} popover="auto" className="devAudioControls downloadQualityMenu"
      role="dialog" aria-label="Download quality" style={{ ...position, visibility: open ? "visible" : "hidden" }}
      onToggle={event => setOpen(event.newState === "open")}
      onBlur={event => {
        if (event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          menu.current?.hidePopover();
        }
      }}
      onKeyDown={event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next]?.focus();
      }}>
      <div role="radiogroup" aria-label="Quality">
        {downloadQualities.map(option => <button key={option.id} type="button" className="audioDeviceOption"
          role="radio" aria-checked={option.id === quality} tabIndex={option.id === quality ? 0 : -1}
          onClick={() => { onChange(option.id); close(); }}>
          <span className="audioDeviceCheck" aria-hidden="true" />
          <span>{option.label}</span>
        </button>)}
      </div>
    </div>
  </div>;
}

/** The menu every Download action opens: where to download to, and at what quality. */
export function DownloadDialog() {
  const request = useDownloadDialogRequest();
  const connection = useSyncExternalStore(subscribeServerConnection, getServerConnection);
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState<Step>("target");
  const [quality, setQuality] = useState<DownloadQuality>("max");
  const [clients, setClients] = useState<DownloadClient[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (request) {
      setStep("target");
      setQuality("max");
      setChosen(new Set());
      setError(null);
      openDialog(dialog.current);
    } else {
      closeDialog(dialog.current);
    }
  }, [request]);

  // The open apps, kept current while they're being chosen.
  useEffect(() => {
    if (!request || step !== "clients") return;
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
  }, [request, step]);

  const count = request?.trackIds.length ?? 0;
  const noServer = !!connection && !connection.server;

  async function start(target: Parameters<typeof requestDownloads>[2]) {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestDownloads(request.trackIds, quality, target);
      closeDownloadDialog(request);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

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
        {step === "clients" ? "Back" : "Cancel"}
      </button>
      <div className="downloadDialogContent">
        <h2>Download {request?.title ?? ""}</h2>
        <p>{songs(count)}</p>
        {count === 0 ? (
          <p role="alert">None of these songs can be downloaded. Only songs from a streaming service can.</p>
        ) : noServer ? (
          <p role="alert">Connect to a server to download.</p>
        ) : (
          <>
            <QualityPicker quality={quality} disabled={busy} onChange={setQuality} />
            {step === "target" ? (
              <div className="playlistEditButtons downloadTargets">
                <button type="button" disabled={busy} onClick={() => void start({ kind: "server" })}>
                  <img src="/download.svg" alt="" aria-hidden="true" />
                  Download to Server
                </button>
                <button type="button" className="downloadClientTarget" disabled={busy} onClick={() => { setClients(null); setError(null); setStep("clients"); }}>
                  <img src="/download.svg" alt="" aria-hidden="true" />
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
