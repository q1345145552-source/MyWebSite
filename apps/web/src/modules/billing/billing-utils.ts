import type { OrderItem } from "../../services/business-api";

type TransportMode = "sea" | "land";

const UNIT_PRICE_CNY_PER_M3: Record<TransportMode, number> = {
  // Keep consistent with client freight calculator's "normal" rates.
  sea: 540,
  land: 680,
};

function safeNumber(input: unknown): number | null {
  if (typeof input !== "number") return null;
  if (Number.isNaN(input)) return null;
  return input;
}

export function calcOrderAmountCny(order: OrderItem): number | null {
  const transport = (order.transportMode ?? "").toLowerCase();
  const transportMode: TransportMode | null = transport === "sea" || transport === "land" ? transport : null;
  if (!transportMode) return null;

  const weightKg = safeNumber(order.weightKg) ?? 0;
  const volumeM3 = safeNumber(order.volumeM3) ?? 0;
  if (weightKg <= 0 && volumeM3 <= 0) return null;

  // 500 kg = 1 m3 (same as freight calculator on client home page)
  const convertedVolumeByWeight = weightKg / 500;
  const chargeVolume = Math.max(volumeM3, convertedVolumeByWeight);
  if (!Number.isFinite(chargeVolume) || chargeVolume <= 0) return null;

  const unitPrice = UNIT_PRICE_CNY_PER_M3[transportMode];
  const amount = chargeVolume * unitPrice;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Number(amount.toFixed(2));
}

export function formatCny(amount: number | null | undefined): string {
  if (typeof amount !== "number" || Number.isNaN(amount)) return "-";
  return `¥${amount.toFixed(2)}`;
}

