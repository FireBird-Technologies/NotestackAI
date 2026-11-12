export type Store = "ios" | "android";
export type Device = Store | "desktop";

export const STORE_LINKS: Record<Store, string> = {
  ios: "https://apps.apple.com/app/id6830481579",
  android: "https://play.google.com/store/apps/details?id=ai.notestack.app",
};

/** Stores the app can be downloaded from. Set ios to true once the App Store listing is live. */
export const STORE_LIVE: Record<Store, boolean> = {
  ios: false,
  android: true,
};

/** Phones and tablets get their own store; computers (Mac, Windows, Linux, ChromeOS) get "desktop". */
export function detectDevice(): Device {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  // iPadOS reports itself as a Mac; a touch screen tells it apart.
  if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}
