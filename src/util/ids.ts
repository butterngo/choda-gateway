import { ulid } from "ulid";

const CORR_PREFIX = "corr_";

/**
 * Correlation ID format matches the audit-entry schema regex
 * `^corr_[0-9A-HJKMNP-TV-Z]{26}$` (Crockford base32 ULID body).
 */
export function generateCorrId(): string {
	return `${CORR_PREFIX}${ulid()}`;
}
