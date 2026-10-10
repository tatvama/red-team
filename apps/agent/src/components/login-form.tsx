"use client";

import { CircleAlert, KeyRound } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { ApiError, errorMessage, login } from "@/lib/client/api";
import { navigateTo } from "@/lib/client/navigation";
import { Wordmark } from "./brand";

/** A message for a failed sign-in. 401 and 429 have fixed wording; anything else uses the server's message. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "That token is not correct.";
    if (error.status === 429) return "Too many attempts. Wait a few minutes.";
  }
  return errorMessage(error, "Sign-in failed. Please try again.");
}

export function LoginForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || pending) return;
    setPending(true);
    setError(null);
    try {
      await login(token);
      // A full load, so every request from here on carries the new session cookie.
      navigateTo("/");
    } catch (caught) {
      setError(loginErrorMessage(caught));
      setPending(false);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        <Wordmark />
        <h1 className="login-card__title">Sign in to Tatvam</h1>
        <p className="login-card__intro">This server is reached over the network. Enter its access token to continue.</p>
        <form className="login-card__form" onSubmit={(event) => void onSubmit(event)} noValidate>
          <label className="field-label" htmlFor={`${baseId}-token`}>
            Access token
          </label>
          <div className="login-card__field">
            <KeyRound size={16} aria-hidden="true" className="login-card__field-icon" />
            <input
              ref={inputRef}
              id={`${baseId}-token`}
              className="field login-card__input"
              type="password"
              name="token"
              autoComplete="current-password"
              spellCheck={false}
              required
              maxLength={500}
              autoFocus
              value={token}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${baseId}-error` : undefined}
              onChange={(event) => {
                setToken(event.target.value);
                if (error) setError(null);
              }}
            />
          </div>
          {error && (
            <p id={`${baseId}-error`} className="login-card__error" role="alert">
              <CircleAlert size={15} aria-hidden="true" />
              <span>{error}</span>
            </p>
          )}
          <button type="submit" className="button button--primary login-card__submit" disabled={pending || !token}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
