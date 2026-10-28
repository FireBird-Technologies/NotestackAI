import type { VideoScene } from "@notestack/shared/types";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { TrashIcon } from "@/ui/icons";
import { colors, fonts, radius } from "@/ui/theme";

import { DeleteAssetModal, RemoveMediaModal } from "./scene-media";
import type { PanelProps } from "./types";
import { GroupHead, inFives, MediaThumb, NumBadge, vstyles } from "./ui";

type Media = { key: string; filename: string; kind: string; url: string; assetId: number | null };

/** One image or clip, as a small 16:9 tile: clips get a CLIP badge and play when tapped (web: MediaTile). */
function MediaTile({ m, children }: { m: Media; children?: React.ReactNode }) {
  return (
    <View style={styles.tile}>
      <View style={styles.thumb}>
        <MediaThumb uri={m.url} kind={m.kind} />
        {m.kind === "video" ? <Text style={styles.badge}>CLIP</Text> : null}
        {children}
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {m.filename}
      </Text>
    </View>
  );
}

/**
 * Images and stock footage, as blog2video's editor (web: ImagesPanel): what each scene shows, grouped by five, and
 * what no scene uses yet. Take one off a scene, or delete an unused one for good.
 */
export function ImagesPanel(p: PanelProps) {
  const scenes = [...p.project.scenes].sort((a, b) => a.order - b.order);
  const assets = (p.project.assets ?? []).filter((a) => (a.asset_type === "image" || a.asset_type === "video") && !a.excluded && a.r2_url);
  const used = new Set(scenes.flatMap((s) => (s.images ?? []).map((i) => i.filename)));
  const unassigned: Media[] = assets.filter((a) => !used.has(a.filename)).map((a) => ({ key: `a${a.id}`, filename: a.filename, kind: a.asset_type, url: a.r2_url!, assetId: a.id }));
  const images = assets.filter((a) => a.asset_type === "image").length;
  const clips = assets.length - images;
  const [openGroup, setOpenGroup] = useState<number | null>(0);
  const [removing, setRemoving] = useState<{ scene: VideoScene; filename: string; kind: string } | null>(null);
  const [deleting, setDeleting] = useState<Media | null>(null);

  return (
    <View style={vstyles.stack}>
      <View style={styles.head}>
        <Text style={vstyles.h3}>Images and stock footage</Text>
        <Text style={[vstyles.muted, vstyles.small]}>
          {images} image{images === 1 ? "" : "s"} · {clips} stock clip{clips === 1 ? "" : "s"}
        </Text>
      </View>
      {inFives(scenes).map((group, g) => {
        const first = g * 5 + 1;
        const open = openGroup === g;
        return (
          <View key={g} style={styles.group}>
            <GroupHead label={`Scenes ${first}–${first + group.length - 1}`} open={open} onPress={() => setOpenGroup(open ? null : g)} />
            {open
              ? group.map((s) => (
                  <View key={s.id} style={styles.scene}>
                    <View style={vstyles.row}>
                      <NumBadge n={s.order} />
                      <Text style={[vstyles.strong, styles.grow]} numberOfLines={2}>
                        {s.title || `Scene ${s.order}`}
                      </Text>
                    </View>
                    <View style={styles.grid}>
                      {(s.images ?? []).map((i) => (
                        <MediaTile key={i.filename} m={{ key: i.filename, filename: i.filename, kind: i.kind, url: i.url, assetId: i.asset_id }}>
                          <Pressable
                            onPress={() => setRemoving({ scene: s, filename: i.filename, kind: i.kind })}
                            disabled={p.disabled}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove from scene ${s.order}`}
                            style={styles.x}>
                            <Text style={styles.xText}>✕</Text>
                          </Pressable>
                        </MediaTile>
                      ))}
                      {(s.images ?? []).length === 0 ? <Text style={[vstyles.muted, vstyles.small]}>No media</Text> : null}
                    </View>
                  </View>
                ))
              : null}
          </View>
        );
      })}

      <View style={[styles.head, styles.unassignedHead]}>
        <Text style={vstyles.h3}>Unassigned</Text>
        <Text style={[vstyles.muted, vstyles.small]}>not used in any scene</Text>
      </View>
      {unassigned.length === 0 ? (
        <Text style={[vstyles.muted, vstyles.small]}>Every image and clip is on a scene.</Text>
      ) : (
        <View style={styles.grid}>
          {unassigned.map((m) => (
            <MediaTile key={m.key} m={m}>
              {m.assetId !== null ? (
                <Pressable onPress={() => setDeleting(m)} disabled={p.disabled} accessibilityRole="button" accessibilityLabel="Delete permanently" style={styles.x}>
                  <TrashIcon size={13} color={colors.white} />
                </Pressable>
              ) : null}
            </MediaTile>
          ))}
        </View>
      )}

      {removing ? <RemoveMediaModal {...p} scene={removing.scene} filename={removing.filename} kind={removing.kind} onClose={() => setRemoving(null)} /> : null}
      {deleting && deleting.assetId !== null ? <DeleteAssetModal {...p} asset={{ id: deleting.assetId, kind: deleting.kind }} onClose={() => setDeleting(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 3 },
  unassignedHead: { marginTop: 10 },
  group: { gap: 8 },
  grow: { flex: 1 },
  scene: { gap: 8, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { width: "48%", gap: 4 },
  thumb: { width: "100%", aspectRatio: 16 / 9, borderRadius: radius.sm, overflow: "hidden", backgroundColor: "#111" },
  badge: { position: "absolute", left: 6, bottom: 6, paddingHorizontal: 5, borderRadius: 4, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.7)", color: colors.white, fontFamily: fonts.mono, fontSize: 10.5 },
  name: { color: colors.text3, fontFamily: fonts.mono, fontSize: 11 },
  x: { position: "absolute", right: 5, top: 5, width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.7)" },
  xText: { color: colors.white, fontSize: 12 },
});
