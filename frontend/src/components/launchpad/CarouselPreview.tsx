import { useEffect, useRef, useState, type PointerEvent } from "react";
import { artifactsApi } from "@notestack/shared/endpoints";
import type { Platform, PostableArtifact } from "@notestack/shared/types";

const IMAGE_LIMIT: Partial<Record<Platform, number>> = {
  x: 4,
  facebook: 10,
  instagram: 10,
  threads: 10,
  linkedin: 20,
};

/** A bounded image carousel for social previews and attachment previews. */
export function CarouselSlider({ urls, title, square = false, positions = [], fits = [], onPositionChange, onFitChange }: {
  urls: string[];
  title: string;
  square?: boolean;
  positions?: number[];
  fits?: boolean[];
  onPositionChange?: (index: number, position: number) => void;
  onFitChange?: (index: number, fit: boolean) => void;
}) {
  const [page, setPage] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [localPositions, setLocalPositions] = useState<number[]>(positions);
  const [localFits, setLocalFits] = useState<boolean[]>(fits);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; startPosition: number;
                        currentPosition: number; axis: "horizontal" | "vertical" | null } | null>(null);
  const current = Math.min(page, Math.max(urls.length - 1, 0));
  const position = localPositions[current] ?? 0.5;
  const fit = localFits[current] ?? false;
  const repositionable = square && !fit && !!onPositionChange;
  const fitToggleable = square && !!onFitChange;
  const images = urls.join("\n");
  const savedPositions = positions.join(",");
  const savedFits = fits.map(Number).join(",");

  useEffect(() => setPage(0), [images]);
  useEffect(() => setLocalPositions(positions), [savedPositions]);
  useEffect(() => setLocalFits(fits), [savedFits]);
  if (!urls.length) return null;

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if ((!repositionable && urls.length < 2) || (event.target as Element).closest("button")) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
                     startPosition: position, currentPosition: position, axis: null };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    setDragX(0);
    setDragY(0);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const x = event.clientX - drag.current.startX;
    const y = event.clientY - drag.current.startY;
    // Lock the gesture after a few pixels. Reclassifying it on every event made a slightly diagonal vertical drag turn
    // into a horizontal swipe at pointer-up, so the crop shown during the drag was never saved.
    if (!drag.current.axis) {
      if (Math.max(Math.abs(x), Math.abs(y)) < 4) return;
      drag.current.axis = repositionable && Math.abs(y) > Math.abs(x) ? "vertical" : "horizontal";
    }
    if (drag.current.axis === "vertical") {
      const nextPosition = Math.max(0, Math.min(1, drag.current.startPosition - y / event.currentTarget.clientHeight));
      drag.current.currentPosition = nextPosition;
      setLocalPositions((currentPositions) => {
        const next = [...currentPositions];
        next[current] = nextPosition;
        return next;
      });
      setDragX(0);
      setDragY(0);
      return;
    }
    const distance = x;
    // At either end, resistance makes it clear there is no image beyond this one.
    const atEdge = (current === 0 && distance > 0) || (current === urls.length - 1 && distance < 0);
    const moved = atEdge ? distance * 0.24 : distance;
    setDragX(moved);
    setDragY(0);
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const finished = drag.current;
    const x = event.clientX - drag.current.startX;
    if (finished.axis === "vertical" && repositionable
        && finished.currentPosition !== finished.startPosition) {
      // A browser can cancel a captured pointer when focus or native gesture handling changes. Keep and save the last
      // crop the user actually saw instead of snapping back to the starting position.
      onPositionChange(current, finished.currentPosition);
    }
    const distance = x;
    const size = event.currentTarget.clientWidth;
    const threshold = Math.min(80, size * 0.15);
    if (!cancelled && finished.axis === "horizontal" && Math.abs(distance) >= threshold) {
      setPage(distance < 0 ? Math.min(urls.length - 1, current + 1) : Math.max(0, current - 1));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    setIsDragging(false);
    setDragX(0);
    setDragY(0);
  };

  return (
    <div className={`lp-preview-carousel${square ? " square" : ""}${fit ? " fit" : ""}${isDragging ? " dragging" : ""}`}
         role="region" tabIndex={urls.length > 1 ? 0 : undefined}
         aria-label={`Image ${current + 1} of ${urls.length}. ${repositionable ? "Drag up or down to position the crop. " : ""}Drag sideways or use arrow keys to browse.`}
         aria-live="polite" title={repositionable ? "Drag up or down to position this image" : urls.length > 1 ? "Drag or swipe to browse images" : undefined}
         onPointerDown={startDrag} onPointerMove={moveDrag}
         onPointerUp={(event) => finishDrag(event)} onPointerCancel={(event) => finishDrag(event, true)}
         onKeyDown={(event) => {
           if (repositionable && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
             event.preventDefault();
             const nextPosition = Math.max(0, Math.min(1, position + (event.key === "ArrowUp" ? 0.05 : -0.05)));
             setLocalPositions((currentPositions) => {
               const next = [...currentPositions];
               next[current] = nextPosition;
               return next;
             });
             onPositionChange(current, nextPosition);
           } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
             event.preventDefault();
             setPage(Math.max(0, current - 1));
           } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
             event.preventDefault();
             setPage(Math.min(urls.length - 1, current + 1));
           }
         }}>
      <img src={urls[current]} alt={`${title}, image ${current + 1} of ${urls.length}`}
           draggable={false} style={{ transform: `translate(${dragX}px, ${dragY}px)`,
                                      objectPosition: square && !fit ? `50% ${position * 100}%` : undefined }} />
      {fitToggleable && (
        <span className="lp-preview-position-controls">
          <button type="button" className={!fit ? "on" : ""} aria-pressed={!fit}
                  onClick={() => {
                    const next = [...localFits];
                    next[current] = false;
                    setLocalFits(next);
                    onFitChange(current, false);
                  }}>Crop</button>
          <button type="button" className={fit ? "on" : ""} aria-pressed={fit}
                  onClick={() => {
                    const next = [...localFits];
                    next[current] = true;
                    setLocalFits(next);
                    onFitChange(current, true);
                  }}>Fit</button>
        </span>
      )}
      {repositionable && <span className="lp-preview-drag-hint" aria-hidden="true">↕ Drag image up or down</span>}
      {urls.length > 1 && (
        <>
          <span className="lp-preview-deck-count">{current + 1} / {urls.length}</span>
          <button type="button" className="lp-preview-deck-nav prev" aria-label="Previous image"
                  disabled={current === 0} onClick={() => setPage(Math.max(0, current - 1))}>‹</button>
          <button type="button" className="lp-preview-deck-nav next" aria-label="Next image"
                  disabled={current === urls.length - 1}
                  onClick={() => setPage(Math.min(urls.length - 1, current + 1))}>›</button>
          <span className="lp-preview-carousel-dots" aria-hidden="true">
            {urls.map((_, index) => <i key={index} className={index === current ? "on" : ""} />)}
          </span>
        </>
      )}
    </div>
  );
}

/** Load an uploaded/generated carousel's signed image URLs, falling back to its first thumbnail while loading. */
export function ArtifactCarouselPreview({ artifact, platform, editable = false }: {
  artifact: PostableArtifact;
  platform: Platform;
  editable?: boolean;
}) {
  const [urls, setUrls] = useState<string[]>([]);
  const [positions, setPositions] = useState<number[]>([]);
  const [fits, setFits] = useState<boolean[]>([]);
  const positionsRef = useRef<number[]>([]);
  const fitsRef = useRef<boolean[]>([]);
  const editRevision = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    editRevision.current = 0;
    const loadRevision = editRevision.current;
    setUrls([]);
    positionsRef.current = [];
    fitsRef.current = [];
    setPositions([]);
    setFits([]);
    artifactsApi.get(artifact.id).then((full) => {
      if (!live) return;
      setUrls(full.slide_urls.filter((url): url is string => typeof url === "string" && !!url));
      const saved = full.content.instagram_positions;
      const savedFits = full.content.instagram_fits;
      // Do not let a slow initial read replace a crop the user already adjusted while the images were loading.
      if (editRevision.current === loadRevision) {
        const loaded = Array.isArray(saved)
          ? saved.map((value) => typeof value === "number" ? value : 0.5)
          : [];
        positionsRef.current = loaded;
        const loadedFits = Array.isArray(savedFits)
          ? savedFits.map((value) => value === true)
          : [];
        fitsRef.current = loadedFits;
        setPositions(loaded);
        setFits(loadedFits);
      }
    }, () => undefined);
    return () => { live = false; };
  }, [artifact.id]);

  const available = urls.length ? urls : artifact.thumb_url ? [artifact.thumb_url] : [];
  const visible = available.slice(0, IMAGE_LIMIT[platform] ?? available.length);
  return (
    <CarouselSlider urls={visible} title={artifact.title} square={platform === "instagram"} positions={positions} fits={fits}
                    onPositionChange={editable && platform === "instagram" ? (index, position) => {
                      const next = Array.from({ length: visible.length }, (_, i) => positionsRef.current[i] ?? 0.5);
                      next[index] = position;
                      positionsRef.current = next;
                      setPositions(next);
                      editRevision.current += 1;
                      // Preserve save order when someone makes several quick adjustments. Otherwise an older request
                      // can finish last and make the image jump back the next time this preview is opened.
                      saveQueue.current = saveQueue.current.then(async () => {
                        await artifactsApi.update(artifact.id, { content: { instagram_positions: next } });
                      }).catch(() => undefined);
                    } : undefined}
                    onFitChange={editable && platform === "instagram" ? (index, fit) => {
                      const next = Array.from({ length: visible.length }, (_, i) => fitsRef.current[i] ?? false);
                      next[index] = fit;
                      fitsRef.current = next;
                      setFits(next);
                      editRevision.current += 1;
                      saveQueue.current = saveQueue.current.then(async () => {
                        await artifactsApi.update(artifact.id, { content: { instagram_fits: next } });
                      }).catch(() => undefined);
                    } : undefined} />
  );
}
