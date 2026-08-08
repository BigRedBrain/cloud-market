import { cn } from '@/lib/utils'

/**
 * The one place product imagery is rendered.
 *
 * IT RENDERS A PLAIN `<img>`, AND BOTH REASONS ARE LOAD-BEARING.
 *
 * 1. AUTHENTICATION. Every asset is now addressed as `/api/media/<id>`, a route
 *    that requires a session (see `app/api/media/[id]/route.ts`). Next's image
 *    optimizer fetches the source ITSELF, server-side, as its own request — it
 *    does not carry the viewer's cookies. Handing it one of these URLs produces
 *    a 401 at the optimizer and a broken image on the page. This is not a
 *    limitation to work around: an optimizer that COULD read the source would
 *    be a component that fetches private media without a session, and its
 *    output is cached under a URL of its own.
 *
 * 2. ANIMATED GIFs. The optimizer re-encodes to WebP or AVIF at the requested
 *    width, and that pipeline is single-frame: hand it a twelve-frame GIF and it
 *    returns frame one, as a still, with no error and no warning. The image
 *    loads, looks right in a screenshot, and never moves.
 *
 * WHAT IS GIVEN UP, STATED PLAINLY. Server-side resizing and format conversion.
 * A 4000px pack shot is now sent at 4000px to a card that displays it at 300.
 * The mitigation is operational rather than technical — upload sensibly sized
 * assets — and the trade was made deliberately: correct privacy at a known
 * bandwidth cost beats an optimisation that cannot see the file.
 *
 * WHAT IS NOT GIVEN UP. `width`, `height`, `loading` and `decoding` are all
 * still set, so the layout box is still reserved before the bytes arrive and
 * cumulative layout shift is still zero. That was always the part `next/image`
 * contributed that mattered most here, and it is plain HTML.
 */

type MediaImageProps = {
  /** Always `/api/media/<id>` for our own assets; an absolute URL only for pasted third-party ones. */
  src: string
  alt: string
  width: number | null
  height: number | null
  mimeType: string | null
  className?: string
  /** Above the fold. Disables lazy loading and decodes synchronously. */
  eager?: boolean
  /**
   * Retained for call-site compatibility and future use. It informs a browser's
   * choice between candidates in a `srcset`, and there is no `srcset` while the
   * optimizer is bypassed, so today it is inert rather than wrong.
   */
  sizes?: string
  /** Rendered when intrinsic dimensions are unknown; keeps the box stable. */
  fallbackWidth?: number
  fallbackHeight?: number
}

export function MediaImage({
  src,
  alt,
  width,
  height,
  className,
  eager = false,
  fallbackWidth = 640,
  fallbackHeight = 480,
}: MediaImageProps) {
  const renderWidth = width && width > 0 ? width : fallbackWidth
  const renderHeight = height && height > 0 ? height : fallbackHeight

  return (
    // eslint-disable-next-line @next/next/no-img-element -- the optimizer cannot authenticate; see the note above.
    <img
      src={src}
      alt={alt}
      width={renderWidth}
      height={renderHeight}
      loading={eager ? 'eager' : 'lazy'}
      decoding={eager ? 'sync' : 'async'}
      className={className}
    />
  )
}

/**
 * The empty state, unchanged from what the storefront already used.
 *
 * A product with no media has always shown the halftone wash rather than a
 * "missing image" glyph, and adding uploads did not change that — the
 * placeholder is a designed state, not a failure.
 */
export function MediaPlaceholder({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('halftone size-full text-smoke opacity-40', className)} />
  )
}
