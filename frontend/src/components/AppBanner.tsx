import { useEffect, useState } from "react";
import { STORE_LINKS, STORE_LIVE, detectDevice, type Device, type Store } from "../lib/appStore";

const LABEL: Record<Store, string> = {
  ios: "App Store",
  android: "Google Play",
};

function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M16.37 12.62c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-3-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.89 1.15 9.14.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.76-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.4-.92-2.42-3.66zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.67-1.09 1.76-.96 2.79 1.02.08 2.05-.52 2.68-1.27z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#00d7fe" d="M3.6 2.2c-.23.25-.36.63-.36 1.12v17.36c0 .49.13.87.36 1.12l.06.06L13.4 12.1v-.2L3.66 2.14z" />
      <path fill="#ffce00" d="M16.64 15.36 13.4 12.1v-.2l3.24-3.26.07.04 3.84 2.19c1.1.62 1.1 1.64 0 2.27l-3.84 2.18z" />
      <path fill="#ff3a44" d="M16.71 15.32 13.4 12 3.6 21.8c.36.38.96.43 1.63.05l11.48-6.53" />
      <path fill="#00f076" d="M16.71 8.68 5.23 2.15c-.67-.38-1.27-.33-1.63.05L13.4 12z" />
    </svg>
  );
}

/** White bar above the landing nav: both stores on a computer, the device's own store on a phone or tablet. */
export default function AppBanner() {
  const [device, setDevice] = useState<Device | null>(null);

  // Detected after mount (the browser's user agent); closing it hides it until the next page load.
  useEffect(() => setDevice(detectDevice()), []);

  if (!device) return null;

  // Only stores where the app is live: an iPhone sees nothing until the App Store listing is up.
  const stores = (device === "desktop" ? (["ios", "android"] as Store[]) : [device]).filter((s) => STORE_LIVE[s]);
  if (stores.length === 0) return null;

  return (
    <div className="app-banner" role="region" aria-label="Get the Notestack app">
      <div className="container app-banner-inner">
        <p className="app-banner-text">
          Get the Notestack mobile {stores.length > 1 ? "apps" : "app"} now, available on
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
