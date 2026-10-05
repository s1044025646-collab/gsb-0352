import type { Entrant } from "./types.js";

/**
 * 标准种子展开（公开且确定）。
 *
 * 从 [1, 2] 开始，每次签表翻倍时，把已有序列中的每个种子 s 展开为
 *   s, newSize + 1 - s
 * 其中 newSize 为翻倍后的签表大小。
 *
 * 例：
 *   size=2:  1 2
 *   size=4:  1 4 2 3
 *   size=8:  1 8 4 5 2 7 3 6
 *
 * 头号种子所在半场填入的是空缺的高号种子，因此头号种子首轮优先面对轮空。
 */
export function seedOrder(size: number): number[] {
  if (size < 1 || (size & (size - 1)) !== 0) {
    throw new Error(`签表大小必须是二次幂，收到 ${size}`);
  }
  let order = [1, 2];
  let current = 2;
  while (current < size) {
    const doubled = current * 2;
    const next: number[] = [];
    for (const s of order) {
      next.push(s);
      next.push(doubled + 1 - s);
    }
    order = next;
    current = doubled;
  }
  return order.slice(0, size);
}

/** 不小于 n 的最小二次幂；n<=0 抛出。 */
export function nextPowerOfTwo(n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`人数必须为正整数，收到 ${String(n)}`);
  }
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * 生成首轮签位：按种子展开顺序，seedNo <= 人数的签位放入参赛者，
 * 其余为空签位（轮空候选）。返回与签位下标对齐的数组。
 */
export function buildLeaves(
  entrants: Entrant[],
  size: number,
): Array<{ index: number; entrantId: number | null; seedNo: number | null }> {
  const bySeed = new Map<number, Entrant>();
  for (const e of entrants) bySeed.set(e.seedNo, e);
  const order = seedOrder(size);
  return order.map((seedNo, index) => {
    const entrant = bySeed.get(seedNo) ?? null;
    return {
      index,
      entrantId: entrant ? entrant.id : null,
      seedNo: entrant ? seedNo : null,
    };
  });
}
