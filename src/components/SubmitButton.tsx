"use client";

import { useFormStatus } from "react-dom";

const VARIANT_CLASS = {
  primary: "btn-primary",
  secondary: "btn-secondary",
} as const;

/**
 * A submit button that disables itself and shows a spinner while its parent
 * <form>'s server action is in flight -- stops double-submits (e.g. two test
 * messages, or two login attempts) and tells the user something is happening.
 */
export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
}: {
  children: React.ReactNode;
  pendingText?: string;
  variant?: keyof typeof VARIANT_CLASS;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={VARIANT_CLASS[variant]}>
      {pending && (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {pending ? (pendingText ?? children) : children}
    </button>
  );
}
