/**
 * Calculates the service charge based on the order subtotal.
 * The charge is 5.5% of the subtotal plus ₦100, capped at ₦2000.
 *
 * @param {number} subtotal - The subtotal amount of the order.
 * @return {number} The calculated service charge.
 */
export function calculateServiceCharge(subtotal: number): number {
  const rawCharge = (subtotal * 0.055) + 100;
  return Math.min(rawCharge, 2000); // Cap at ₦2000
}
