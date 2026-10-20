export class JobberApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobberApiError";
  }
}

export class JobberAuthenticationError extends JobberApiError {
  constructor(message: string) {
    super(message);
    this.name = "JobberAuthenticationError";
  }
}

export class JobberGraphQLRequestError extends JobberApiError {
  constructor(message: string) {
    super(message);
    this.name = "JobberGraphQLRequestError";
  }
}

export class JobberPermissionError extends JobberGraphQLRequestError {
  constructor(originalMessage?: string) {
    super(
      "Jobber denied access to this data. Check the app's OAuth scopes, the authorizing user's permissions, and feature availability. " +
      "A permission denial alone does not establish that a plan upgrade is required." +
      (originalMessage ? ` (Jobber said: ${originalMessage})` : "")
    );
    this.name = "JobberPermissionError";
  }
}

/**
 * A write request failed after it may have reached Jobber. Callers must
 * reconcile through reads and must never retry the mutation automatically.
 */
export class JobberOutcomeUncertainError extends JobberApiError {
  constructor(message: string) {
    super(message);
    this.name = "JobberOutcomeUncertainError";
  }
}
