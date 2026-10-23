import { dismissUpdate, installUpdate, useAppUpdate } from "../hooks/useAppUpdate";
import "./UpdateNotice.css";

/** Offers a newly released version once a check finds one; Settings has the same controls. */
export function UpdateNotice() {
  const update = useAppUpdate();
  if (update.status === "installing") {
    return <div className="updateNotice" role="status">
      <span>Updating to AMBRA {update.version}{update.progress === null ? "…" : ` · ${Math.round(update.progress * 100)}%`}</span>
    </div>;
  }
  if (update.status !== "available" || update.dismissed) return null;
  return <div className="updateNotice" role="status">
    <span>AMBRA {update.version} is available</span>
    <button type="button" className="updateNoticeInstall" onClick={() => void installUpdate()}>Update and restart</button>
    <button type="button" className="updateNoticeDismiss" aria-label="Later" data-tooltip="Later" onClick={dismissUpdate}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
    </button>
  </div>;
}
