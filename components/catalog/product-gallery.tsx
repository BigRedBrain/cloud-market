'use client'

import { useId, useState } from 'react'

import { MediaImage, MediaPlaceholder } from '@/components/catalog/media-image'
import { isAnimatedFormat, isBrowserPlayable } from '@/lib/media/constants'
import { cn } from '@/lib/utils'

/**
 * Product media gallery.
 *
 * A Client Component for one reason only: switching assets must not reload the
 * page. Everything it renders is passed down as a plain DTO from the Server
 * Component — no queries, no session, no `lib/db` anywhere near the browser
 * bundle.
 *
 * LAYOUT STABILITY. The viewer is a fixed 4:3 box and every asset is fitted
 * inside it with `object-contain`. `object-cover` would crop a portrait video's
 * subject out of frame, and sizing the box to each asset would make the page
 * jump on every thumbnail click — the gallery would become the largest layout
 * shift on the page. A fixed frame costs some letterboxing and buys zero CLS.
 *
 * LOADING. Only the item on screen is mounted, so no video is fetched until it
 * is selected, and the first asset is the only one marked eager. Thumbnails are
 * small, lazy, and the only thing downloaded up front.
 */

export type GalleryMedia = {
  id: string
  url: string
  kind: 'image' | 'video'
  mimeType: string | null
  altText: string
  caption: string | null
  width: number | null
  height: number | null
}

const FRAME = 'relative aspect-4/3 w-full overflow-hidden bg-ink-700'

function KindLabel({ media }: { media: GalleryMedia }) {
  if (media.kind === 'video') return <>Video</>
  if (isAnimatedFormat(media.mimeType)) return <>GIF</>
  return <>Image</>
}

/**
 * One asset in the main viewer.
 *
 * `preload="metadata"` rather than `auto`: enough to render the duration and
 * scrub bar, not the whole file. A product page with three videos on `auto`
 * starts hundreds of megabytes of downloads that nobody asked for.
 *
 * No autoplay, so `muted` carries no behavioural weight — but browsers will
 * refuse an autoplay attempt on an unmuted element, and being explicit means
 * nobody later adds `autoPlay` and ships a page that shouts at customers.
 */
function Viewer({ media, eager, poster }: { media: GalleryMedia; eager: boolean; poster?: string }) {
  if (media.kind === 'video') {
    const playable = isBrowserPlayable(media.mimeType)

    return (
      <div className={FRAME}>
        <video
          key={media.id}
          controls
          playsInline
          muted
          preload="metadata"
          poster={poster}
          aria-label={media.altText || 'Product video'}
          className="size-full object-contain"
        >
          <source src={media.url} type={media.mimeType ?? undefined} />
          Your browser cannot play this video.
        </video>

        {!playable && (
          <p className="absolute inset-x-0 bottom-0 bg-ink-900/90 px-3 py-2 font-mono text-xs text-ember">
            This format may not play in every browser.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className={FRAME}>
      <MediaImage
        src={media.url}
        alt={media.altText}
        width={media.width}
        height={media.height}
        mimeType={media.mimeType}
        eager={eager}
        sizes="(min-width: 1024px) 50vw, 100vw"
        className="size-full object-contain"
      />
    </div>
  )
}

export function ProductGallery({
  media,
  productName,
}: {
  media: GalleryMedia[]
  productName: string
}) {
  const [activeId, setActiveId] = useState(() => media[0]?.id ?? '')
  const headingId = useId()

  if (media.length === 0) {
    return (
      <div className="panel overflow-hidden rounded-lg bg-ink-700">
        <div className={FRAME}>
          <MediaPlaceholder />
        </div>
      </div>
    )
  }

  const active = media.find((item) => item.id === activeId) ?? media[0]

  /**
   * Poster for videos: the product's first image.
   *
   * A video with no poster renders as a black rectangle until it is played,
   * which reads as a broken image. Borrowing the thumbnail is not a generated
   * frame — nothing is derived from the video — it is simply the picture the
   * product already leads with.
   */
  const poster = media.find((item) => item.kind === 'image')?.url

  return (
    <div className="flex flex-col gap-3">
      <h2 id={headingId} className="sr-only">
        {productName} media
      </h2>

      <div className="panel overflow-hidden rounded-lg bg-ink-700">
        <Viewer media={active} eager={active.id === media[0]?.id} poster={poster} />
      </div>

      {active.caption && <p className="text-sm text-smoke">{active.caption}</p>}

      {media.length > 1 && (
        <ul
          aria-labelledby={headingId}
          className="grid grid-cols-4 gap-3 sm:grid-cols-5"
        >
          {media.map((item, index) => {
            const selected = item.id === active.id

            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(item.id)}
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'panel-sm relative block w-full overflow-hidden rounded-md bg-ink-700',
                    'transition-opacity motion-reduce:transition-none',
                    selected ? 'ring-2 ring-ember' : 'opacity-70 hover:opacity-100',
                  )}
                >
                  <span className="sr-only">
                    Show {productName} media {index + 1} of {media.length}
                  </span>

                  <span aria-hidden="true" className="block aspect-4/3 w-full">
                    {item.kind === 'video' ? (
                      /**
                       * A still frame is deliberately NOT generated for the
                       * video thumbnail. Extracting one means decoding the file
                       * server-side, and the label plus the poster image is
                       * enough to say what this is.
                       */
                      <span className="flex size-full items-center justify-center bg-ink-800 font-mono text-[0.625rem] tracking-widest text-smoke uppercase">
                        Video
                      </span>
                    ) : (
                      <MediaImage
                        src={item.url}
                        alt=""
                        width={item.width}
                        height={item.height}
                        mimeType={item.mimeType}
                        sizes="160px"
                        className="size-full object-cover"
                      />
                    )}
                  </span>

                  <span className="absolute top-1 left-1 rounded-sm bg-ink-900/85 px-1 py-0.5 font-mono text-[0.5625rem] tracking-wider text-cream uppercase">
                    <KindLabel media={item} />
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
