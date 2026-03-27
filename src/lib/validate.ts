/**
 * Validation utilities for Predict Now
 */

/**
 * Validates a Canton wallet party ID.
 * Must contain "::" separator and be between 20-300 characters.
 */
export function isValidWalletId(partyId: string): boolean {
  if (typeof partyId !== "string") return false;
  if (partyId.length < 20 || partyId.length > 300) return false;
  if (!partyId.includes("::")) return false;
  return true;
}
