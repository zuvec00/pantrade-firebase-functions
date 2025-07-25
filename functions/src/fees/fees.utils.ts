/**
 * Calculates the service charge based on the order subtotal.
 * The charge is 5.5% of the subtotal but capped at ₦500.
 *
 * @param {number} subtotal - The subtotal amount of the order.
 * @return {number} The calculated service charge.
 */
export function calculateServiceCharge(subtotal: number): number {
  const rawCharge = subtotal * 0.055;
  return Math.min(rawCharge, 500); // Cap at ₦500
}
