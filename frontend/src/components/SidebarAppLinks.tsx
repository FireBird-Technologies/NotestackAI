import { useEffect, useState } from "react";
import { STORE_LINKS, availableStores, detectDevice, type Device, type Store } from "../lib/appStore";
import { AppleIcon, PlayIcon } from "./icons/StoreIcons";

const LABEL: Record<Store, string> = {
  ios: "App Store",
  android: "Google Play",
};

/** A quiet line above the account in the sidebar: same stores as the landing banner, icons only. */
export default function SidebarAppLinks() {
  const [device, setDevice] = useState<Device | null>(null);
  useEffect(() => setDevice(detectDevice()), []);

  if (!device) return null;
  const stores = availableStores(device);
  if (stores.length === 0) return null;

  return (
    <div className="side-apps side-label">
      <span>Get the mobile {stores.length > 1 ? "apps" : "app"} on</span>
      {stores.map((store) => (
        <a
          key={store}
          href={STORE_LINKS[store]}
          target="_blank"
          rel="noreferrer"
          aria-label={`Get Notestack on ${LABEL[store]}`}
          title={LABEL[store]}
        >
          {store === "ios" ? <AppleIcon size={20} /> : <PlayIcon size={20} />}
        </a>
      ))}
    </div>
  );
}
