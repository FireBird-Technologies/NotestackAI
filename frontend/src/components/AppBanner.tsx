import { useEffect, useState } from "react";
import { STORE_LINKS, availableStores, detectDevice, type Device, type Store } from "../lib/appStore";
import { AppleIcon, PlayIcon } from "./icons/StoreIcons";

const LABEL: Record<Store, string> = {
  ios: "App Store",
  android: "Google Play",
};

/** White bar above the landing nav: both stores on a computer, the device's own store on a phone or tablet. */
export default function AppBanner() {
  const [device, setDevice] = useState<Device | null>(null);

  // Detected after mount (the browser's user agent); closing it hides it until the next page load.
  useEffect(() => setDevice(detectDevice()), []);

  if (!device) return null;

  // Only stores where the app is live: an iPhone sees nothing until the App Store listing is up.
  const stores = availableStores(device);
  if (stores.length === 0) return null;

  return (
    <div className="app-banner" role="region" aria-label="Get the Notestack app">
      <div className="container app-banner-inner">
        <p className="app-banner-text">
          <span className="app-banner-text-long">
            Get the Notestack mobile {stores.length > 1 ? "apps" : "app"} now, available on
          </span>
          {/* Phones: short enough to share one line with the store button */}
          <span className="app-banner-text-short">Get the Notestack App available on</span>
        </p>
        <div className="app-banner-stores">
          {stores.map((store) => (
            <a
              key={store}
              className="app-banner-store"
              href={STORE_LINKS[store]}
              target="_blank"
              rel="noreferrer"
              aria-label={`Get Notestack on ${LABEL[store]}`}
            >
              {store === "ios" ? <AppleIcon /> : <PlayIcon />}
              <span>{LABEL[store]}</span>
            </a>
          ))}
        </div>
        <button type="button" className="app-banner-close" onClick={() => setDevice(null)} aria-label="Dismiss app banner" title="Dismiss">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
