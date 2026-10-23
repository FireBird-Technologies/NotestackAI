import { Image } from "expo-image";

import { colors } from "@/theme";

/** The web's PlanetIcon (the Notebooks tab icon), tinted. */
export function PlanetIcon({ size = 26, color = colors.blue }: { size?: number; color?: string }) {
  return (
    <Image
      source={require("@/assets/images/tabs/notebooks.png")}
      style={{ width: size, height: size }}
      tintColor={color}
      accessibilityElementsHidden
    />
  );
}
