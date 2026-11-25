import { authApi, type GuestResult } from "@notestack/shared/auth";
import { requireOptionalNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * The app without an account, on iOS only. The server ties the free allowance to this iPhone: by a random id kept in
 * the Keychain, which a reinstall normally keeps, and by Apple's DeviceCheck, which survives even erasing the phone.
 */

type DeviceCheckModule = { randomId(): string; generateToken(): Promise<string | null> };
const deviceCheck = Platform.OS === "ios" ? requireOptionalNativeModule<DeviceCheckModule>("DeviceCheck") : null;

/** Whether this build can be used without an account. */
export const guestReady = deviceCheck !== null;

const DEVICE_KEY = "ns_device_id";
/** Set while Apple has not been told about this device yet (it could not be reached): asked again at the next launch. */
const PENDING_KEY = "ns_guest_unverified";
const TOKEN_TIMEOUT_MS = 8000;

async function deviceId(): Promise<string> {
  const kept = await SecureStore.getItemAsync(DEVICE_KEY);
  if (kept) return kept;
  const id = deviceCheck!.randomId();
  // This device only: a backup restored on another iPhone must not bring this one's id along.
  await SecureStore.setItemAsync(DEVICE_KEY, id, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  return id;
}

async function deviceToken(): Promise<string | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TOKEN_TIMEOUT_MS));
  return Promise.race([deviceCheck!.generateToken().catch(() => null), timeout]);
}

/** Opens this iPhone's guest session: the one it had, or a new one. */
export async function openGuest(): Promise<GuestResult> {
  const [id, token] = await Promise.all([deviceId(), deviceToken()]);
  const result = await authApi.guest(id, token);
  if (result.verified) await SecureStore.deleteItemAsync(PENDING_KEY).catch(() => undefined);
  else await SecureStore.setItemAsync(PENDING_KEY, "1").catch(() => undefined);
  return result;
}

/** At launch, for a guest Apple could not vouch for yet. Nothing changes for the person. */
export async function verifyLater(): Promise<void> {
  try {
    if (guestReady && (await SecureStore.getItemAsync(PENDING_KEY))) await openGuest();
  } catch {
    // the next launch tries again
  }
}
