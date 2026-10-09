import {BudgetUnavailableError,RequestRateLimitError} from "../jobber/cost-governor.js";
import {JobberApiError,JobberAuthenticationError,JobberGraphQLRequestError} from "../jobber/errors.js";
import {DirectoryIncomplete} from "./census.js";

/** Fixed, non-private reasons only; never return provider messages or variables. */
export function readFailureReason(error:unknown):string {
  if(error instanceof BudgetUnavailableError)return "budget_refilling";
  if(error instanceof RequestRateLimitError)return "request_rate_limited";
  if(error instanceof JobberAuthenticationError)return "account_or_authentication";
  if(error instanceof DirectoryIncomplete)return "incomplete_response";
  if(error instanceof JobberGraphQLRequestError)return "provider_rejected_read";
  if(error instanceof JobberApiError) {
    if(/throttled|HTTP 429|rate limit/i.test(error.message))return "provider_throttled";
    if(/HTTP 5\d\d/.test(error.message))return "provider_unavailable";
    if(/timeout|timed out|network|fetch failed|connection/i.test(error.message))return "transport_unavailable";
  }
  return "read_unavailable";
}
