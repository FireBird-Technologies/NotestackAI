import type { LayoutInfo, LayoutSchema } from "@notestack/shared/endpoints";
import type { VideoJobState, VideoProjectData } from "@notestack/shared/types";

/** What every editor panel gets from the editor screen (web: components/video/EditorPanels.tsx PanelProps). */
export type PanelProps = {
  id: string;
  project: VideoProjectData;
  /** The template's layout_prop_schema (default font sizes per layout); null until loaded or if it failed. */
  layoutSchema: LayoutSchema | null;
  /** The template's display names per layout id; null until loaded or if it failed. */
  layoutNames: Record<string, string> | null;
  /** Every layout of the template with its visual variants (Scene layout / Scene style in the scene editor). */
  layoutInfo: LayoutInfo | null;
  disabled: boolean;
  /** Run a quick change, then reload the project. Resolves true on success, false when it failed. */
  act: (fn: () => Promise<unknown>) => Promise<boolean>;
  /** Start a background job and poll it until it finishes. */
  startJob: (label: string, start: () => Promise<unknown>, poll: () => Promise<VideoJobState | null>) => Promise<void>;
};
