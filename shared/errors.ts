// Error codes returned by the API as { error: { code, message, details } }.
// The client maps each code to translated copy (i18n key `error.<code>`).

export const ERROR_CODES = {
  // generic
  bad_request: 400,
  validation_failed: 422,
  not_found: 404,
  internal: 500,
  rate_limited: 429,
  csrf_rejected: 403,
  // staff auth
  auth_required: 401,
  invalid_credentials: 401,
  account_locked: 423,
  forbidden: 403,
  // table access
  qr_invalid: 404,
  qr_disabled: 403,
  table_disabled: 403,
  no_open_visit: 409,
  pin_required: 401,
  pin_invalid: 401,
  pin_locked: 423,
  visit_access_required: 401,
  visit_access_revoked: 401,
  visit_closed: 410,
  // ordering
  ordering_paused: 423,
  table_paused: 423,
  outside_hours: 423,
  intake_full: 423,
  visit_billing: 409,
  cart_changed: 409,
  cart_empty: 422,
  idempotency_mismatch: 409,
  item_unavailable: 409,
  // concurrency / state
  stale_version: 409,
  invalid_transition: 409,
  conflict: 409,
  already_done: 409,
  // billing / checkout
  bill_not_finalized: 409,
  bill_changed: 409,
  unresolved_orders: 409,
  unresolved_requests: 409,
  unpaid_bill: 409,
  amount_mismatch: 409,
  already_settled: 409,
  // portions
  quote_expired: 409,
  quote_superseded: 409,
  // reports
  report_not_ready: 409,
  browser_unavailable: 503,
  // payments adapter
  payments_not_configured: 503,
  // catalog (S1): details.blockers lists the publish blocker codes
  publish_blocked: 409,
  // team (S7): the change would leave no active owner
  last_owner: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
