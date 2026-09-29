/**
 * Small helper for racing work against Discord's ~3s interaction response
 * window. We give ourselves a 2.5s internal budget for the route handler's
 * own DB write, leaving headroom for network + JSON serialization before
 * Discord's own timeout fires.
 */

export class DeadlineExceededError extends Error {
  constructor(label: string) {
    super(`Deadline exceeded: ${label}`);
    this.name = "DeadlineExceededError";
  }
}

export async function withDeadline<T>(
  label: string,
  ms: number,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(label)), ms);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Default budget for the interactions route's initial DB write. */
export const INTERACTION_DB_DEADLINE_MS = 2500;
