import { useEffect, useRef } from "react";
import "./AppScrollbar.css";

type AppScrollbarProps = {
  scrollElement: HTMLElement | null;
};

type ScrollMetrics = {
  maximumScroll: number;
  thumbHeight: number;
  thumbTravel: number;
};

const MINIMUM_THUMB_HEIGHT = 36;

export function AppScrollbar({ scrollElement }: AppScrollbarProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const metricsRef = useRef<ScrollMetrics>({
    maximumScroll: 0,
    thumbHeight: 0,
    thumbTravel: 0,
  });
  const measureFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    const thumb = thumbRef.current;
    if (!scrollElement || !rail || !thumb) return;

    const updatePosition = () => {
      const { maximumScroll, thumbTravel } = metricsRef.current;
      const top =
        maximumScroll > 0
          ? (scrollElement.scrollTop / maximumScroll) * thumbTravel
          : 0;
      thumb.style.transform = `translate3d(0, ${top}px, 0)`;
    };

    const measure = () => {
      measureFrameRef.current = null;
      const railHeight = rail.clientHeight;
      const maximumScroll = Math.max(
        0,
        scrollElement.scrollHeight - scrollElement.clientHeight,
      );
      const thumbHeight =
        maximumScroll === 0
          ? railHeight
          : Math.min(
              railHeight,
              Math.max(
                MINIMUM_THUMB_HEIGHT,
                (scrollElement.clientHeight / scrollElement.scrollHeight) *
                  railHeight,
              ),
            );

      metricsRef.current = {
        maximumScroll,
        thumbHeight,
        thumbTravel: Math.max(0, railHeight - thumbHeight),
      };
      thumb.style.height = `${thumbHeight}px`;
      thumb.hidden = maximumScroll === 0;
      updatePosition();
    };

    const scheduleMeasure = () => {
      if (measureFrameRef.current !== null) return;
      measureFrameRef.current = requestAnimationFrame(measure);
    };

    measure();
    scrollElement.addEventListener("scroll", updatePosition, { passive: true });

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scrollElement);
    resizeObserver.observe(rail);

    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(scrollElement, {
      childList: true,
      subtree: true,
    });

    return () => {
      scrollElement.removeEventListener("scroll", updatePosition);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (measureFrameRef.current !== null) {
        cancelAnimationFrame(measureFrameRef.current);
        measureFrameRef.current = null;
      }
    };
  }, [scrollElement]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const thumb = thumbRef.current;
    if (!scrollElement || !railRef.current || !thumb) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startingY = event.clientY;
    const startingScroll = scrollElement.scrollTop;
    const { maximumScroll, thumbTravel } = metricsRef.current;
    const previousInlineScrollBehavior = scrollElement.style.scrollBehavior;
    scrollElement.style.scrollBehavior = "auto";
    thumb.dataset.dragging = "true";

    const drag = (moveEvent: PointerEvent) => {
      if (thumbTravel <= 0) return;

      const nextScroll = Math.min(
        maximumScroll,
        Math.max(
          0,
          startingScroll +
            ((moveEvent.clientY - startingY) / thumbTravel) * maximumScroll,
        ),
      );
      const nextTop = (nextScroll / maximumScroll) * thumbTravel;

      // Keep the visual thumb under the pointer without waiting for WebView2's
      // scroll event, then update the content with smooth behavior disabled.
      thumb.style.transform = `translate3d(0, ${nextTop}px, 0)`;
      scrollElement.scrollTop = nextScroll;
    };

    const finish = () => {
      scrollElement.style.scrollBehavior = previousInlineScrollBehavior;
      delete thumb.dataset.dragging;
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };

    window.addEventListener("pointermove", drag);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  return (
    <div className="appScrollbar" ref={railRef} aria-hidden="true">
      <div
        className="appScrollbarThumb"
        ref={thumbRef}
        onPointerDown={beginDrag}
      />
    </div>
  );
}
