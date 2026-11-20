export type Role = "merchant" | "group" | "platform" | "customer_service";

export type Actor = {
  userId: string;
  displayName: string;
  role: Role;
  merchantId: string | null;
  merchantName: string | null;
  groupId: string | null;
  groupName: string | null;
  phoneMasked: string;
};

export type UnitView = {
  id: string;
  unitLabel: string;
  isBase: boolean;
  toBaseNumerator: number;
  toBaseDenominator: number;
};

export type QuoteStatus = "effective" | "expired" | "scheduled" | "overlapped";

export type SkuRecord = {
  id: string;
  productId: string;
  merchantId: string;
  merchantName: string;
  groupId: string | null;
  productName: string;
  specName: string;
  baseUnitLabel: string;
  unitLabel: string;
  onHand: number;
  onHandBase: number;
  reservedBase: number;
  availableBase: number;
  units: UnitView[];
  createdAt: string;
  note: string | null;
};

export type PriceBreakdown = {
  quoteId: string;
  floorPriceCents: number;
  floorPriceYuan: string;
  commissionBps: number;
  commissionPercent: string;
  commissionCents: number;
  commissionYuan: string;
  platformPriceCents: number;
  platformPriceYuan: string;
  ruleStatus: string;
  formula: string;
};

export type QuoteView = {
  id: string;
  skuId: string;
  merchantId: string;
  productName: string;
  specName: string;
  unitLabel: string;
  floorPriceCents: number;
  floorPriceYuan: string;
  validFrom: string;
  validUntil: string;
  createdAt: string;
  createdBy: string;
  note: string | null;
  status: QuoteStatus;
  statusLabel: string;
  price: PriceBreakdown | null;
};

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; code: string; message: string; httpStatus: number };
export type Result<T> = Ok<T> | Err;
