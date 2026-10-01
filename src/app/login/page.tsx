import Link from "next/link";
import { loginAction } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 px-4">
      <div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-muted">to manage your Discord server&apos;s bot.</p>
      </div>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <form action={loginAction} className="card flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="input"
          />
        </label>
        <SubmitButton pendingText="Signing in…">Sign in</SubmitButton>
      </form>
      <p className="text-sm text-muted">
        Need an account? <Link href="/signup" className="link">Sign up</Link>
      </p>
    </main>
  );
}
