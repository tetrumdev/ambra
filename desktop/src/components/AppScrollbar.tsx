import { useEffect, useRef } from "react";
import "./AppScrollbar.css";
import { reducedMotion } from "../utils/reducedMotion";

type AppScrollbarProps = {
  scrollElement: HTMLElement | null;
  /** Kept in place behind the player rather than unmounted. */
  hidden?: boolean;
};

const MINIMUM_THUMB_HEIGHT = 36;
const clamp = (value: number, maximum: number) => Math.min(maximum, Math.max(0, value));

export function AppScrollbar({ scrollElement, hidden = false }: AppScrollbarProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rail = railRef.current;
    const thumb = thumbRef.current;
    if (thumb && !scrollElement) thumb.hidden = true;
    if (!scrollElement || !rail || !thumb) return;

    let maximumScroll = 0;
    let thumbHeight = 0;
    let thumbTravel = 0;
    let measureFrame = 0;
    let motionFrame = 0;
    let targetScroll = scrollElement.scrollTop;
    let animatedScroll = targetScroll;
    let lastWrittenScroll = targetScroll;
    let lastFrameTime = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let drag: { pointerId: number; y: number; scroll: number } | null = null;
    const previousScrollBehavior = scrollElement.style.scrollBehavior;
    // Interpolation owns smooth motion; dragging always follows the pointer directly.
    scrollElement.style.scrollBehavior = "auto";

    const showActivity = () => {
      rail.dataset.active = "true";
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => delete rail.dataset.active, 700);
    };

    const updatePosition = () => {
      const top = maximumScroll > 0
        ? (clamp(scrollElement.scrollTop, maximumScroll) / maximumScroll) * thumbTravel
        : 0;
      thumb.style.transform = `translate3d(0, ${top}px, 0)`;
    };

    const stopMotion = () => {
      cancelAnimationFrame(motionFrame);
      motionFrame = 0;
      targetScroll = scrollElement.scrollTop;
    };

    const animate = (time: number) => {
      if (scrollElement.scrollTop !== lastWrittenScroll) {
        stopMotion();
        return;
      }
      const elapsed = Math.min(64, time - lastFrameTime);
      lastFrameTime = time;
      targetScroll = clamp(targetScroll, maximumScroll);
      const distance = targetScroll - animatedScroll;
      if (reducedMotion() || Math.abs(distance) < 0.5) {
        scrollElement.scrollTop = targetScroll;
        motionFrame = 0;
      } else {
        // Time-based easing feels the same at 60, 120 and 144 Hz.
        // Keep subpixel progress even when the WebView rounds scrollTop to whole pixels.
        animatedScroll += distance * (1 - Math.exp(-elapsed / 55));
        scrollElement.scrollTop = animatedScroll;
        motionFrame = requestAnimationFrame(animate);
      }
      lastWrittenScroll = scrollElement.scrollTop;
      updatePosition();
    };

    const scrollTo = (position: number) => {
      targetScroll = clamp(position, maximumScroll);
      showActivity();
      if (reducedMotion()) {
        stopMotion();
        scrollElement.scrollTop = clamp(position, maximumScroll);
        updatePosition();
      } else if (!motionFrame) {
        animatedScroll = scrollElement.scrollTop;
        lastWrittenScroll = animatedScroll;
        lastFrameTime = performance.now();
        motionFrame = requestAnimationFrame(animate);
      }
    };

    const measure = () => {
      measureFrame = 0;
      const railHeight = rail.clientHeight;
      maximumScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      thumbHeight = maximumScroll === 0 ? railHeight : Math.min(railHeight,
        Math.max(MINIMUM_THUMB_HEIGHT, (scrollElement.clientHeight / scrollElement.scrollHeight) * railHeight));
      thumbTravel = Math.max(0, railHeight - thumbHeight);
      thumb.style.height = `${thumbHeight}px`;
      thumb.hidden = maximumScroll === 0;
      updatePosition();
    };

    const scheduleMeasure = () => {
      if (!measureFrame) measureFrame = requestAnimationFrame(measure);
    };
    const onScroll = () => {
      updatePosition();
      showActivity();
    };

    const onWheel = (event: WheelEvent) => {
      if (hidden || drag || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY || maximumScroll <= 0) return;
      if (motionFrame && scrollElement.scrollTop !== lastWrittenScroll) stopMotion();

      // Nested lists and controls retain their own scrolling and wheel gestures.
      for (let node = event.target instanceof Element ? event.target : null;
        node && node !== scrollElement && node !== rail; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) return;
      }
      // Fine trackpad deltas already carry momentum; keep their native, direct response.
      if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(event.deltaY) < 40 && event.currentTarget !== rail) {
        stopMotion();
        return;
      }
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scrollElement.clientHeight : 1;
      event.preventDefault();
      scrollTo((motionFrame ? targetScroll : scrollElement.scrollTop) + event.deltaY * unit);
    };

    const finishDrag = () => {
      if (!drag) return;
      const { pointerId } = drag;
      drag = null;
      delete thumb.dataset.dragging;
      if (rail.hasPointerCapture(pointerId)) rail.releasePointerCapture(pointerId);
      showActivity();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (hidden || event.button !== 0 || !event.isPrimary || maximumScroll <= 0) return;
      event.preventDefault();
      stopMotion();
      showActivity();
      if (event.target === thumb) {
        drag = { pointerId: event.pointerId, y: event.clientY, scroll: scrollElement.scrollTop };
        rail.setPointerCapture(event.pointerId);
        thumb.dataset.dragging = "true";
      } else if (thumbTravel > 0) {
        const top = event.clientY - rail.getBoundingClientRect().top - rail.clientTop - thumbHeight / 2;
        scrollTo((clamp(top, thumbTravel) / thumbTravel) * maximumScroll);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId || thumbTravel <= 0) return;
      scrollElement.scrollTop = clamp(drag.scroll + ((event.clientY - drag.y) / thumbTravel) * maximumScroll, maximumScroll);
      updatePosition();
      showActivity();
    };

    measure();
    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    scrollElement.addEventListener("wheel", onWheel, { passive: false });
    scrollElement.addEventListener("pointerdown", stopMotion, { passive: true });
    scrollElement.addEventListener("keydown", stopMotion);
    scrollElement.addEventListener("load", scheduleMeasure, true);
    rail.addEventListener("wheel", onWheel, { passive: false });
    rail.addEventListener("pointerdown", onPointerDown);
    rail.addEventListener("pointermove", onPointerMove);
    rail.addEventListener("pointerup", finishDrag);
    rail.addEventListener("pointercancel", finishDrag);
    rail.addEventListener("lostpointercapture", finishDrag);
    window.addEventListener("blur", finishDrag);

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    const observeContent = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(scrollElement);
      resizeObserver.observe(rail);
      for (const child of scrollElement.children) resizeObserver.observe(child);
      scheduleMeasure();
    };
    observeContent();
    const mutationObserver = new MutationObserver(observeContent);
    mutationObserver.observe(scrollElement, { childList: true, subtree: true, characterData: true });

    return () => {
      stopMotion();
      finishDrag();
      cancelAnimationFrame(measureFrame);
      clearTimeout(idleTimer);
      delete rail.dataset.active;
      scrollElement.style.scrollBehavior = previousScrollBehavior;
      scrollElement.removeEventListener("scroll", onScroll);
      scrollElement.removeEventListener("wheel", onWheel);
      scrollElement.removeEventListener("pointerdown", stopMotion);
      scrollElement.removeEventListener("keydown", stopMotion);
      scrollElement.removeEventListener("load", scheduleMeasure, true);
      rail.removeEventListener("wheel", onWheel);
      rail.removeEventListener("pointerdown", onPointerDown);
      rail.removeEventListener("pointermove", onPointerMove);
      rail.removeEventListener("pointerup", finishDrag);
      rail.removeEventListener("pointercancel", finishDrag);
      rail.removeEventListener("lostpointercapture", finishDrag);
      window.removeEventListener("blur", finishDrag);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [scrollElement, hidden]);

  return (
    <div className="appScrollbar" ref={railRef} aria-hidden="true" data-hidden={hidden || undefined}>
      <div className="appScrollbarThumb" ref={thumbRef} />
    </div>
  );
}
