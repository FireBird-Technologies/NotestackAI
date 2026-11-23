import { authApi, type LoginResult } from "@notestack/shared/auth";
import { ApiError } from "@notestack/shared/client";
import { useState } from "react";

import { useAuth } from "@/account/auth";
import { Body, Button, ErrorText, Field, FormScreen, Notice, Title } from "@/ui";
import i18n from "@/i18n";

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
      setError(e instanceof ApiError ? e.message : i18n.t("common.somethingWrong"));
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
        <Title>{i18n.t("auth.choosePassword")}</Title>
        <Notice>{notice}</Notice>
        <Field
          label={i18n.t("auth.code")}
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          editable={!codeDead}
        />
        <Field
          label={i18n.t("auth.newPasswordMin", { min: MIN_PASSWORD })}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="new-password"
          textContentType="newPassword"
        />
        <ErrorText>{error}</ErrorText>
        {codeDead ? (
          <Button title={i18n.t("auth.resendCode")} onPress={() => send(i18n.t("auth.newCodeSent"))} busy={busy} />
        ) : (
          <Button
            title={i18n.t("auth.saveAndSignIn")}
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
      <Title>{i18n.t("auth.resetTitle")}</Title>
      <Body muted>{i18n.t("auth.resetBody")}</Body>
      <Field
        label={i18n.t("auth.email")}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <ErrorText>{error}</ErrorText>
      <Button
        title={i18n.t("auth.sendReset")}
        onPress={() => send(i18n.t("auth.resetSent", { email: email.trim() }))}
        busy={busy}
        disabled={!email.trim()}
      />
    </FormScreen>
  );
}
