import { useEffect } from "react";
import { Link, useSearch } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Logo, LogoMark } from "@/components/Logo";
import { safeNext, useAuth } from "@/lib/auth";

const ERROR_COPY: Record<string, string> = {
  oauth_failed: "Sign-in failed, please try again.",
  oauth_unconfigured: "Google OAuth is not configured on this deployment.",
  oauth_state_mismatch: "Your sign-in session expired. Please try again.",
  oauth_token_exchange: "Sign-in failed while exchanging the authorization code. Please try again.",
  oauth_userinfo: "Sign-in failed while reading your Google profile. Please try again.",
};

/** 单色 Google G（PRD §3.1：全站唯一允许的彩色是 destructive 与成功态绿）。 */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

export default function LoginPage() {
  const auth = useAuth();
  const { next: rawNext, error: errorCode } = useSearch({ from: "/login" });
  const next = safeNext(rawNext);

  const authed = auth.status === "authed";
  useEffect(() => {
    // 已登录直接落到 next（PRD §4.2）。next 是运行时字符串，而 TanStack 的 `to`
    // 是路由字面量联合类型；这里走整页跳转，既免去类型断言，也和 OAuth 本就
    // 经历的整页跳转保持一致。
    if (authed) window.location.replace(next);
  }, [authed, next]);

  if (authed) return null;

  const loading = auth.status === "loading";
  const mode = auth.status === "anon" ? auth.mode : null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="h-14 px-6">
        <div className="flex h-full items-center">
          <Link to="/" aria-label="zkEmail Connect — home">
            <Logo />
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-6 pt-12 md:pt-24">
        <Card className="w-full max-w-sm">
          <CardContent className="space-y-6 pt-6">
            <div className="flex flex-col items-center text-center">
              <LogoMark size="lg" />
              <h1 className="mt-4 text-2xl font-semibold tracking-tight">Welcome to zkEmail Connect</h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Sign in to send tokens to any email address.
              </p>
            </div>

            {errorCode && (
              <Alert variant="destructive">
                <AlertDescription>{ERROR_COPY[errorCode] ?? ERROR_COPY.oauth_failed}</AlertDescription>
              </Alert>
            )}

            {mode === "unconfigured" && (
              <Alert variant="destructive">
                <AlertDescription>{ERROR_COPY.oauth_unconfigured}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-3">
              {mode === "dev-bypass" ? (
                <>
                  <Button className="h-11 w-full" onClick={() => window.location.assign(next)}>
                    Dev sign-in (auth bypass)
                  </Button>
                  <p className="text-center text-xs text-muted-foreground">
                    AUTH_DEV_BYPASS is on — no Google account needed.
                  </p>
                </>
              ) : (
                <Button className="h-11 w-full" asChild disabled={loading || mode === "unconfigured"}>
                  <a href={`/api/auth/google/start?next=${encodeURIComponent(next)}`}>
                    {loading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <GoogleIcon className="mr-2 h-4 w-4" />
                    )}
                    Sign in with Google
                  </a>
                </Button>
              )}
            </div>

            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              By continuing you agree to our Terms of Service and Privacy Policy.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
