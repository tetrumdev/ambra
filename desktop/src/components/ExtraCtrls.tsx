import "./ExtraCtrls.css";

type ExtraCtrlsProps = {
  onOpenQueue?: () => void;
};

export function ExtraCtrls({ onOpenQueue }: ExtraCtrlsProps) {
  return (
    <button id="queueBtn" type="button" onClick={onOpenQueue}>
      <img src="/queue.svg" alt="Queue" id="queueImg" />
    </button>
  );
}
