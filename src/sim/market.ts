// Клиринг рынка одного товара (GDD 5.16).
// Продажи делятся между продавцами пропорционально их запасу (все продают одну и ту же долю склада);
// при нехватке все покупатели получают одну и ту же долю заявки; каждый платит среднюю цену сделок,
// но не больше своего бюджета. Деньги сохраняются точно: Σ оплат = Σ выручки.

export interface Offer {
  seller: string;
  price: number;
  quantity: number;
}

export interface Bid {
  buyer: string;
  quantity: number;
  budget: number;
}

export interface ClearingResult {
  /** Продано каждым продавцом. */
  sold: Map<string, number>;
  /** Куплено каждым покупателем. */
  bought: Map<string, number>;
  /** Заплачено каждым покупателем. */
  paid: Map<string, number>;
  /** Всего заявлено. */
  demanded: number;
  /** Всего продано. */
  quantity: number;
  /** Средняя цена сделки; без сделок — средняя цена предложения (0, если предложения нет). */
  averagePrice: number;
  /** Неудовлетворённая из-за нехватки предложения часть заявок. */
  unmetBySupply: number;
}

export function clearMarket(offers: readonly Offer[], bids: readonly Bid[]): ClearingResult {
  let supply = 0;
  let supplyValue = 0;
  for (const o of offers) {
    const q = Math.max(0, o.quantity);
    supply += q;
    supplyValue += q * o.price;
  }
  let demanded = 0;
  for (const b of bids) demanded += Math.max(0, b.quantity);

  // При пропорциональном делении средняя цена не зависит от объёма продаж.
  const averagePrice = supply > 0 ? supplyValue / supply : 0;
  const traded = Math.min(supply, demanded);
  const fill = demanded > 0 ? traded / demanded : 0;

  const bought = new Map<string, number>();
  const paid = new Map<string, number>();
  let quantity = 0;
  for (const bid of bids) {
    let q = Math.max(0, bid.quantity) * fill;
    if (averagePrice > 0) q = Math.min(q, Math.max(0, bid.budget) / averagePrice);
    bought.set(bid.buyer, q);
    paid.set(bid.buyer, q * averagePrice);
    quantity += q;
  }

  const sold = new Map<string, number>();
  const sellShare = supply > 0 ? quantity / supply : 0;
  for (const o of offers) sold.set(o.seller, Math.max(0, o.quantity) * sellShare);

  return { sold, bought, paid, demanded, quantity, averagePrice, unmetBySupply: demanded - traded };
}
