import { authApi, type LoginResult } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import { router } from "expo-router";
import { useState } from "react";

import { useAuth } from "@/auth";
import { SocialButtons } from "@/social-buttons";
import { Body, Button, ErrorText, Field, FormScreen, Notice, Title } from "@/ui";

const MIN_PASSWORD = 8;

/** Create an account: name, email and password, then the 6 digit code from the email. */
export default function SignUp() {
  const { complete } = useAuth();
  const [step, setStep] = useState<"details" | "verify">("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // The current code is out of tries or expired: the only ways forward are a new code or a new email.
  const [codeDead, setCodeDead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const run = async (fn: () => Promise<LoginResult | void>) => {
    setBusy(true);
    setError("");
    try {
      const result = await fn();
      if (result) complete(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
      if (!(e instanceof ApiError)) return;
      if (e.code === "too_many_attempts" || e.code === "expired") {
        setCode("");
        setCodeDead(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      await authApi.registerStart(email.trim(), password, name.trim() || undefined);
      setStep("verify");
      setNotice(`We sent a 6 digit code to ${email.trim()}.`);
    });

  const resend = () =>
    run(async () => {
      await authApi.registerResend(email.trim());
      setCodeDead(false);
      setNotice("New code sent.");
    });

  if (step === "verify") {
    return (
      <FormScreen>
        <Title>Check your email</Title>
        <Notice>{notice}</Notice>
        <Field
          label="6 digit code"
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          editable={!codeDead}
        />
        <ErrorText>{error}</ErrorText>
        {codeDead ? (
          <Button title="Resend code" onPress={resend} busy={busy} />
        ) : (
          <Button
            title="Verify and continue"
            onPress={() => run(() => authApi.registerVerify(email.trim(), code))}
            busy={busy}
            disabled={code.length !== 6}
          />
        )}
        {!codeDead && <Button title="Resend code" variant="link" onPress={resend} disabled={busy} />}
        <Button
          title="Use a different email"
          variant="link"
          onPress={() => {
            setStep("details");
            setCode("");
            setError("");
            setNotice("");
          }}
        />
      </FormScreen>
    );
  }

  return (
    <FormScreen>
      <Title>Create your account</Title>
      <Body muted>Your archive, ready to ask.</Body>
      <SocialButtons mode="signup" />
      <Field label="Name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <Field
        label={`Password (at least ${MIN_PASSWORD} characters)`}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Send my code"
        onPress={start}
        busy={busy}
        disabled={!email.trim() || password.length < MIN_PASSWORD}
      />
      <Button title="Already have an account? Sign in" variant="link" onPress={() => router.navigate("/sign-in")} />
    </FormScreen>
  );
}
