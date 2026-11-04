import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * The space a screen still has to leave at its bottom for the system's bar. On Android the root layout already stands
 * the whole app above the navigation bar (it draws edge to edge), so it is 0 there; on iOS it is the home indicator's.
 */
export function useBottomInset(): number {
  const bottom = useSafeAreaInsets().bottom;
  return Platform.OS === "android" ? 0 : bottom;
}
