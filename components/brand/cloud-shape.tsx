import type * as React from 'react'

import type { CloudCluster } from '@/components/brand/cloud-puffs'
import { cn } from '@/lib/utils'

/**
 * Renders one irregular comic cloud from a puff cluster.
 *
 * THE UNION PROBLEM, AND HOW IT IS SOLVED
 *
 * A cloud here is a pile of overlapping ellipses. Stroking each one would draw
 * every internal seam, which looks like a bunch of circles rather than a cloud.
 * Computing a true boolean union of a dozen ellipses in the browser is possible
 * but expensive and fiddly.
 *
 * Instead the shape is painted twice:
 *
 *   1. an INK layer — every ellipse, plus the core rect, grown by the outline
 *      width and filled with ink;
 *   2. a BODY layer — the same shapes at their true size, filled with Pearl.
 *
 * The body layer covers all the interior ink, leaving ink visible only where it
 * extends past the union — which is exactly the outline. One clean silhouette,
 * no boolean geometry, and it costs two cheap fill passes.
 *
 * MAKING IT LOOK HAND-INKED
 *
 * A uniform outline is the giveaway that a shape was generated, so four cheap
 * passes break it up — all plain fills, no filters:
 *
 *   - each lobe grows by its own `ink` multiplier, so the rim thickens and
 *     thins around the silhouette the way a pen does;
 *   - `nicks` paint body-coloured bites over the rim, breaking the line;
 *   - `ticks` add short strokes just off the edge, like a nib lifting;
 *   - `grime`, drips and splatter dirty the paper without turning into noise.
 *
 * Deliberately NOT used: `feTurbulence`, displacement maps, or any blur over a
 * large area. Those rasterise expensively and are the first thing to stutter on
 * a mid-range Android, which is most of this traffic. Everything here is a fill.
 *
 * The same shape list is reused as a `clipPath`, so texture stays inside the
 * lobes.
 *
 * Everything is decoration: the root `<svg>` is `aria-hidden` and inert.
 */

type CloudShapeProps = {
  cluster: CloudCluster
  /** Must be unique per rendered instance — SVG ids are document-global. */
  id: string
  surface?: 'pearl' | 'cloud-white'
  /** Base ink weight in viewBox units, before each lobe's own variation. */
  outline?: number
  /** Hard comic shadow, offset down-right. */
  shadow?: boolean
  /** Any CSS colour. Drives the outer bloom only — never the body or outline. */
  glowColor?: string
  /** Ink runs, nicks, ticks and flecks. Off where they would read as noise. */
  grit?: boolean
  className?: string
  style?: React.CSSProperties
}

export function CloudShape({
  cluster,
  id,
  surface = 'pearl',
  outline = 7,
  shadow = true,
  glowColor,
  grit = true,
  className,
  style,
}: CloudShapeProps) {
  const { width, height, core, puffs, drips, splatter, nicks, ticks, grime } =
    cluster
  const body = surface === 'pearl' ? 'var(--pearl)' : 'var(--cloud-white)'
  const ink = 'var(--dark-smoke-deep)'

  const clipId = `${id}-clip`
  const dotsId = `${id}-dots`
  const coarseId = `${id}-coarse`

  /*
   * drop-shadow rather than box-shadow for both effects: it follows the
   * element's alpha, so the shadow and the bloom hug the lobed silhouette
   * instead of drawing a rectangle around it, and both composite on the GPU.
   *
   * The bloom is the QUIETEST tier of the glow hierarchy — headline first,
   * spark marks second, cloud bloom last. Earlier values had it competing with
   * the lettering, which turned the whole banner into a neon object. Small
   * radii, layered, and that is all it should ever be.
   */
  const filters = [
    shadow ? `drop-shadow(6px 6px 0 ${ink})` : null,
    glowColor ? `drop-shadow(0 0 3px ${glowColor})` : null,
    glowColor ? `drop-shadow(0 0 9px ${glowColor})` : null,
  ].filter(Boolean)

  /**
   * @param grow    outline thickness; 0 draws the true silhouette
   * @param fill    paint colour
   * @param jitter  when true, each lobe uses its own ink weight
   */
  const shapes = (grow: number, fill: string, jitter = false) => (
    <>
      <rect
        x={core.x - grow}
        y={core.y - grow}
        width={core.width + grow * 2}
        height={core.height + grow * 2}
        rx={grow > 0 ? grow : 0}
        fill={fill}
      />
      {puffs.map((puff, index) => {
        const g = jitter ? grow * puff.ink : grow
        return (
          <ellipse
            key={`${id}-p${index}`}
            cx={puff.cx}
            cy={puff.cy}
            rx={puff.rx + g}
            ry={puff.ry + g}
            fill={fill}
          />
        )
      })}
    </>
  )

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('pointer-events-none h-full w-full', className)}
      style={{ ...style, filter: filters.length ? filters.join(' ') : undefined }}
    >
      <defs>
        <clipPath id={clipId}>{shapes(0, '#000')}</clipPath>

        {/*
         * Halftone as SVG patterns rather than the global `.halftone` utility:
         * the utility tiles in CSS pixels and would resize with the element,
         * drifting off-model. Pattern units stay in viewBox space, so the dot
         * pitch holds at every rendered size.
         *
         * Two pitches layered at low opacity give an uneven, printed look
         * instead of the single even dot-grid that read as a screen texture.
         */}
        <pattern id={dotsId} width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="1.6" cy="1.6" r="1" fill={ink} opacity="0.11" />
        </pattern>
        <pattern
          id={coarseId}
          width="19"
          height="19"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="4" cy="12" r="1.8" fill={ink} opacity="0.06" />
          <circle cx="13" cy="4" r="1.2" fill={ink} opacity="0.05" />
        </pattern>
      </defs>

      {/* 1. Ink layer — grown per lobe, so only an uneven rim survives. */}
      {shapes(outline, ink, true)}

      {/* Ink runs, drawn with the ink layer so they read as part of the edge. */}
      {grit &&
        drips.map((drip, index) => (
          <path
            key={`${id}-d${index}`}
            d={
              `M${drip.x - drip.width} ${drip.y}` +
              ` q${drip.width} ${drip.length * 0.55} 0 ${drip.length}` +
              ` q${drip.width} ${-drip.length * 0.55} 0 ${-drip.length} Z`
            }
            fill={ink}
          />
        ))}

      {/* 2. Body layer — covers every interior seam. */}
      {shapes(0, body)}

      {/* 3. Nicks — bite the rim back so the line breaks up. */}
      {grit &&
        nicks.map((nick, index) => (
          <circle
            key={`${id}-n${index}`}
            cx={nick.cx}
            cy={nick.cy}
            r={nick.r}
            fill={body}
          />
        ))}

      {/* 4. Interior: texture, shading and dirt — all clipped to the lobes. */}
      <g clipPath={`url(#${clipId})`}>
        <rect width={width} height={height} fill={`url(#${dotsId})`} />
        <rect width={width} height={height} fill={`url(#${coarseId})`} />

        {/*
         * Shading under the lower lobes, so the cloud has a lit side. Two soft
         * ellipses rather than one, offset, which stops it reading as a band.
         */}
        <ellipse
          cx={width * 0.5}
          cy={height * 1.04}
          rx={width * 0.47}
          ry={height * 0.24}
          fill={ink}
          opacity="0.1"
        />
        <ellipse
          cx={width * 0.36}
          cy={height * 0.99}
          rx={width * 0.26}
          ry={height * 0.16}
          fill={ink}
          opacity="0.07"
        />

        {grit &&
          grime.map((speck, index) => (
            <circle
              key={`${id}-g${index}`}
              cx={speck.cx}
              cy={speck.cy}
              r={speck.r}
              fill={ink}
              opacity={speck.opacity}
            />
          ))}
      </g>

      {/* 5. Marks thrown clear of the edge. */}
      {grit && (
        <>
          {splatter.map((splat, index) => (
            <circle
              key={`${id}-s${index}`}
              cx={splat.cx}
              cy={splat.cy}
              r={splat.r}
              fill={ink}
              opacity="0.75"
            />
          ))}
          {ticks.map((tick, index) => (
            <line
              key={`${id}-t${index}`}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke={ink}
              strokeWidth={tick.w}
              strokeLinecap="round"
              opacity="0.8"
            />
          ))}
        </>
      )}
    </svg>
  )
}
