import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { EqBand } from "../../utils/audioSettings";
import { bandResponseDb, EQ_MAX_HZ, EQ_MIN_HZ, eqResponseDb, logFrequencies } from "../../utils/eqResponse";

type Props = {
  bands: EqBand[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  onChange: (index: number, change: Partial<EqBand>) => void;
  onAdd: (band: EqBand) => void;
  onRemove: (index: number) => void;
};

const HEIGHT = 300;
const PAD = { left: 40, right: 14, top: 16, bottom: 26 };
const FREQUENCY_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const MAX_GAIN = 24;
/** One semitone, the step the arrow keys move a band by. */
const SEMITONE = 2 ** (1 / 12);

export function formatFrequency(hz: number) {
  return hz >= 1000 ? `${Number((hz / 1000).toPrecision(3))}k` : `${Math.round(hz)}`;
}

function roundFrequency(hz: number) {
  const clamped = Math.min(EQ_MAX_HZ, Math.max(EQ_MIN_HZ, hz));
  return Number(clamped.toPrecision(clamped < 100 ? 2 : 3));
}

const clampGain = (db: number) => Math.round(Math.min(MAX_GAIN, Math.max(-MAX_GAIN, db)) * 10) / 10;
const clampQ = (q: number) => Math.round(Math.min(20, Math.max(0.1, q)) * 100) / 100;

/**
 * The parametric EQ as a frequency response you can play with: drag a band to move it,
 * scroll over it for Q, double-click to add a band, right-click to remove one.
 */
export function EqGraph({ bands, selected, onSelect, onChange, onAdd, onRemove }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const frequencies = useMemo(() => logFrequencies(Math.round(width / 2)), [width]);
  const total = useMemo(() => frequencies.map(frequency => eqResponseDb(bands, frequency)), [frequencies, bands]);
  // The scale widens past ±12 dB only when the curve or a band needs it.
  const range = Math.max(12, ...total.map(Math.abs), ...bands.map(band => Math.abs(band.gainDb))) > 12 ? MAX_GAIN : 12;

  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (hz: number) => PAD.left + (Math.log(hz / EQ_MIN_HZ) / Math.log(EQ_MAX_HZ / EQ_MIN_HZ)) * plotWidth;
  const y = (db: number) => PAD.top + ((range - db) / (2 * range)) * plotHeight;
  const hzAt = (px: number) => EQ_MIN_HZ * (EQ_MAX_HZ / EQ_MIN_HZ) ** ((px - PAD.left) / plotWidth);
  const dbAt = (py: number) => range - ((py - PAD.top) / plotHeight) * 2 * range;
  const path = (values: number[]) => values.map((db, index) => `${index ? "L" : "M"}${x(frequencies[index]).toFixed(1)},${y(db).toFixed(1)}`).join("");
  const curve = path(total);
  const area = `${curve}L${x(EQ_MAX_HZ)},${y(0)}L${x(EQ_MIN_HZ)},${y(0)}Z`;
  const selectedCurve = selected !== null && bands[selected]
    ? path(frequencies.map(frequency => bandResponseDb({ ...bands[selected], enabled: true }, frequency)))
    : null;

  const drag = useRef<{ index: number; pointerId: number; startX: number; startY: number; startHz: number; startDb: number } | null>(null);
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const rect = frame.current!.getBoundingClientRect();
    return { px: event.clientX - rect.left, py: event.clientY - rect.top };
  };

  function startDrag(event: PointerEvent<SVGGElement>, index: number) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(index);
    const { px, py } = localPoint(event);
    drag.current = { index, pointerId: event.pointerId, startX: px, startY: py, startHz: bands[index].frequency, startDb: bands[index].gainDb };
  }

  function moveDrag(event: PointerEvent<SVGGElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const { px, py } = localPoint(event);
    // Shift moves at a quarter of the speed, for fine adjustments.
    const scale = event.shiftKey ? 0.25 : 1;
    const frequency = roundFrequency(hzAt(x(current.startHz) + (px - current.startX) * scale));
    const gainDb = clampGain(dbAt(y(current.startDb) + (py - current.startY) * scale));
    onChange(current.index, { frequency, gainDb });
  }

  function endDrag(event: PointerEvent<SVGGElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  // Scrolling over a band changes how wide it is; the page doesn't scroll meanwhile.
  const wheelTarget = useRef<SVGSVGElement>(null);
  const latest = useRef({ bands, onChange });
  latest.current = { bands, onChange };
  useEffect(() => {
    const svg = wheelTarget.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      const node = (event.target as Element).closest<SVGGElement>("[data-band]");
      if (!node) return;
      event.preventDefault();
      const index = Number(node.dataset.band);
      const band = latest.current.bands[index];
      if (band) latest.current.onChange(index, { q: clampQ(band.q * 1.08 ** (event.deltaY > 0 ? -1 : 1)) });
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, []);

  function addAt(event: React.MouseEvent<SVGSVGElement>) {
    if ((event.target as Element).closest("[data-band]") || bands.length >= 32) return;
    const { px, py } = localPoint(event);
    onAdd({ enabled: true, kind: "peak", frequency: roundFrequency(hzAt(px)), gainDb: clampGain(dbAt(py)), q: 1 });
  }

  function nudge(event: KeyboardEvent<SVGGElement>, index: number) {
    const band = bands[index];
    const fine = event.shiftKey;
    const change: Partial<EqBand> | null =
      event.key === "ArrowLeft" ? { frequency: roundFrequency(band.frequency / (fine ? SEMITONE ** 0.25 : SEMITONE)) }
      : event.key === "ArrowRight" ? { frequency: roundFrequency(band.frequency * (fine ? SEMITONE ** 0.25 : SEMITONE)) }
      : event.key === "ArrowUp" ? { gainDb: clampGain(band.gainDb + (fine ? 0.1 : 0.5)) }
      : event.key === "ArrowDown" ? { gainDb: clampGain(band.gainDb - (fine ? 0.1 : 0.5)) }
      : event.key === "+" || event.key === "=" ? { q: clampQ(band.q * 1.1) }
      : event.key === "-" ? { q: clampQ(band.q / 1.1) }
      : null;
    // The graph keeps these keys; they would otherwise seek or change the volume.
    if (change) {
      event.preventDefault();
      onChange(index, change);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      onRemove(index);
    }
  }

  const gainTicks = range === 12 ? [-12, -6, 0, 6, 12] : [-24, -12, 0, 12, 24];
  return <div className="eqGraph" ref={frame}>
    <svg ref={wheelTarget} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="group"
      aria-label="Parametric EQ response. Double-click to add a band." onDoubleClick={addAt}
      onPointerDown={event => { if (!(event.target as Element).closest("[data-band]")) onSelect(null); }}>
      <defs>
        <linearGradient id="eqFillUp" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0.28" /><stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className="eqGrid" aria-hidden="true">
        {FREQUENCY_TICKS.map(hz => <g key={hz}>
          <line x1={x(hz)} x2={x(hz)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
          <text x={x(hz)} y={HEIGHT - 8} textAnchor={hz === EQ_MIN_HZ ? "start" : hz === EQ_MAX_HZ ? "end" : "middle"}>{formatFrequency(hz)}</text>
        </g>)}
        {gainTicks.map(db => <g key={db}>
          <line x1={PAD.left} x2={width - PAD.right} y1={y(db)} y2={y(db)} data-zero={db === 0 ? "" : undefined} />
          <text x={PAD.left - 8} y={y(db) + 4} textAnchor="end">{db > 0 ? `+${db}` : db}</text>
        </g>)}
      </g>
      <path className="eqArea" d={area} fill="url(#eqFillUp)" />
      {selectedCurve && <path className="eqBandCurve" d={selectedCurve} />}
      <path className="eqCurve" d={curve} />
      {bands.map((band, index) => {
        const cx = x(Math.min(EQ_MAX_HZ, Math.max(EQ_MIN_HZ, band.frequency)));
        const cy = y(Math.max(-range, Math.min(range, band.gainDb)));
        const label = `Band ${index + 1}, ${band.kind === "peak" ? "peak" : band.kind === "lowShelf" ? "low shelf" : "high shelf"}, ${formatFrequency(band.frequency)}Hz, ${band.gainDb > 0 ? "+" : ""}${band.gainDb} dB, Q ${band.q}${band.enabled ? "" : ", off"}`;
        return <g key={index} className="eqNode" data-band={index} data-selected={selected === index || undefined} data-off={!band.enabled || undefined}
          transform={`translate(${cx} ${cy})`} tabIndex={0} role="button" aria-label={label} aria-pressed={selected === index}
          onPointerDown={event => startDrag(event, index)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
          onDoubleClick={event => { event.stopPropagation(); onChange(index, { enabled: !band.enabled }); }}
          onContextMenu={event => { event.preventDefault(); onRemove(index); }}
          onFocus={() => onSelect(index)} onKeyDown={event => nudge(event, index)}>
          <circle r="14" className="eqNodeHit" />
          <circle r="10" className="eqNodeDot" />
          <text y="3.5" textAnchor="middle">{index + 1}</text>
        </g>;
      })}
    </svg>
  </div>;
}
