// Госрезерв: вместимость складов провинции по товарам.
// Склады распределяют место «узкие первыми»: товар сначала занимает склады, которые хранят меньше видов товаров
// (элеватор — только зерно), а универсальные склады — то, что не влезло.

import type { Building, StorageBuilding } from '../../data/schemas';
import type { GoodId, Reserve } from '../state';

function readyStorages(reserve: Reserve, buildings: readonly Building[], province: string): StorageBuilding[] {
  const result: StorageBuilding[] = [];
  for (const s of reserve.storages) {
    if (!s.ready || s.province !== province) continue;
    const b = buildings.find((x) => x.id === s.building);
    if (b?.kind === 'storage') result.push(b);
  }
  return result.sort((a, b) => a.storedGoods.length - b.storedGoods.length || a.id.localeCompare(b.id));
}

/** Свободное место под товар в провинции. */
export function freeSpace(reserve: Reserve, buildings: readonly Building[], province: string, good: GoodId): number {
  const storages = readyStorages(reserve, buildings, province);
  const left = storages.map((s) => s.storageCapacity);
  const stock = reserve.stock[province] ?? {};
  for (const [g, quantity] of Object.entries(stock).sort(([a], [b]) => a.localeCompare(b))) {
    let rest = quantity;
    storages.forEach((s, i) => {
      if (rest <= 0 || !s.storedGoods.includes(g)) return;
      const take = Math.min(rest, left[i]!);
      left[i]! -= take;
      rest -= take;
    });
  }
  let free = 0;
  storages.forEach((s, i) => {
    if (s.storedGoods.includes(good)) free += left[i]!;
  });
  return Math.max(0, free);
}
