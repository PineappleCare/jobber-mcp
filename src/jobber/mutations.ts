/** Shared guardrails for every fixed Jobber mutation. */

export interface JobberUserError {
  message: string;
  path?: string[] | null;
}

export interface MutationPayload {
  userErrors: JobberUserError[];
  [key: string]: unknown;
}

export function assertMutationAccepted<T extends MutationPayload>(
  action: string,
  payload: T
): T {
  if (payload.userErrors.length) {
    const detail = payload.userErrors
      .map((error) => `${error.path?.length ? `${error.path.join(".")}: ` : ""}${error.message}`)
      .join("; ");
    throw new Error(`Jobber rejected ${action}: ${detail}`);
  }
  return payload;
}

export function assertPresent<T>(action: string, value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error(`Jobber did not return the changed record after ${action}; check Jobber before retrying.`);
  }
  return value;
}

/** Jobber mutations cannot safely be retried by clients: an error can mean the remote write committed. */
export const UNKNOWN_OUTCOME_GUIDANCE =
  "The mutation outcome may be unknown. Use get_record or Jobber before attempting it again.";
