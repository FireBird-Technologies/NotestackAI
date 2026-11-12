import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { artifactsApi } from "@notestack/shared/endpoints";
import type { Platform, PostableArtifact } from "@notestack/shared/types";
import { SlideFrame } from "../SlideDeck";

const IMAGE_LIMIT: Partial<Record<Platform, number>> = {
  x: 4,
  facebook: 10,
  instagram: 10,
  threads: 10,
  linkedin: 20,
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** A slide deck as it will appear in a social post. Instagram can keep the full 16:9 slide or crop it to a square. */
export function ArtifactDeckPreview({ artifact, platform, editable = false }: {
  artifact: PostableArtifact;
  platform: Platform;
  editable?: boolean;
}) {
  const [pages, setPages] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [positions, setPositions] = useState<number[]>([]);
  const [fits, setFits] = useState<boolean[]>([]);
  const [dragging, setDragging] = useState(false);
  const positionsRef = useRef<number[]>([]);
  const fitsRef = useRef<boolean[]>([]);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const drag = useRef<{ pointerId: number; startX: number; startPosition: number; currentPosition: number } | null>(null);

  useEffect(() => {
    let live = true;
    setPages([]);
    setPage(0);
    setPositions([]);
    setFits([]);
    positionsRef.current = [];
    fitsRef.current = [];
    artifactsApi.get(artifact.id).then((full) => {
      if (!live) return;
      const html = full.content.slides_html;
      const loadedPages = Array.isArray(html) ? html.filter((item): item is string => typeof item === "string") : [];
      const savedPositions = full.content.instagram_x_positions;
      const loadedPositions = Array.isArray(savedPositions)
        ? loadedPages.map((_, index) => typeof savedPositions[index] === "number" ? clamp(savedPositions[index]) : 0.5)
        : loadedPages.map(() => 0.5);
      const savedFits = full.content.instagram_fits;
      // A wide slide should be readable by default. Cropping remains available when the author wants edge-to-edge media.
      const loadedFits = Array.isArray(savedFits)
        ? loadedPages.map((_, index) => typeof savedFits[index] === "boolean" ? savedFits[index] : true)
        : loadedPages.map(() => true);
      setPages(loadedPages);
      positionsRef.current = loadedPositions;
      fitsRef.current = loadedFits;
      setPositions(loadedPositions);
      setFits(loadedFits);
    }, () => undefined);
    return () => { live = false; };
  }, [artifact.id]);

  const visible = pages.slice(0, IMAGE_LIMIT[platform] ?? pages.length);
  const current = Math.min(page, Math.max(visible.length - 1, 0));
  const square = platform === "instagram";
  const fit = fits[current] ?? true;
  const position = positions[current] ?? 0.5;
  const canCrop = square && editable && !fit;

  const savePosition = (index: number, value: number) => {
    const next = Array.from({ length: visible.length }, (_, i) => positionsRef.current[i] ?? 0.5);
    next[index] = value;
    positionsRef.current = next;
    setPositions(next);
    saveQueue.current = saveQueue.current.then(async () => {
      await artifactsApi.update(artifact.id, { content: { instagram_x_positions: next } });
    }).catch(() => undefined);
  };

  const saveFit = (index: number, value: boolean) => {
    const next = Array.from({ length: visible.length }, (_, i) => fitsRef.current[i] ?? true);
    next[index] = value;
    fitsRef.current = next;
    setFits(next);
    saveQueue.current = saveQueue.current.then(async () => {
      await artifactsApi.update(artifact.id, { content: { instagram_fits: next } });
    }).catch(() => undefined);
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!canCrop || (event.target as Element).closest("button")) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startPosition: position, currentPosition: position };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    // A 16:9 slide overflows a square by 7/9 of its width. Moving across that distance traverses the whole crop.
    const overflow = event.currentTarget.clientWidth * (7 / 9);
    const next = clamp(drag.current.startPosition - (event.clientX - drag.current.startX) / Math.max(1, overflow));
    drag.current.currentPosition = next;
    setPositions((currentPositions) => {
      const nextPositions = [...currentPositions];
      nextPositions[current] = next;
      return nextPositions;
    });
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const finished = drag.current;
    if (finished.currentPosition !== finished.startPosition) savePosition(current, finished.currentPosition);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
    setDragging(false);
  };

  if (!visible.length) {
    return <div className="lp-preview-attachment"><span>Loading slide preview</span><strong>{artifact.title}</strong></div>;
  }

  const style = square && !fit
    ? ({ "--deck-crop-offset": `${position * -77.7778}%` } as CSSProperties)
    : undefined;

  return (
    <div className={`lp-preview-deck${square ? " square" : ""}${fit ? " fit" : " crop"}${dragging ? " dragging" : ""}`}
         style={style} role="region" tabIndex={canCrop ? 0 : undefined}
         aria-label={`Slide ${current + 1} of ${visible.length}.${canCrop ? " Drag left or right to position the crop." : ""}`}
         onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}
         onKeyDown={(event) => {
           if (!canCrop || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
           event.preventDefault();
           savePosition(current, clamp(position + (event.key === "ArrowRight" ? 0.05 : -0.05)));
         }}>
      <SlideFrame html={visible[current]} title={`Slide ${current + 1}`} fit={square && fit ? "contain" : "width"} />
      {square && editable && (
        <span className="lp-preview-position-controls">
          <button type="button" className={!fit ? "on" : ""} aria-pressed={!fit}
                  onClick={() => saveFit(current, false)}>Crop</button>
          <button type="button" className={fit ? "on" : ""} aria-pressed={fit}
                  onClick={() => saveFit(current, true)}>Fit</button>
        </span>
      )}
      {canCrop && <span className="lp-preview-drag-hint" aria-hidden="true">↔ Drag slide left or right</span>}
      <span className="lp-preview-deck-count">{current + 1} / {visible.length}</span>
      {visible.length > 1 && (
        <>
          <button type="button" className="lp-preview-deck-nav prev" aria-label="Previous slide"
                  disabled={current === 0} onClick={() => setPage(Math.max(0, current - 1))}>‹</button>
          <button type="button" className="lp-preview-deck-nav next" aria-label="Next slide"
                  disabled={current === visible.length - 1}
                  onClick={() => setPage(Math.min(visible.length - 1, current + 1))}>›</button>
          {square && <span className="lp-preview-carousel-dots" aria-hidden="true">
            {visible.map((_, index) => <i key={index} className={index === current ? "on" : ""} />)}
          </span>}
        </>
      )}
    </div>
  );
}
