import { useEffect, useRef, useState } from "react";
import "./ShortcutToast.css";

const SHOWN_MS = 1400;

/** A brief notice above the player bar saying what a keyboard shortcut just did (announceShortcut). */
export function ShortcutToast() {
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const show = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      clearTimeout(timer.current);
      setNotice(current => ({ text, key: (current?.key ?? 0) + 1 }));
      timer.current = setTimeout(() => setNotice(null), SHOWN_MS);
    };
    window.addEventListener("ambra:shortcut", show);
    return () => { window.removeEventListener("ambra:shortcut", show); clearTimeout(timer.current); };
  }, []);
  return <div className="shortcutToast" role="status" aria-live="polite" data-shown={notice ? "true" : undefined}>
    {notice && <span key={notice.key} className="shortcutToastBody">
      <span className="shortcutToastText">{notice.text}</span>
    </span>}
  </div>;
}
