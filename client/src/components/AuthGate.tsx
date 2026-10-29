import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Network, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/hooks/use-language";
import { queryClient } from "@/lib/queryClient";

interface AuthStatus {
  authRequired: boolean;
  configured: boolean;
  authenticated: boolean;
}

export const AUTH_REQUIRED_EVENT = "auth:required";

// Shows a login screen in front of the app whenever the server says the
// session is missing or expired. Any /api response with 401 (from any fetch
// in the app) sends the user back here.
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status", { credentials: "include" });
      setStatus(await res.json());
    } catch {
      setStatus({ authRequired: true, configured: true, authenticated: false });
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const onAuthRequired = () => loadStatus();
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);

    // Catch 401s from every fetch, including the many direct fetch() calls
    // that bypass apiRequest.
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await originalFetch(...args);
      const url = typeof args[0] === "string" ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url;
      if (res.status === 401 && url.includes("/api/") && !url.includes("/api/auth/")) {
        window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
      }
      return res;
    };
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
      window.fetch = originalFetch;
    };
  }, [loadStatus]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(res.status === 401 ? t("loginWrongPassword") : body.message || res.statusText);
        return;
      }
      setPassword("");
      queryClient.clear();
      await loadStatus();
    } finally {
      setSubmitting(false);
    }
  };

  if (!status) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status.authenticated) return <>{children}</>;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
            <Network className="w-4 h-4 text-primary-foreground" />
          </div>
          <div className="leading-none">
            <span className="text-sm font-bold text-foreground">MapScraper</span>
            <span className="text-[10px] text-muted-foreground block">Pro Edition</span>
          </div>
        </div>

        <h1 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <Lock className="w-4 h-4" /> {t("loginTitle")}
        </h1>

        {!status.configured ? (
          <p className="mt-3 text-sm text-destructive" data-testid="text-login-not-configured">
            {t("loginNotConfigured")}
          </p>
        ) : (
          <form onSubmit={onSubmit} className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">{t("loginDescription")}</p>
            <div className="space-y-2">
              <Label htmlFor="login-password">{t("loginPassword")}</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="input-login-password"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert" data-testid="text-login-error">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting || !password} data-testid="button-login">
              {submitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {t("loginSubmit")}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
