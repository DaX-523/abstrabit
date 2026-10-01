import Link from "next/link";
import { signupAction } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { getEnv } from "@/lib/env";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const allowSignup = getEnv().ALLOW_SIGNUP;

  if (!allowSignup) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
        <h1 className="text-2xl font-semibold">Signup disabled</h1>
        <p className="text-sm text-muted">
          Self-serve signup is turned off. Ask the admin for an account, or set ALLOW_SIGNUP=true.
        </p>
        <Link href="/login" className="link text-sm">
          Back to sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-5 px-4">
      <div>
        <h1 className="text-2xl font-semibold">Create an account</h1>
        <p className="mt-1 text-sm text-muted">Then connect the bot to your Discord server.</p>
      </div>
      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      <form action={signupAction} className="card flex flex-col gap-4">
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
            minLength={8}
            autoComplete="new-password"
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Confirm password
          <input
            type="password"
            name="confirmPassword"
            required
            minLength={8}
            autoComplete="new-password"
            className="input"
          />
        </label>
        <SubmitButton pendingText="Creating account…">Sign up</SubmitButton>
      </form>
      <p className="text-sm text-muted">
        Already have an account? <Link href="/login" className="link">Sign in</Link>
      </p>
    </main>
  );
}
