import { authApi } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import { router } from "expo-router";
import { useState } from "react";

import { useAuth } from "@/account/auth";
import { LegalLinks } from "@/account/plans";
import { SocialButtons } from "@/account/social-buttons";
import { Brand, Button, ErrorText, Field, FormScreen } from "@/ui";
import i18n from "@/i18n";

/** The landing page when signed out: the logo and one line, then Google and the email sign in. */
export default function SignIn() {
  const { complete } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      complete(await authApi.login(email.trim(), password));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : i18n.t("common.noConnection"));
      setBusy(false);
    }
  };

  return (
    <FormScreen>
      <Brand />
      <SocialButtons mode="signin" />
      <Field
        label={i18n.t("auth.email")}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="next"
      />
      <Field
        label={i18n.t("auth.password")}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <ErrorText>{error}</ErrorText>
      <Button title={i18n.t("auth.signIn")} onPress={submit} busy={busy} disabled={!email.trim() || !password} />
      <Button title={i18n.t("auth.forgot")} variant="link" onPress={() => router.push("/forgot")} />
      <Button title={i18n.t("auth.newHere")} variant="link" onPress={() => router.navigate("/sign-up")} />
      <LegalLinks />
    </FormScreen>
  );
}
