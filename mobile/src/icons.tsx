import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Svg, { Circle, Path, Rect, Text as SvgText } from "react-native-svg";

import { colors } from "@/theme";

/* The web's line icons (frontend/src/components/icons/Icons.tsx and SlideDeck.tsx), drawn with the same paths. */

type P = { size?: number; color?: string };

type Line = { strokeWidth?: number; strokeLinecap?: "round" | "square"; strokeLinejoin?: "round" | "miter"; style?: StyleProp<ViewStyle> };

function Icon({ size = 20, color = colors.text, strokeWidth = 1.5, strokeLinecap = "round", strokeLinejoin = "round", style, children }: P & Line & { children: ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap={strokeLinecap} strokeLinejoin={strokeLinejoin} style={style}>
      {children}
    </Svg>
  );
}

export const PencilIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />
  </Icon>
);

export const PlayIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M7.5 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L8.7 4.5a.8.8 0 0 0-1.2.7z" />
  </Icon>
);

export const ExpandIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </Icon>
);

export const CollapseIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  </Icon>
);

export const DownloadIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </Icon>
);

export const MoreIcon = ({ color = colors.text, ...p }: P) => (
  <Icon color={color} {...p}>
    <Circle cx="12" cy="5.5" r="1.1" fill={color} />
    <Circle cx="12" cy="12" r="1.1" fill={color} />
    <Circle cx="12" cy="18.5" r="1.1" fill={color} />
  </Icon>
);

export const PdfIcon = ({ color = colors.text, ...p }: P) => (
  <Icon color={color} {...p}>
    <Rect x="3" y="4" width="18" height="16" rx="2.5" />
    <SvgText x="12" y="15" textAnchor="middle" fontSize="6.4" fontWeight="700" fill={color} stroke="none">
      PDF
    </SvgText>
  </Icon>
);

export const PptxIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="3" y="4" width="18" height="16" rx="2.5" />
    <Path d="M10 16V8h2.8a2.3 2.3 0 0 1 0 4.6H10" />
  </Icon>
);

export const DesktopIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="2.5" y="4" width="19" height="12.5" rx="2" />
    <Path d="M12 16.5V20M8 20h8" />
  </Icon>
);

export const ShareIcon = (p: P) => (
  <Icon {...p}>
    <Circle cx="18" cy="5" r="2.5" />
    <Circle cx="6" cy="12" r="2.5" />
    <Circle cx="18" cy="19" r="2.5" />
    <Path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" />
  </Icon>
);

export const TrashIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
  </Icon>
);

export const ArrowUpIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
);

export const ArrowDownIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
);

export const DuplicateIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="8" y="8" width="12" height="12" rx="2" />
    <Path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Icon>
);

export const EyeIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <Circle cx="12" cy="12" r="3" />
  </Icon>
);

export const RocketIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M12 2c3 2.5 4.5 6 4.5 10L14 16h-4l-2.5-4C7.5 8 9 4.5 12 2z" />
    <Circle cx="12" cy="9" r="1.6" />
    <Path d="M7.5 12L5 15l3 1M16.5 12l2.5 3-3 1" />
    <Path d="M10.5 19l1.5 3 1.5-3" />
  </Icon>
);

export const RetryIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M20 12a8 8 0 1 1-2.35-5.65" />
    <Path d="M20 4v4.5h-4.5" />
  </Icon>
);

export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const ChevronIcon = (p: P) => (
  <Icon strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" {...p}>
    <Path d="M6 9l6 6 6-6" />
  </Icon>
);

export const ChevronLeftIcon = (p: P) => (
  <Icon strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" {...p}>
    <Path d="M15 6l-6 6 6 6" />
  </Icon>
);

export const ChevronRightIcon = (p: P) => (
  <Icon strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" {...p}>
    <Path d="M9 6l6 6-6 6" />
  </Icon>
);

export const ImageIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="3" y="4" width="18" height="16" rx="2.5" />
    <Circle cx="9" cy="9.5" r="1.8" />
    <Path d="M3.5 17.5l5-5 4 4 3-3 5 5" />
  </Icon>
);

export const MarkdownIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <Path d="M6 15V9l2.5 3L11 9v6M16 9v6M13.8 12.8L16 15l2.2-2.2" />
  </Icon>
);

export const LandscapeIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="3" y="6" width="18" height="12" rx="2" />
  </Icon>
);

export const PortraitIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="6" y="3" width="12" height="18" rx="2" />
  </Icon>
);

export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

/** Thumbs up, or down (web: AnswerFeedback Thumb). */
export const ThumbIcon = ({ down, ...p }: P & { down?: boolean }) => (
  <Icon strokeWidth={1.7} style={down ? { transform: [{ rotate: "180deg" }] } : undefined} {...p}>
    <Path d="M7 11v9H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3Zm0 0 4-8a2 2 0 0 1 2 2v4h5.2a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 17.2 20H7" />
  </Icon>
);

export const ArrowLeftIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M19 12H5M11 6l-6 6 6 6" />
  </Icon>
);

export const SparkleIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M12 3l1.8 7.2L21 12l-7.2 1.8L12 21l-1.8-7.2L3 12l7.2-1.8z" />
  </Icon>
);

export const UploadIcon = (p: P) => (
  <Icon {...p}>
    <Path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
  </Icon>
);

export const FilmIcon = (p: P) => (
  <Icon {...p}>
    <Rect x="3" y="5" width="18" height="14" rx="2" />
    <Path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
  </Icon>
);

/** Portrait (9:16) video format (web: video/parts PhoneIcon). */
export const PhoneIcon = (p: P) => (
  <Icon strokeWidth={1.7} {...p}>
    <Rect x="7" y="2.5" width="10" height="19" rx="2" />
    <Path d="M11 18.5h2" />
  </Icon>
);

/** Landscape (16:9) video format (web: video/parts ScreenIcon). */
export const ScreenIcon = (p: P) => (
  <Icon strokeWidth={1.7} {...p}>
    <Rect x="2.5" y="4" width="19" height="12.5" rx="1.5" />
    <Path d="M8.5 20.5h7M12 16.5v4" />
  </Icon>
);

/** Three lines: a list to pick from (web: SceneMedia ListIcon). */
export const ListIcon = (p: P) => (
  <Icon strokeWidth={1.6} {...p}>
    <Path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
