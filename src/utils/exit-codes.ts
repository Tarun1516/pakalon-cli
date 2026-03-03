/**
 * Exit codes for the Pakalon CLI process.
 */
export const EXIT_SUCCESS = 0;
export const EXIT_AUTH_ERROR = 1;
export const EXIT_API_ERROR = 2;
export const EXIT_RATE_LIMIT = 3;
export const EXIT_NETWORK_ERROR = 4;
export const EXIT_INVALID_INPUT = 5;
export const EXIT_TRIAL_EXPIRED = 6;
export const EXIT_UNKNOWN = 99;

export const EXIT_MESSAGES: Record<number, string> = {
  [EXIT_SUCCESS]: "OK",
  [EXIT_AUTH_ERROR]: "Authentication error — run `pakalon login`",
  [EXIT_API_ERROR]: "API error",
  [EXIT_RATE_LIMIT]: "Rate limit exceeded",
  [EXIT_NETWORK_ERROR]: "Network error",
  [EXIT_INVALID_INPUT]: "Invalid input",
  [EXIT_TRIAL_EXPIRED]: "Trial expired — run `pakalon upgrade`",
  [EXIT_UNKNOWN]: "Unknown error",
};
