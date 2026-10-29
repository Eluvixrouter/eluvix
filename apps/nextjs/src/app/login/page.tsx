"use client";

import { useState, useEffect, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

interface AuthStatus {
  ldapEnabled: boolean;
  baseDn?: string;
  allowLocalBreakGlass?: boolean;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawCallbackUrl = searchParams.get("callbackUrl") || "/";
  // Avoid redirection loops back to /login or /api/auth
  const callbackUrl = rawCallbackUrl.includes("/login") || rawCallbackUrl.includes("/api/auth")
    ? "/"
    : rawCallbackUrl;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && d?.data) {
          setStatus(d.data);
        }
      })
      .catch(() => {
        // Fallback default
        setStatus({ ldapEnabled: false, allowLocalBreakGlass: true });
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await signIn("credentials", {
        username: username.trim(),
        password,
        redirect: false,
        callbackUrl,
      });

      if (res?.error) {
        setError("Invalid username or password. Please verify your directory credentials.");
        setLoading(false);
      } else {
        router.push(callbackUrl);
        router.refresh();
      }
    } catch (err) {
      console.error("Authentication error:", err);
      setError("An unexpected error occurred during authentication.");
      setLoading(false);
    }
  };

  const isLdap = Boolean(status?.ldapEnabled);

  return (
    <div className="w-full max-w-md p-8 bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl">
      <div className="flex flex-col items-center mb-6">
        <div className="w-12 h-12 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-2xl mb-3 shadow-inner">
          🔒
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">
          Eluv<span className="text-sky-400">ix</span>
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          {isLdap
            ? "Sign in with your Axonwall OpenLDAP credentials"
            : "Enter administrator credentials to access the console"}
        </p>

        {isLdap && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-3 py-1 text-[11px] font-medium text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            Axonwall OpenLDAP Active {status?.baseDn ? `(${status.baseDn})` : ""}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-6 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400 text-center font-medium">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {isLdap && (
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. alice (or leave blank for admin)"
              autoFocus
              className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-semibold text-slate-300 mb-1.5 uppercase tracking-wider">
            {isLdap ? "Password" : "Admin Password"}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            required
            autoFocus={!isLdap}
            className="w-full bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-600 outline-none transition"
          />
          {!isLdap ? (
            <p className="text-[11px] text-slate-500 mt-1.5">
              Configured in <code className="text-sky-400 bg-sky-500/10 px-1 py-0.5 rounded font-mono">~/.config/eluvix/auth.json</code> or <code className="text-sky-400 bg-sky-500/10 px-1 py-0.5 rounded font-mono">ADMIN_PASSWORD</code>
            </p>
          ) : (
            <p className="text-[11px] text-slate-500 mt-1.5">
              Local break-glass login remains available with username <code className="text-sky-400 font-mono">admin</code> and appliance admin password
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={loading || !password}
          className="w-full bg-sky-500 hover:bg-sky-400 disabled:opacity-50 disabled:cursor-not-allowed text-slate-950 font-semibold text-sm py-2.5 rounded-lg shadow-lg shadow-sky-500/20 transition-all flex items-center justify-center gap-2 mt-6"
        >
          {loading ? (
            <span className="inline-block w-4 h-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></span>
          ) : (
            "Authenticate"
          )}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-950 px-4 text-slate-100">
      <Suspense fallback={<div className="text-slate-500 text-sm">Loading...</div>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
