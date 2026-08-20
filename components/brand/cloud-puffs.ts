/**
 * Irregular comic cloud geometry.
 *
 * This replaces the evenly-scalloped rectangle used in the first Phase A pass,
 * which was rejected: an even run of identical bumps reads as a geometric
 * border pattern, not as weather. The approved reference is a *cluster of
 * overlapping puffs of varying size* — billowy and large across the top,
 * smaller and busier along the bottom, with no two lobes alike.
 *
 * So a cloud here is not a path. It is a set of overlapping ellipses plus a
 * core rectangle, and the silhouette is whatever their union happens to be.
 * That is what makes every cloud irregular for free, and what stops a wide
 * banner reading as a repeated tile.
 *
 * Randomness is seeded rather than live. `Math.random()` would give a
 * different cloud on every render and — more importantly — a different cloud on
 * the server than in the build output. A seed makes each cluster stable,
 * reproducible, and independently varied: seed 3 and seed 4 are different
 * clouds, but seed 3 is always the same cloud.
 */

export type Puff = {
  cx: number
  cy: number
  rx: number
  ry: number
  /**
   * Per-lobe ink weight multiplier. A pen held by a hand does not lay down a
   * constant line, and a constant line is the single strongest tell that a
   * shape was generated. Varying the outline growth per lobe breaks that
   * without any filter cost.
   */
  ink: number
}

export type Drip = { x: number; y: number; width: number; length: number }

export type Splat = { cx: number; cy: number; r: number }

/** A bite taken out of the ink line, painted in the body colour. */
export type Nick = { cx: number; cy: number; r: number }

/** A short hand-drawn accent stroke sitting just off the rim. */
export type Tick = { x1: number; y1: number; x2: number; y2: number; w: number }

/** Faint interior speck — dirty paper rather than clean fill. */
export type Grime = { cx: number; cy: number; r: number; opacity: number }

export type CloudCluster = {
  width: number
  height: number
  /** Solid middle, so the union can never develop a hole between lobes. */
  core: { x: number; y: number; width: number; height: number }
  puffs: Puff[]
  drips: Drip[]
  splatter: Splat[]
  nicks: Nick[]
  ticks: Tick[]
  grime: Grime[]
}

/**
 * Small deterministic PRNG (a linear congruential generator).
 *
 * Chosen over anything fancier because the requirement is only "varied but
 * repeatable" — the numbers decorate a cloud, they do not need to survive
 * statistical scrutiny.
 */
function createRandom(seed: number) {
  let state = (Math.imul(seed, 2654435761) ^ 0x9e3779b9) >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

export type BuildClusterOptions = {
  /** Any integer. The same seed always yields the same cloud. */
  seed: number
  width?: number
  height?: number
  /** Roughly how many lobes ride the top edge. Derived from aspect if omitted. */
  topLobes?: number
  /** Ink runs hanging off the underside. */
  drips?: number
  /** Flecks of ink thrown around the silhouette. */
  splatter?: number
}

export function buildCloudCluster({
  seed,
  width = 400,
  height = 240,
  topLobes,
  drips = 3,
  splatter = 10,
}: BuildClusterOptions): CloudCluster {
  const random = createRandom(seed)
  const between = (min: number, max: number) => min + random() * (max - min)

  /*
   * Lobe scale is driven by height so a wide cloud grows more lobes rather
   * than bigger ones — which is what keeps a banner from looking zoomed in.
   *
   * These are deliberately modest. Every unit of lobe radius is a unit of
   * padding the content box has to give back to stay inside the silhouette, so
   * fat lobes buy a nicer cloud at the cost of an unusable interior. This is
   * the balance that keeps a product card's safe area worth having.
   */
  const topRadius = height * 0.22
  const bottomRadius = height * 0.14
  const sideRadius = height * 0.18

  // Keep every lobe inside the viewBox, with room for the outline expansion.
  const margin = topRadius * 1.18
  const spanStart = margin
  const spanEnd = width - margin
  const span = Math.max(1, spanEnd - spanStart)

  /*
   * Lobe count is derived from an overlap guarantee, not picked by eye.
   *
   * Neighbouring puffs must actually intersect. If they only touch — or worse,
   * leave a gap — the union stops being one shape and the core rectangle's
   * straight edge shows through between the lobes, which is instantly readable
   * as a bug rather than as a cloud.
   *
   * The smallest a lobe can get is `radius * 0.78 * 0.88` after the two jitter
   * terms, so spacing is solved against that worst case with margin to spare.
   */
  const lobesFor = (radius: number) =>
    Math.max(3, Math.ceil((span * 0.9) / radius) + 1)

  const lobes = topLobes ?? lobesFor(topRadius)

  const puffs: Puff[] = []

  /*
   * Top edge. The `billow` term swells the middle of the run and tapers the
   * ends, which is the difference between a cloud and a row of circles.
   */
  for (let i = 0; i < lobes; i += 1) {
    const t = lobes === 1 ? 0.5 : i / (lobes - 1)
    const billow = 0.78 + 0.34 * Math.sin(Math.PI * t)
    const radius = topRadius * billow * between(0.88, 1.12)

    puffs.push({
      cx: spanStart + span * t + between(-span * 0.035, span * 0.035),
      cy: height * 0.42 + between(-height * 0.07, height * 0.05),
      rx: radius,
      // Slightly flattened: a perfect circle reads as a bubble, not a puff.
      ry: radius * between(0.82, 0.95),
      ink: between(0.82, 1.26),
    })
  }

  // Bottom edge — more lobes, smaller, so the underside reads busier.
  const bottomLobes = lobesFor(bottomRadius)
  for (let i = 0; i < bottomLobes; i += 1) {
    const t = bottomLobes === 1 ? 0.5 : i / (bottomLobes - 1)
    const radius = bottomRadius * between(0.78, 1.24)

    puffs.push({
      cx: spanStart + span * t + between(-span * 0.03, span * 0.03),
      cy: height * 0.75 + between(-height * 0.03, height * 0.05),
      rx: radius,
      ry: radius * between(0.8, 0.96),
      ink: between(0.86, 1.22),
    })
  }

  // Shoulders, so the silhouette does not pinch in at the ends.
  for (const side of [0, 1]) {
    const radius = sideRadius * between(0.9, 1.15)
    puffs.push({
      cx: side === 0 ? spanStart * 0.92 : width - spanStart * 0.92,
      cy: height * 0.6 + between(-height * 0.05, height * 0.05),
      rx: radius,
      ry: radius * between(0.85, 1),
      ink: between(0.88, 1.18),
    })
  }

  /*
   * Ink runs. Anchored under the lower lobes and only in the middle stretch —
   * a drip off the very corner reads as a mistake rather than as wet ink.
   */
  const dripList: Drip[] = []
  for (let i = 0; i < drips; i += 1) {
    dripList.push({
      x: between(width * 0.18, width * 0.82),
      y: height * 0.82,
      width: between(height * 0.012, height * 0.026),
      length: between(height * 0.06, height * 0.17),
    })
  }

  // Flecks thrown outward from the edge.
  const splatterList: Splat[] = []
  for (let i = 0; i < splatter; i += 1) {
    const angle = random() * Math.PI * 2
    const distance = between(0.46, 0.58)
    splatterList.push({
      cx: width / 2 + Math.cos(angle) * width * distance,
      cy: height / 2 + Math.sin(angle) * height * distance,
      r: between(height * 0.006, height * 0.022),
    })
  }

  /*
   * Nicks — bites out of the ink line.
   *
   * Each is anchored on a real lobe edge and painted in the body colour, so it
   * eats the rim locally and leaves the outline broken and uneven the way a dry
   * pen does. Some land where a neighbouring lobe already covers them and are
   * simply invisible; that inconsistency is the point, and it costs nothing.
   */
  const nicks: Nick[] = []
  for (let i = 0; i < 7; i += 1) {
    const puff = puffs[Math.floor(random() * puffs.length)]
    const angle = random() * Math.PI * 2
    nicks.push({
      cx: puff.cx + Math.cos(angle) * puff.rx,
      cy: puff.cy + Math.sin(angle) * puff.ry,
      r: between(height * 0.012, height * 0.032),
    })
  }

  /*
   * Short accent strokes just off the rim — the marks left when a nib lifts.
   *
   * Placement is constrained rather than free. Picking any puff at any angle
   * drops most strokes *inside* the union, where they read as specks of dirt
   * floating in the middle of the cloud rather than as marks at its edge. So
   * only outward-facing lobes are used: top lobes get upper angles, bottom
   * lobes get lower ones, and the reach starts well clear of the silhouette.
   */
  const outward = puffs.map((puff, index) => ({
    puff,
    // The first run of lobes is the top edge; the rest sit low or at the sides.
    up: index < lobes,
  }))
  const ticks: Tick[] = []
  for (let i = 0; i < 5; i += 1) {
    const pick = outward[Math.floor(random() * outward.length)]
    const puff = pick.puff
    // Upper hemisphere for top lobes, lower for the rest.
    const angle = pick.up
      ? -Math.PI * between(0.15, 0.85)
      : Math.PI * between(0.15, 0.85)
    const reach = between(1.14, 1.3)
    const length = between(height * 0.02, height * 0.05)
    const x1 = puff.cx + Math.cos(angle) * puff.rx * reach
    const y1 = puff.cy + Math.sin(angle) * puff.ry * reach
    ticks.push({
      x1,
      y1,
      x2: x1 + Math.cos(angle) * length,
      y2: y1 + Math.sin(angle) * length,
      w: between(height * 0.006, height * 0.013),
    })
  }

  // Dirty paper. Sparse and very faint — grain, never grunge.
  const grimeList: Grime[] = []
  for (let i = 0; i < 10; i += 1) {
    grimeList.push({
      cx: between(width * 0.06, width * 0.94),
      cy: between(height * 0.34, height * 0.88),
      r: between(height * 0.004, height * 0.016),
      opacity: between(0.04, 0.11),
    })
  }

  return {
    width,
    height,
    /*
     * The solid middle — the guaranteed-opaque region, and the only area a
     * content box can be trusted inside.
     *
     * It has to stay strictly WITHIN the puff union. Widening it to buy the
     * content more room backfires: the rectangle escapes the lobes and its
     * straight edges show, which looks far worse than tight padding. Content
     * gets its room from the padding instead.
     */
    core: {
      x: spanStart * 0.72,
      y: height * 0.36,
      width: width - spanStart * 1.44,
      height: height * 0.46,
    },
    puffs,
    drips: dripList,
    splatter: splatterList,
    nicks,
    ticks,
    grime: grimeList,
  }
}

/**
 * The SUPPORTING clouds for a wide banner.
 *
 * These sit behind the central content cloud, which the banner builds
 * separately. Deliberately NOT one cloud stretched wide: each gets its own
 * seed, size and vertical offset, so the composition reads as several clouds
 * hovering near each other.
 *
 * Positions are pushed toward the flanks. Piling a supporting cloud directly
 * behind the centre buys nothing — it is hidden by the content cloud — while
 * its edges crowd the band. Weighting them outward is what makes the bank read
 * as wide.
 */
export type BannerCluster = {
  cluster: CloudCluster
  /** Percentage offsets, so the arrangement survives any container width. */
  left: number
  /** Percentage of banner height; width follows from the 5:3 aspect. */
  height: number
  top: number
  /** Paint order among the supporting clouds. */
  depth: 'back' | 'front'
  /** Outermost clouds, dropped on small screens where they sit offscreen. */
  optional: boolean
  /** Per-cluster float period, so nothing bobs in sync. */
  floatDuration: string
  floatDelay: string
}

const FLOAT_PERIODS = ['7.3s', '9.1s', '8.2s', '10.4s', '6.8s', '11.2s']

export function buildBannerClusters(seed: number, count = 5): BannerCluster[] {
  const random = createRandom(seed + 9973)
  const between = (min: number, max: number) => min + random() * (max - min)

  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1)

    /*
     * Clusters are sized by HEIGHT, not width.
     *
     * Width-driven sizing made each cloud as tall as its own 5:3 box, which on
     * a wide banner was several times the band's height — so every cloud was
     * cropped by the scenery layer into a flat-topped slab. Driving height
     * instead keeps each cloud whole and lets its width fall out of the aspect
     * ratio, which is what makes the row read as a bank of clouds.
     *
     * Size also varies per cluster AND is biased toward the centre, so the bank
     * never reads as a row of evenly matched blocks. Back clusters run smaller,
     * which is what lets them sit convincingly behind their neighbours.
     */
    /*
     * Push each cloud away from the centre. `t` is linear across the row; the
     * cubic term pulls values toward 0 and 1 and thins out the middle, which is
     * where the content cloud already sits.
     */
    const flank = t + (t - 0.5) * (1 - Math.abs(t - 0.5) * 2) * 0.55

    const depth: BannerCluster["depth"] = index % 2 === 0 ? "front" : "back"
    /*
     * Kept within the band on purpose. A supporting cloud taller than the
     * banner gets sliced flat by the scenery layer's clip, and that straight
     * cut is visible wherever the central cloud does not cover it. Capping
     * top + height near 100% keeps every silhouette whole.
     */
    const heightPercent =
      between(64, 84) *
      (0.82 + 0.26 * Math.sin(Math.PI * t)) *
      (depth === "back" ? 0.9 : 1)

    return {
      cluster: buildCloudCluster({
        seed: seed + index * 17,
        width: 400,
        height: 240,
        drips: index % 2 === 0 ? 2 : 3,
        splatter: 8,
      }),
      // Centres spread past both edges so the bank reads as continuing
      // offscreen (the scenery layer clips the bleed), jittered so the spacing
      // is never perfectly even, and eased away from the middle so the flanks
      // carry the width.
      left: -6 + flank * 112 + between(-4.5, 4.5),
      height: heightPercent,
      top: between(0, 9),
      depth,
      // The two outermost clouds are the ones mostly offscreen on a phone.
      optional: index === 0 || index === count - 1,
      floatDuration: FLOAT_PERIODS[index % FLOAT_PERIODS.length],
      floatDelay: `${(index * 0.9).toFixed(1)}s`,
    }
  })
}
