import Link from "next/link";
import { signupAction } from "@/app/actions/auth";
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
        <p className="text-sm text-black/60 dark:text-white/60">
          Self-serve signup is turned off. Ask the admin for an account, or set ALLOW_SIGNUP=true.
        </p>
        <Link href="/login" className="text-sm underline">
          Back to sign in
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Create an account</h1>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      <form action={signupAction} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
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
            className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
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
            className="rounded-md border border-black/10 px-3 py-2 dark:border-white/20"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background"
        >
          Sign up
        </button>
      </form>
      <p className="text-sm text-black/60 dark:text-white/60">
        Already have an account? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}
