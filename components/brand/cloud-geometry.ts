/**
 * Shared cloud and flame geometry.
 *
 * The four-lobe silhouette is CloudMarket's one shape, reused at every scale.
 * It already exists as a local constant inside `logo.tsx`, `cloud-button.tsx`
 * and `burning-cloud.tsx`; those are working, shipped components and are left
 * alone deliberately. Everything built from here on imports the path from this
 * module instead of adding a fourth copy.
 */

/** Puffy four-lobe cloud with a flat base. viewBox `0 0 200 96`. */
export const CLOUD_SILHOUETTE_PATH =
  'M30 88 C12 88 4 74 12 61 C4 46 18 30 36 34 C42 14 70 8 84 22 ' +
  'C96 6 128 6 140 24 C160 16 182 30 178 50 C196 54 200 78 184 88 Z'

/**
 * Comic flame cluster. Three licks of increasing height, drawn on a
 * `0 0 180 90` grid with their roots below the baseline so the bottom edge can
 * be overlapped by whatever the flame sits behind.
 */
export const FLAME_PATHS = [
  'M30 92 C22 68 48 60 40 34 C64 56 56 78 30 92 Z',
  'M88 94 C78 64 108 54 98 24 C128 52 118 78 88 94 Z',
  'M146 92 C138 70 160 62 152 38 C174 58 166 78 146 92 Z',
] as const
