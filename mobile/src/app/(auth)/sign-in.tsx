import { authApi } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import { router } from "expo-router";
import { useState } from "react";

import { useAuth } from "@/account/auth";
import { SocialButtons } from "@/account/social-buttons";
import { Brand, Button, ErrorText, Field, FormScreen } from "@/ui";

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
      setError(e instanceof ApiError ? e.message : "Could not reach Notestack. Check your connection.");
      setBusy(false);
    }
  };

  return (
    <FormScreen>
      <Brand />
      <SocialButtons mode="signin" />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        returnKeyType="next"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <ErrorText>{error}</ErrorText>
      <Button title="Sign in" onPress={submit} busy={busy} disabled={!email.trim() || !password} />
      <Button title="Forgot password?" variant="link" onPress={() => router.push("/forgot")} />
      <Button title="New here? Create an account" variant="link" onPress={() => router.navigate("/sign-up")} />
    </FormScreen>
  );
}
