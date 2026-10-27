import { authApi, type LoginResult } from "@notestack/shared/auth";
import { GoogleSignin, isErrorWithCode, statusCodes } from "@react-native-google-signin/google-signin";
import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";

/**
 * Native Google and Apple sign in. Each shows the system sheet, sends the identity token it returns to the API, and
 * resolves to the login (for useAuth().complete) or to null when the person closed the sheet. A refusal from the API
 * (for example "This email uses a password…") comes back as its ApiError.
 */

// Google's ID token is minted for the web client, so the API checks it the same way as the web's.
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
// iOS also needs its own client (and its reversed id as a URL scheme, added by the plugin in app.config.ts).
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;

/** Whether this build was given the Google client ids it needs. */
export const googleReady = Boolean(GOOGLE_WEB_CLIENT_ID && (Platform.OS !== "ios" || GOOGLE_IOS_CLIENT_ID));

let configured = false;

function configureGoogle() {
  if (configured) return;
  GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID });
  configured = true;
}

export class SocialSignInError extends Error {}

export async function signInWithGoogle(): Promise<LoginResult | null> {
  configureGoogle();
  try {
    if (Platform.OS === "android") await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const res = await GoogleSignin.signIn();
    if (res.type === "cancelled") return null;
    if (!res.data.idToken) throw new SocialSignInError("Google did not return a sign in token. Try again.");
    return await authApi.google(res.data.idToken);
  } catch (e) {
    if (!isErrorWithCode(e)) throw e;
    if (e.code === statusCodes.SIGN_IN_CANCELLED || e.code === statusCodes.IN_PROGRESS) return null;
    if (e.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
      throw new SocialSignInError("Google Play services is needed to sign in with Google.");
    }
    // Dev builds show Google's own reason, which is what a setup mistake needs.
    if (__DEV__) console.warn("Google sign in failed", e.code, e.message);
    throw new SocialSignInError(
      __DEV__ ? `Google sign in failed (${e.code}): ${e.message}` : "Could not sign in with Google. Try again.",
    );
  }
}

/** Sign in with Apple exists on iOS 13 and later; false everywhere else. */
export function appleAvailable(): Promise<boolean> {
  return Platform.OS === "ios" ? AppleAuthentication.isAvailableAsync() : Promise.resolve(false);
}

export async function signInWithApple(): Promise<LoginResult | null> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_REQUEST_CANCELED") return null;
    throw new SocialSignInError("Could not sign in with Apple. Try again.");
  }
  if (!credential.identityToken) throw new SocialSignInError("Apple did not return a sign in token. Try again.");
  // Apple sends the name only the first time this Apple ID signs in to the app.
  const name = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(" ");
  return authApi.apple({
    identity_token: credential.identityToken,
    authorization_code: credential.authorizationCode,
    name: name || null,
  });
}

/** Forget the Google account on sign out, so the next Google sign in can pick another one. */
export function signOutOfGoogle() {
  if (!googleReady) return;
  configureGoogle();
  GoogleSignin.signOut().catch(() => undefined);
}
