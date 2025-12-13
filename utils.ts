import { IsoDeliveryTime } from "./types";

export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map<K, V>();
  }

  get(key: K): V | undefined {
    if (this.cache.has(key)) {
      const value = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    return undefined;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, value);
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }
}

export function memoize<A, R>(fn: (arg: A) => Promise<R>, capacity: number, onCacheHit?: (arg: A, value: R) => void): (arg: A) => Promise<R> {
  const cache = new LRUCache<A, R>(capacity);
  return async (arg: A) => {
    if (cache.has(arg)) {
      const value = cache.get(arg)!;
      if (onCacheHit) {
        onCacheHit(arg, value);
      }
      return value;
    }
    const result = await fn(arg);
    cache.set(arg, result);
    return result;
  };
}


export function parseIsoDeliveryTime(isoTime: IsoDeliveryTime): Date {
  const { year, month, day, hour, minute, second = 0, timezone } = isoTime;
  let date: Date;

  if (timezone) {
    // Validate and construct ISO string with timezone
    const pad = (n: number) => n.toString().padStart(2, '0');
    const isoStringWithoutZone = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;

    if (timezone === 'Z' || /^[+-]\d{2}:?\d{2}$/.test(timezone)) {
      // ISO 8601 format with offset
      date = new Date(`${isoStringWithoutZone}${timezone}`);
    } else {
      throw new Error(`Unsupported timezone format: ${timezone}. Must be 'Z' or ISO offset (e.g. +05:30).`);
    }
  } else {
    // Local time (server local)
    date = new Date(year, month - 1, day, hour, minute, second);
  }

  if (isNaN(date.getTime())) {
    throw new Error("Invalid date constructed (result was NaN). Check day/month boundaries.");
  }
  return date;
}
