import { authApi } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import { router } from "expo-router";
import { useState } from "react";

import { useAuth } from "@/auth";
import { Body, Button, ErrorText, Field, FormScreen, Title } from "@/ui";

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
      <Title>Welcome back</Title>
      <Body muted>Sign in to your Notestack account.</Body>
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
      <Button title="New here? Create an account" variant="link" onPress={() => router.push("/sign-up")} />
    </FormScreen>
  );
}
