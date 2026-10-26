import { displayTitle, shortLabel, visibleValue } from "@notestack/shared/report";
import type { ReportBlock } from "@notestack/shared/types";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";

import { ChevronIcon } from "@/icons";
import { colors, fonts, radius } from "@/theme";

/* A report's plot (web: ReportPlot, drawn there with Plotly), drawn natively from the same verified points: bars
   (sideways when there are few or the labels are long), a line, a scatter or a donut, in the web's blues. A tap on a
   bar, point or slice shows its value and what it is, as the web's hover does. */

type PlotBlock = Extract<ReportBlock, { type: "plot" }>;
type Point = PlotBlock["points"][number];

const BLUE = "#217cff";
/** The web's marker colours: the first full blue, the rest fading. */
const shade = (i: number) => (i === 0 ? BLUE : `rgba(33, 124, 255, ${Math.max(0.42, 0.82 - i * 0.055)})`);
const GRID = "rgba(255, 255, 255, 0.08)";
const ZERO = "rgba(255, 255, 255, 0.16)";
const TICK = "rgba(255, 255, 255, 0.62)";

/** Round steps for an axis from `lo` to `hi`: about five of them. */
function ticks(lo: number, hi: number, count = 5): number[] {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const compact = (v: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, notation: Math.abs(v) >= 10_000 ? "compact" : "standard" }).format(v);

/** What a tapped point says: its label, its value, and its note. */
function Tip({ point }: { point: Point }) {
  const note = point.detail && point.detail !== point.display_value ? point.detail : "";
  return (
    <View style={styles.tip}>
      <Text style={styles.tipLabel}>{point.label}</Text>
      <Text style={styles.tipValue}>{point.display_value || String(point.value)}</Text>
      {note ? <Text style={styles.tipNote}>{note}</Text> : null}
    </View>
  );
}

/** Bars lying down, one row each: its label over it, its value at its end. */
function SidewaysBars({ points, picked, onPick }: { points: Point[]; picked: number | null; onPick: (i: number) => void }) {
  const max = Math.max(...points.map((p) => Math.abs(p.value)), 1);
  return (
    <View style={styles.rows}>
      {points.map((p, i) => (
        <Pressable key={`${p.label}-${i}`} onPress={() => onPick(i)} accessibilityRole="button" accessibilityLabel={`${p.label}: ${visibleValue(p)}`} style={styles.rowItem}>
          <Text style={[styles.rowLabel, picked === i && styles.rowLabelOn]} numberOfLines={2}>
            {p.label}
          </Text>
          <View style={styles.rowBarLine}>
            <View style={[styles.rowBar, { width: `${Math.max(2, (Math.abs(p.value) / max) * 82)}%`, backgroundColor: shade(i) }, picked === i && styles.barOn]} />
            <Text style={styles.rowValue}>{visibleValue(p)}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/** Bars standing up, a line or a scatter, over a value axis with its grid. */
function Axes({ block, width, picked, onPick }: { block: PlotBlock; width: number; picked: number | null; onPick: (i: number) => void }) {
  const pts = block.points;
  const H = 300;
  const m = { l: 46, r: 14, t: 26, b: 64 };
  const w = Math.max(10, width - m.l - m.r);
  const h = H - m.t - m.b;
  const values = pts.map((p) => p.value);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const axis = ticks(lo, hi);
  const y0 = axis[0];
  const y1 = axis[axis.length - 1];
  const y = (v: number) => m.t + h - ((v - y0) / (y1 - y0 || 1)) * h;
  const band = w / pts.length;
  const x = (i: number) => m.l + band * i + band / 2;
  const bar = block.plot_kind === "bar";
  const slant = pts.length > 4;
  const linePath = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");

  // A tap picks the nearest bar or point across the plot.
  const pick = (px: number) => onPick(Math.max(0, Math.min(pts.length - 1, Math.floor((px - m.l) / band))));
  return (
    <Pressable onPress={(e) => pick(e.nativeEvent.locationX)} accessibilityRole="image" accessibilityLabel={displayTitle(block)}>
      <Svg width={width} height={H}>
        {axis.map((v) => (
          <G key={v}>
            <Line x1={m.l} x2={m.l + w} y1={y(v)} y2={y(v)} stroke={v === 0 ? ZERO : GRID} strokeWidth={1} />
            <SvgText x={m.l - 6} y={y(v) + 4} fill={TICK} fontSize={11} textAnchor="end">
              {compact(v)}
            </SvgText>
          </G>
        ))}
        {bar
          ? pts.map((p, i) => {
              const top = y(Math.max(0, p.value));
              const bottom = y(Math.min(0, p.value));
              const bw = band * 0.58;
              return (
                <G key={i}>
                  <Rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, bottom - top)} rx={3} fill={shade(i)} stroke={picked === i ? colors.white : "rgba(255,255,255,.15)"} strokeWidth={picked === i ? 1.5 : 1} />
                  <SvgText x={x(i)} y={top - 6} fill={colors.text} fontSize={11} textAnchor="middle">
                    {visibleValue(p)}
                  </SvgText>
                </G>
              );
            })
          : null}
        {block.plot_kind === "line" ? <Path d={linePath} stroke={BLUE} strokeWidth={3} fill="none" strokeLinejoin="round" strokeLinecap="round" /> : null}
        {!bar
          ? pts.map((p, i) => <Circle key={i} cx={x(i)} cy={y(p.value)} r={picked === i ? 6 : 4.5} fill={shade(i)} stroke={picked === i ? colors.white : "rgba(255,255,255,.15)"} strokeWidth={1.5} />)
          : null}
        {pts.map((p, i) => {
          const label = shortLabel(p.label, slant ? 16 : Math.max(6, Math.floor(band / 6.5)));
          return slant ? (
            <SvgText key={i} x={x(i)} y={m.t + h + 14} fill="rgba(255,255,255,.78)" fontSize={11} textAnchor="end" transform={`rotate(-40 ${x(i)} ${m.t + h + 14})`}>
              {label}
            </SvgText>
          ) : (
            <SvgText key={i} x={x(i)} y={m.t + h + 18} fill="rgba(255,255,255,.78)" fontSize={11} textAnchor="middle">
              {label}
            </SvgText>
          );
        })}
      </Svg>
    </Pressable>
  );
}

/** A donut, its slices in the web's blues, with a legend of labels and shares under it. */
function Donut({ points, width, picked, onPick }: { points: Point[]; width: number; picked: number | null; onPick: (i: number) => void }) {
  const size = Math.min(width, 260);
  const r = size / 2 - 8;
  const hole = r * 0.58;
  const total = points.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  // Where each slice starts and ends, going round from the top.
  const slices = points.reduce<{ from: number; to: number }[]>((out, p) => {
    const from = out.length ? out[out.length - 1].to : -Math.PI / 2;
    return [...out, { from, to: from + (Math.max(0, p.value) / total) * Math.PI * 2 }];
  }, []);
  const arc = (from: number, to: number) => {
    const big = to - from > Math.PI ? 1 : 0;
    const c = size / 2;
    const p = (ang: number, rad: number) => `${(c + Math.cos(ang) * rad).toFixed(2)} ${(c + Math.sin(ang) * rad).toFixed(2)}`;
    return `M${p(from, r)} A${r} ${r} 0 ${big} 1 ${p(to, r)} L${p(to, hole)} A${hole} ${hole} 0 ${big} 0 ${p(from, hole)} Z`;
  };
  return (
    <View style={styles.donut}>
      <Svg width={size} height={size}>
        {points.map((p, i) => {
          const { from } = slices[i];
          // A slice of the whole circle cannot be drawn as one arc: keep it a hair short.
          const to = slices[i].to - from >= Math.PI * 2 - 0.0001 ? from + Math.PI * 2 - 0.0001 : slices[i].to;
          return <Path key={i} d={arc(from, to)} fill={shade(i)} stroke={picked === i ? colors.white : "rgba(255,255,255,.15)"} strokeWidth={picked === i ? 2 : 1} onPress={() => onPick(i)} />;
        })}
      </Svg>
      <View style={styles.legend}>
        {points.map((p, i) => (
          <Pressable key={`${p.label}-${i}`} onPress={() => onPick(i)} accessibilityRole="button" style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: shade(i) }]} />
            <Text style={[styles.legendText, picked === i && styles.rowLabelOn]} numberOfLines={2}>
              {p.label}
            </Text>
            <Text style={styles.legendPct}>{Math.round((Math.max(0, p.value) / total) * 100)}%</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function ReportPlot({ block }: { block: PlotBlock }) {
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [data, setData] = useState(false);
  const pts = block.points;
  const title = displayTitle(block);
  const chartLabel = block.plot_kind === "pie" ? "Donut chart" : `${block.plot_kind[0].toUpperCase()}${block.plot_kind.slice(1)} chart`;
  const sideways = block.plot_kind === "bar" && (pts.length <= 5 || pts.some((p) => p.label.length > 18));
  const pick = (i: number) => setPicked((cur) => (cur === i ? null : i));
  return (
    <View style={styles.block}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.eyebrow}>● VERIFIED SOURCE DATA</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.meta}>
            {pts.length} verified data points{block.y_label ? ` · ${block.y_label}` : ""}
          </Text>
        </View>
        <Text style={styles.kind}>{chartLabel}</Text>
      </View>
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && pts.length >= 2 ? (
          block.plot_kind === "pie" ? (
            <Donut points={pts} width={width} picked={picked} onPick={pick} />
          ) : sideways ? (
            <SidewaysBars points={pts} picked={picked} onPick={pick} />
          ) : (
            <Axes block={block} width={width} picked={picked} onPick={pick} />
          )
        ) : null}
      </View>
      {block.y_label || block.unit ? <Text style={styles.axisName}>{[block.y_label, block.unit].filter(Boolean).join(" · ")}</Text> : null}
      {picked !== null && pts[picked] ? <Tip point={pts[picked]} /> : null}
      <Pressable onPress={() => setData((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: data }} style={styles.dataToggle}>
        <Text style={styles.dataToggleText}>View source values</Text>
        <View style={data && styles.flip}>
          <ChevronIcon size={14} color={colors.text2} />
        </View>
      </Pressable>
      {data ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.table}>
            <View style={[styles.tr, styles.th]}>
              <Text style={[styles.td, styles.thText]}>{block.x_label || "Label"}</Text>
              <Text style={[styles.td, styles.thText]}>
                {block.y_label || "Value"}
                {block.unit ? ` (${block.unit})` : ""}
              </Text>
            </View>
            {pts.map((p, i) => (
              <View key={`${p.label}-${i}`} style={styles.tr}>
                <Text style={styles.td}>{p.label}</Text>
                <Text style={styles.td}>{p.display_value || String(p.value)}</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(33, 124, 255, 0.25)", backgroundColor: "rgba(33, 124, 255, 0.04)" },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  headText: { flex: 1, gap: 4 },
  eyebrow: { color: colors.blue, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.6 },
  title: { color: colors.text, fontFamily: fonts.displayBold, fontSize: 18, lineHeight: 24 },
  meta: { color: colors.text3, fontSize: 13 },
  kind: { color: colors.text2, fontFamily: fonts.mono, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  rows: { gap: 12 },
  rowItem: { gap: 5 },
  rowLabel: { color: "rgba(255,255,255,.78)", fontSize: 13.5, lineHeight: 18 },
  rowLabelOn: { color: colors.white, fontWeight: "600" },
  rowBarLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBar: { height: 16, borderRadius: 4 },
  barOn: { borderWidth: 1.5, borderColor: colors.white },
  rowValue: { color: colors.text, fontSize: 12.5, fontFamily: fonts.mono },
  donut: { alignItems: "center", gap: 14 },
  legend: { alignSelf: "stretch", gap: 8 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  legendText: { flex: 1, color: "rgba(255,255,255,.78)", fontSize: 13.5 },
  legendPct: { color: colors.text, fontFamily: fonts.mono, fontSize: 12.5 },
  axisName: { color: colors.text3, fontSize: 12 },
  tip: { gap: 3, padding: 12, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: "rgba(33, 124, 255, 0.6)", backgroundColor: "#0b0d12" },
  tipLabel: { color: colors.white, fontWeight: "700", fontSize: 14 },
  tipValue: { color: colors.text, fontFamily: fonts.mono, fontSize: 13 },
  tipNote: { color: colors.text2, fontSize: 13, lineHeight: 18 },
  dataToggle: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.line },
  dataToggleText: { color: colors.text, fontSize: 14, fontWeight: "500" },
  flip: { transform: [{ rotate: "180deg" }] },
  table: { borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  tr: { flexDirection: "row" },
  th: { backgroundColor: colors.surface2 },
  td: { width: 170, padding: 10, color: colors.text, fontSize: 13.5, borderBottomWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  thText: { fontWeight: "700" },
});
