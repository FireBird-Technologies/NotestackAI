import { useEffect, useRef } from "react";

/**
 * Night sky: three parallax layers of stars, small four point sparkles that twinkle, and a rare
 * shooting star. Only white and #217cff. With prefers-reduced-motion it paints one static frame.
 */

type Star = { x: number; y: number; r: number; a: number; layer: number; phase: number; speed: number };
type Sparkle = Star & { size: number; blue: boolean };
type Meteor = { x: number; y: number; vx: number; vy: number; life: number };

const LAYERS = [
  { density: 0.00018, parallax: 6, drift: 0.004 },
  { density: 0.00009, parallax: 14, drift: 0.008 },
  { density: 0.00003, parallax: 26, drift: 0.014 },
];
const SPARKLE_DENSITY = 0.000022;
const BLUE = "33, 124, 255";

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

export default function SkyCanvas({ intensity = 1 }: { intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let stars: Star[] = [];
    let sparkles: Sparkle[] = [];
    let meteor: Meteor | null = null;
    let nextMeteorAt = performance.now() + rand(4000, 9000);
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    let raf = 0;
    let scroll = 0;

    const build = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const area = w * h;
      stars = [];
      LAYERS.forEach((layer, i) => {
        const count = Math.round(area * layer.density * intensity);
        for (let n = 0; n < count; n++) {
          stars.push({
            x: Math.random() * w,
            y: Math.random() * h,
            r: rand(0.3, 0.7) + i * 0.35,
            a: rand(0.25, 0.8),
            layer: i,
            phase: Math.random() * Math.PI * 2,
            speed: rand(0.4, 1.4),
          });
        }
      });
      sparkles = [];
      const sCount = Math.max(6, Math.round(area * SPARKLE_DENSITY * intensity));
      for (let n = 0; n < sCount; n++) {
        sparkles.push({
          x: Math.random() * w,
          y: Math.random() * h * 0.85,
          r: 1,
          a: 1,
          layer: 2,
          phase: Math.random() * Math.PI * 2,
          speed: rand(0.35, 0.9),
          size: rand(3, 7),
          blue: Math.random() < 0.35,
        });
      }
    };

    const drawSparkle = (s: Sparkle, alpha: number, ox: number, oy: number) => {
      const x = s.x + ox;
      const y = s.y + oy;
      const len = s.size * (0.6 + alpha * 0.6);
      const color = s.blue ? BLUE : "255, 255, 255";
      const glow = ctx.createRadialGradient(x, y, 0, x, y, len * 1.6);
      glow.addColorStop(0, `rgba(${color}, ${0.35 * alpha})`);
      glow.addColorStop(1, `rgba(${color}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, len * 1.6, 0, Math.PI * 2);
      ctx.fill();
      // four point star: two thin diamonds
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      const t = Math.max(0.6, len * 0.12);
      ctx.beginPath();
      ctx.moveTo(x, y - len);
      ctx.lineTo(x + t, y);
      ctx.lineTo(x, y + len);
      ctx.lineTo(x - t, y);
      ctx.closePath();
      ctx.moveTo(x - len, y);
      ctx.lineTo(x, y + t);
      ctx.lineTo(x + len, y);
      ctx.lineTo(x, y - t);
      ctx.closePath();
      ctx.fill();
    };

    const frame = (now: number) => {
      const t = now / 1000;
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      ctx.clearRect(0, 0, w, h);

      for (const s of stars) {
        const layer = LAYERS[s.layer];
        const ox = reduced ? 0 : -pointer.x * layer.parallax;
        const oy = reduced ? 0 : -pointer.y * layer.parallax - scroll * layer.drift * 20;
        let x = s.x + ox + (reduced ? 0 : t * layer.drift * 10);
        let y = (s.y + oy) % h;
        if (y < 0) y += h;
        x = ((x % w) + w) % w;
        const twinkle = reduced ? 1 : 0.65 + 0.35 * Math.sin(t * s.speed + s.phase);
        ctx.fillStyle = `rgba(255, 255, 255, ${s.a * twinkle})`;
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const s of sparkles) {
        const pulse = reduced ? 0.8 : Math.max(0, Math.sin(t * s.speed + s.phase));
        const alpha = Math.pow(pulse, 3);
        if (alpha > 0.02) {
          drawSparkle(s, alpha, reduced ? 0 : -pointer.x * 20, reduced ? 0 : -pointer.y * 20);
        }
      }

      if (!reduced) {
        if (!meteor && now > nextMeteorAt) {
          meteor = { x: rand(w * 0.2, w), y: rand(0, h * 0.35), vx: -rand(7, 11), vy: rand(2.5, 4), life: 1 };
        }
        if (meteor) {
          const m = meteor;
          const tail = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 14, m.y - m.vy * 14);
          tail.addColorStop(0, `rgba(255, 255, 255, ${0.9 * m.life})`);
          tail.addColorStop(0.3, `rgba(${BLUE}, ${0.5 * m.life})`);
          tail.addColorStop(1, `rgba(${BLUE}, 0)`);
          ctx.strokeStyle = tail;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(m.x, m.y);
          ctx.lineTo(m.x - m.vx * 14, m.y - m.vy * 14);
          ctx.stroke();
          m.x += m.vx;
          m.y += m.vy;
          m.life -= 0.012;
          if (m.life <= 0 || m.x < -200 || m.y > h + 200) {
            meteor = null;
            nextMeteorAt = now + rand(6000, 14000);
          }
        }
        raf = requestAnimationFrame(frame);
      }
    };

    const onResize = () => {
      build();
      if (reduced) frame(performance.now());
    };
    const onPointer = (e: PointerEvent) => {
      pointer.tx = e.clientX / window.innerWidth - 0.5;
      pointer.ty = e.clientY / window.innerHeight - 0.5;
    };
    const onScroll = () => {
      scroll = window.scrollY / 100;
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) raf = requestAnimationFrame(frame);
    };

    build();
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    if (!reduced) {
      window.addEventListener("pointermove", onPointer, { passive: true });
      window.addEventListener("scroll", onScroll, { passive: true });
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intensity]);

  return (
    <div className="sky" aria-hidden="true">
      <div className="sky-nebula" />
      <canvas ref={ref} className="sky-canvas" />
    </div>
  );
}
