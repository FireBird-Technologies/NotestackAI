import { authApi, type LoginResult } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import { useState } from "react";

import { useAuth } from "@/account/auth";
import { Body, Button, ErrorText, Field, FormScreen, Notice, Title } from "@/ui";

const MIN_PASSWORD = 8;

/** Reset a password: email, then the code from the email and a new password. Signs in when done. */
export default function Forgot() {
  const { complete } = useAuth();
  const [step, setStep] = useState<"email" | "reset">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
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
      if (e instanceof ApiError && (e.code === "too_many_attempts" || e.code === "expired")) {
        setCode("");
        setCodeDead(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const send = (message: string) =>
    run(async () => {
      await authApi.forgotStart(email.trim());
      setStep("reset");
      setCodeDead(false);
      setNotice(message);
    });

  if (step === "reset") {
    return (
      <FormScreen>
        <Title>Choose a new password</Title>
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
        <Field
          label={`New password (at least ${MIN_PASSWORD} characters)`}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
        />
        <ErrorText>{error}</ErrorText>
        {codeDead ? (
          <Button title="Resend code" onPress={() => send("New code sent.")} busy={busy} />
        ) : (
          <Button
            title="Save and sign in"
            onPress={() => run(() => authApi.forgotComplete(email.trim(), code, password))}
            busy={busy}
            disabled={code.length !== 6 || password.length < MIN_PASSWORD}
          />
        )}
      </FormScreen>
    );
  }

  return (
    <FormScreen>
      <Title>Reset your password</Title>
      <Body muted>We will email you a code to set a new one.</Body>
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Send reset code"
        onPress={() => send(`We sent a reset code to ${email.trim()}.`)}
        busy={busy}
        disabled={!email.trim()}
      />
    </FormScreen>
  );
}
