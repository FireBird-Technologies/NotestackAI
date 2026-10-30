import { useEffect, useRef, useState } from "react";
import type { ReportBlock } from "@notestack/shared/types";

import { displayTitle, shortLabel, visibleValue } from "@notestack/shared/report";

type PlotBlock = Extract<ReportBlock, { type: "plot" }>;





/** A deliberately small Plotly adapter: the server supplies normalized points, never Plotly code or arbitrary JSON. */
export function ReportPlot({ block }: { block: PlotBlock }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const title = displayTitle(block);
  const chartLabel = block.plot_kind === "pie" ? "Donut chart" : `${block.plot_kind[0].toUpperCase()}${block.plot_kind.slice(1)} chart`;

  useEffect(() => {
    const element = ref.current;
    if (!element || block.points.length < 2) return;
    let disposed = false;
    let resize: ResizeObserver | undefined;
    void import("plotly.js-basic-dist-min").then(async ({ default: Plotly }) => {
      if (disposed) return;
      const labels = block.points.map((p) => p.label);
      const axisLabels = labels.map((label) => shortLabel(label));
      const values = block.points.map((p) => p.value);
      const hover = block.points.map((p) => p.detail || p.display_value || String(p.value));
      const valueLabels = block.points.map(visibleValue);
      const horizontal = block.plot_kind === "bar" && (block.points.length <= 5 || labels.some((label) => label.length > 18));
      const marker = {
        color: values.map((_, index) => index === 0 ? "#217cff" : `rgba(33, 124, 255, ${Math.max(0.42, 0.82 - index * 0.055)})`),
        line: { color: "rgba(255,255,255,.15)", width: 1 },
      };
      const trace = block.plot_kind === "pie"
        ? {
            type: "pie", labels, values, customdata: hover, textinfo: "percent", textposition: "outside",
            hovertemplate: "<b>%{label}</b><br>%{value}<br>%{customdata}<extra></extra>",
            hole: 0.58, sort: false, marker,
          }
        : horizontal
          ? {
              type: "bar", orientation: "h", x: values, y: axisLabels, customdata: hover,
              text: valueLabels, textposition: "outside", cliponaxis: false,
              hovertemplate: "<b>%{y}</b><br>%{x}<br>%{customdata}<extra></extra>", marker,
            }
          : {
              type: block.plot_kind === "bar" ? "bar" : "scatter", x: axisLabels, y: values, customdata: hover,
              mode: block.plot_kind === "line" ? "lines+markers" : block.plot_kind === "scatter" ? "markers" : undefined,
              text: block.plot_kind === "bar" ? valueLabels : undefined,
              textposition: block.plot_kind === "bar" ? "outside" : undefined,
              cliponaxis: false,
              hovertemplate: "<b>%{x}</b><br>%{y}<br>%{customdata}<extra></extra>", marker,
              line: { color: "#217cff", width: 3, shape: "spline" },
            };
      const valueAxis = {
        title: [block.y_label, block.unit].filter(Boolean).join(" · ") || undefined,
        gridcolor: "rgba(255,255,255,.08)", zerolinecolor: "rgba(255,255,255,.16)",
        automargin: true, fixedrange: true, tickfont: { color: "rgba(255,255,255,.62)", size: 12 },
      };
      const categoryAxis = {
        automargin: true, fixedrange: true, tickfont: { color: "rgba(255,255,255,.78)", size: 12 },
      };
      await Plotly.newPlot(element, [trace], {
        autosize: true,
        height: block.plot_kind === "pie" ? 360 : horizontal ? Math.min(470, Math.max(290, 150 + block.points.length * 52)) : 350,
        margin: block.plot_kind === "pie" ? { l: 24, r: 24, t: 24, b: 24 }
          : horizontal ? { l: 24, r: 72, t: 18, b: 46 } : { l: 58, r: 30, t: 28, b: 64 },
        paper_bgcolor: "transparent", plot_bgcolor: "transparent",
        font: { family: "Inter, system-ui, sans-serif", color: "rgba(255,255,255,.72)" },
        xaxis: horizontal ? valueAxis : categoryAxis,
        yaxis: horizontal ? { ...categoryAxis, autorange: "reversed" } : valueAxis,
        bargap: 0.42,
        hoverlabel: { bgcolor: "#0b0d12", bordercolor: "rgba(33,124,255,.6)", font: { color: "#fff", size: 12 } },
        showlegend: false,
      }, { responsive: true, displaylogo: false, displayModeBar: false, editable: false, scrollZoom: false });
      resize = new ResizeObserver(() => Plotly.Plots.resize(element));
      resize.observe(element);
    }).catch(() => setFailed(true));
    return () => {
      disposed = true;
      resize?.disconnect();
      void import("plotly.js-basic-dist-min").then(({ default: Plotly }) => Plotly.purge(element)).catch(() => undefined);
    };
  }, [block]);

  return (
    <section className="rp-block rp-plot-block">
      <header className="rp-plot-head">
        <div>
          <span className="rp-plot-eyebrow"><span aria-hidden="true" />Verified source data</span>
          <h3 className="rp-h">{title}</h3>
          <p>{block.points.length} verified data points{block.y_label ? ` · ${block.y_label}` : ""}</p>
        </div>
        <span className="rp-plot-kind">{chartLabel}</span>
      </header>
      {!failed && <div ref={ref} className="rp-plot" role="img" aria-label={title} />}
      {failed && <p className="muted small">The interactive plot could not be loaded. The verified data is listed below.</p>}
      <details className="rp-plot-data" open={failed}>
        <summary><span>View source values</span><span className="rp-plot-data-chevron" aria-hidden="true">⌄</span></summary>
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead><tr><th>{block.x_label || "Label"}</th><th>{block.y_label || "Value"}{block.unit ? ` (${block.unit})` : ""}</th></tr></thead>
            <tbody>{block.points.map((p, i) => <tr key={`${p.label}-${i}`}><td>{p.label}</td><td>{p.display_value || p.value}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
