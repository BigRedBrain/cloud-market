'use client'

import { upload } from '@vercel/blob/client'
import { useActionState, useCallback, useId, useRef, useState, useTransition } from 'react'

import { MediaImage } from '@/components/catalog/media-image'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert } from '@/components/ui/feedback'
import { Field, Input, Textarea } from '@/components/ui/field'
import { Spinner } from '@/components/ui/skeleton'
import {
  ACCEPTED_MIME_TYPES,
  BLOB_PREFIX,
  formatBytes,
  formatDuration,
  isAnimatedFormat,
  kindForMimeType,
  MAX_MEDIA_PER_PRODUCT,
  maxBytesFor,
  MEDIA_ACCESS,
} from '@/lib/media/constants'
import {
  attachLibraryMediaAction,
  deleteMediaAssetAction,
  detachProductMediaAction,
  finalizeUploadAction,
  moveProductMediaAction,
  reorderProductMediaAction,
  setPrimaryMediaAction,
  updateProductMediaMetaAction,
} from '@/lib/media/actions'
import type { ActionResult } from '@/lib/result'
import { cn } from '@/lib/utils'

/**
 * Product media administration.
 *
 * UPLOAD PATH. Files go browser → Vercel Blob directly, using a token minted by
 * `/api/admin/media/upload`. Only after storage confirms the object does this
 * call `finalizeUploadAction`, which re-reads the bytes server-side and decides
 * whether a row is created. The checks performed HERE — extension, declared
 * type, size — exist purely so an operator learns their 200 MB file is too large
 * before spending four minutes uploading it. None of them is a control; the
 * server repeats every one of them against the stored object.
 *
 * ORDERING. Drag-and-drop is offered, and it is not the only way. Pointer
 * dragging is unusable with a keyboard, awkward with a screen reader and
 * genuinely hard on a touch screen, so every item also has explicit move
 * buttons that do the same thing through a plain form post. The drag layer is
 * the enhancement; the buttons are the interface.
 */

type MediaItem = {
  id: string
  mediaId: string
  url: string
  kind: 'image' | 'video'
  mimeType: string | null
  altText: string
  altTextOverride: string | null
  assetAltText: string
  caption: string | null
  title: string | null
  width: number | null
  height: number | null
  bytes: number | null
  durationSeconds: string | null
  isPrimary: boolean
  sortOrder: number
  otherUsageCount: number
}

type LibraryAsset = {
  id: string
  url: string
  kind: 'image' | 'video'
  mimeType: string | null
  title: string | null
  altText: string
  width: number | null
  height: number | null
  bytes: number | null
  durationSeconds: string | null
}

type UploadState = {
  name: string
  status: 'uploading' | 'finalizing' | 'done' | 'error'
  message?: string
}

const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(',')

/* -------------------------------------------------------------------------- */
/* Client-side pre-flight                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A courtesy check, not a control.
 *
 * `file.type` is supplied by the operating system from the extension, so it is
 * exactly the claim the server refuses to believe. Rejecting here saves an
 * operator a long upload that was always going to be refused; passing here
 * proves nothing.
 */
function preflight(file: File): string | null {
  const kind = file.type ? kindForMimeType(file.type) : null
  if (!kind) {
    return `${file.name}: that file type is not supported.`
  }
  const ceiling = maxBytesFor(kind)
  if (file.size > ceiling) {
    return (
      `${file.name}: ${(file.size / 1024 / 1024).toFixed(1)} MB exceeds the ` +
      `${Math.round(ceiling / 1024 / 1024)} MB limit for ${kind}.`
    )
  }
  return null
}

/** Reads duration and dimensions from a video for display only. */
async function probeVideo(
  file: File,
): Promise<{ duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const element = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    const done = (value: { duration?: number; width?: number; height?: number }) => {
      URL.revokeObjectURL(objectUrl)
      resolve(value)
    }

    element.preload = 'metadata'
    element.onloadedmetadata = () =>
      done({
        duration: Number.isFinite(element.duration) ? element.duration : undefined,
        width: element.videoWidth || undefined,
        height: element.videoHeight || undefined,
      })
    element.onerror = () => done({})
    element.src = objectUrl
  })
}

/** Strips path separators and anything else that has no business in a key. */
function safeKey(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned.length > 0 ? cleaned : 'upload'
}

/* -------------------------------------------------------------------------- */
/* Upload panel                                                                */
/* -------------------------------------------------------------------------- */

function UploadPanel({
  productId,
  disabled,
  remaining,
}: {
  productId: string
  disabled: boolean
  remaining: number
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [, startTransition] = useTransition()
  const inputId = useId()

  const send = useCallback(
    async (files: File[]) => {
      const batch = files.slice(0, remaining)

      for (const file of batch) {
        const rejection = preflight(file)
        if (rejection) {
          setUploads((current) => [
            ...current,
            { name: file.name, status: 'error', message: rejection },
          ])
          continue
        }

        setUploads((current) => [...current, { name: file.name, status: 'uploading' }])

        const update = (patch: Partial<UploadState>) =>
          setUploads((current) =>
            current.map((entry) =>
              entry.name === file.name && entry.status !== 'done'
                ? { ...entry, ...patch }
                : entry,
            ),
          )

        try {
          const blob = await upload(`${BLOB_PREFIX}/${Date.now()}-${safeKey(file.name)}`, file, {
            /**
             * PRIVATE. The object is unreadable by URL from the moment it
             * exists — there is no window in which a freshly uploaded asset is
             * world-readable, not even between here and finalization.
             */
            access: MEDIA_ACCESS,
            handleUploadUrl: '/api/admin/media/upload',
            contentType: file.type,
            /** Chunked transfer; large videos otherwise fail on flaky links. */
            multipart: file.size > 8 * 1024 * 1024,
          })

          update({ status: 'finalizing' })

          const probe =
            kindForMimeType(file.type) === 'video' ? await probeVideo(file) : {}

          const payload = new FormData()
          payload.set('productId', productId)
          payload.set('url', blob.url)
          payload.set('title', file.name.slice(0, 160))
          if (probe.duration) payload.set('durationSeconds', String(probe.duration))
          if (probe.width) payload.set('videoWidth', String(probe.width))
          if (probe.height) payload.set('videoHeight', String(probe.height))

          const result = await finalizeUploadAction(null, payload)

          if (result.ok) {
            update({ status: 'done' })
            startTransition(() => {
              // The action revalidates; this refreshes the rendered list.
              window.location.reload()
            })
          } else {
            update({ status: 'error', message: result.message })
          }
        } catch (error) {
          update({
            status: 'error',
            message:
              error instanceof Error ? error.message : 'That upload could not be completed.',
          })
        }
      }
    },
    [productId, remaining, startTransition],
  )

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    void send(Array.from(event.dataTransfer.files))
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg px-6 py-12 text-center',
          'border-2 border-dashed transition-colors motion-reduce:transition-none',
          dragging ? 'border-ember bg-ink-700' : 'border-smoke/50 bg-ink-800',
          disabled && 'opacity-50',
        )}
      >
        <p className="font-display text-xl tracking-tight text-white uppercase">
          Upload media
        </p>
        <p className="max-w-md text-sm text-smoke">
          Drag files here, or choose them below. JPEG, PNG, WebP, AVIF and GIF up
          to 25&nbsp;MB. MP4 and WebM up to 150&nbsp;MB.{' '}
          <strong className="text-cream">Animated GIFs keep their animation.</strong>
        </p>

        <label htmlFor={inputId} className="sr-only">
          Choose media files to upload
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void send(files)
          }}
          className="sr-only"
        />
        <Button
          type="button"
          variant="primary"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Choose files
        </Button>

        <p className="font-mono text-xs text-smoke">
          {disabled
            ? `Limit of ${MAX_MEDIA_PER_PRODUCT} items reached`
            : `${remaining} of ${MAX_MEDIA_PER_PRODUCT} slots free`}
        </p>
      </div>

      {uploads.length > 0 && (
        <ul className="flex flex-col gap-2" aria-live="polite">
          {uploads.map((entry, index) => (
            <li
              key={`${entry.name}-${index}`}
              className="flex items-center gap-3 rounded-md bg-ink-800 px-3 py-2 font-mono text-xs"
            >
              {(entry.status === 'uploading' || entry.status === 'finalizing') && (
                <Spinner label="Uploading" />
              )}
              <span className="truncate text-cream">{entry.name}</span>
              <span
                className={cn(
                  'ml-auto shrink-0',
                  entry.status === 'error' ? 'text-flare' : 'text-smoke',
                )}
              >
                {entry.status === 'uploading' && 'uploading…'}
                {entry.status === 'finalizing' && 'verifying…'}
                {entry.status === 'done' && 'added'}
                {entry.status === 'error' && (entry.message ?? 'failed')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Per-item controls                                                           */
/* -------------------------------------------------------------------------- */

/** A one-button form wrapping a Server Action. */
function ActionButton({
  action,
  fields,
  label,
  title,
  variant = 'ghost',
  disabled = false,
  confirm,
  onResult,
}: {
  action: (
    previous: ActionResult<void> | null,
    formData: FormData,
  ) => Promise<ActionResult<void>>
  fields: Record<string, string>
  label: string
  title?: string
  variant?: 'ghost' | 'primary' | 'destructive' | 'outline'
  disabled?: boolean
  confirm?: string
  onResult?: (result: ActionResult<void>) => void
}) {
  const [state, formAction, pending] = useActionState<ActionResult<void> | null, FormData>(
    async (previous, formData) => {
      const result = await action(previous, formData)
      onResult?.(result)
      return result
    },
    null,
  )

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault()
      }}
      className="contents"
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button
        type="submit"
        size="sm"
        variant={variant}
        disabled={disabled || pending}
        title={title ?? label}
      >
        {label}
      </Button>
      {state && !state.ok && <span className="sr-only">{state.message}</span>}
    </form>
  )
}

function MetaForm({ productId, item }: { productId: string; item: MediaItem }) {
  const [state, formAction, pending] = useActionState<ActionResult<void> | null, FormData>(
    updateProductMediaMetaAction,
    null,
  )
  const altId = useId()
  const captionId = useId()

  const missingAlt = item.altText.trim().length === 0

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="placementId" value={item.id} />

      {state && !state.ok && (
        <Alert tone="error" title="Could not save">
          {state.message}
        </Alert>
      )}

      <Field
        id={altId}
        label="Alt text"
        hint={
          missingAlt
            ? 'Describe what this shows. Leave empty only if it is purely decorative.'
            : 'Overrides the asset description for this product.'
        }
      >
        {(fieldProps) => (
          <Input
            {...fieldProps}
            name="altText"
            defaultValue={item.altTextOverride ?? item.assetAltText}
            maxLength={255}
            placeholder="Frosted buds in a glass jar"
          />
        )}
      </Field>

      <Field id={captionId} label="Caption (optional)">
        {(fieldProps) => (
          <Textarea
            {...fieldProps}
            name="caption"
            defaultValue={item.caption ?? ''}
            maxLength={320}
            rows={2}
            placeholder="Shown under the image in the gallery"
          />
        )}
      </Field>

      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? 'Saving' : 'Save text'}
      </Button>
    </form>
  )
}

/* -------------------------------------------------------------------------- */
/* Item card                                                                   */
/* -------------------------------------------------------------------------- */

function MediaCard({
  productId,
  item,
  index,
  count,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
}: {
  productId: string
  item: MediaItem
  index: number
  count: number
  onDragStart: () => void
  onDragOver: (event: React.DragEvent) => void
  onDrop: () => void
  dragging: boolean
}) {
  const animated = isAnimatedFormat(item.mimeType)
  const kindLabel = item.kind === 'video' ? 'Video' : animated ? 'GIF' : 'Image'
  const missingAlt = item.altText.trim().length === 0
  const reusedElsewhere = item.otherUsageCount > 0

  return (
    <li
      draggable={!item.isPrimary}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn(
        'panel flex flex-col overflow-hidden rounded-lg bg-card',
        dragging && 'opacity-50',
      )}
    >
      <div className="relative aspect-4/3 overflow-hidden border-b-2 border-ink bg-ink-700">
        {item.kind === 'video' ? (
          <video
            src={item.url}
            controls
            playsInline
            muted
            preload="metadata"
            aria-label={item.altText || item.title || 'Product video'}
            className="size-full object-contain"
          />
        ) : (
          <MediaImage
            src={item.url}
            alt={item.altText}
            width={item.width}
            height={item.height}
            mimeType={item.mimeType}
            sizes="320px"
            className="size-full object-contain"
          />
        )}

        <div className="absolute top-2 left-2 flex flex-wrap gap-1.5">
          <Badge variant={item.isPrimary ? 'volt' : 'smoke'}>
            {item.isPrimary ? 'Primary' : kindLabel}
          </Badge>
          {item.isPrimary && <Badge variant="outline">{kindLabel}</Badge>}
          {animated && <Badge variant="ember">Animated</Badge>}
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1 font-mono text-xs text-smoke">
          <span className="truncate text-cream" title={item.title ?? undefined}>
            {item.title ?? 'Untitled'}
          </span>
          <span>
            {item.mimeType ?? 'unknown type'} · {formatBytes(item.bytes)}
            {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
            {item.kind === 'video' ? ` · ${formatDuration(item.durationSeconds)}` : ''}
          </span>
          {reusedElsewhere && (
            <span className="text-ember">
              Also used in {item.otherUsageCount} other place
              {item.otherUsageCount === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {missingAlt && (
          <Alert tone="warning" title="No alt text">
            Screen readers will announce nothing for this. Add a description below.
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            action={setPrimaryMediaAction}
            fields={{ productId, placementId: item.id }}
            label="Set as thumbnail"
            variant="primary"
            disabled={item.isPrimary || item.kind === 'video'}
            title={
              item.kind === 'video'
                ? 'Video cannot be a thumbnail — product cards have no player'
                : 'Use this as the storefront thumbnail'
            }
          />
          <ActionButton
            action={moveProductMediaAction}
            fields={{ productId, placementId: item.id, direction: 'up' }}
            label="← Move"
            title="Move earlier in the gallery"
            disabled={item.isPrimary || index <= 1}
          />
          <ActionButton
            action={moveProductMediaAction}
            fields={{ productId, placementId: item.id, direction: 'down' }}
            label="Move →"
            title="Move later in the gallery"
            disabled={item.isPrimary || index === count - 1}
          />
        </div>

        <MetaForm productId={productId} item={item} />

        <div className="flex flex-wrap items-center gap-2 border-t border-ink-600 pt-3">
          <ActionButton
            action={detachProductMediaAction}
            fields={{ productId, placementId: item.id }}
            label="Remove from product"
            title="Detach from this product. The asset stays in the library."
            confirm={`Remove this from the product? The asset stays in the media library${
              reusedElsewhere ? ' and on the other records using it' : ''
            }.`}
          />
          <ActionButton
            action={deleteMediaAssetAction}
            fields={{ productId, placementId: item.id }}
            label="Delete permanently"
            variant="destructive"
            disabled={reusedElsewhere}
            title={
              reusedElsewhere
                ? 'Used elsewhere — remove it from those records first'
                : 'Destroy the asset and its stored file. Cannot be undone.'
            }
            confirm={
              'PERMANENTLY DELETE this asset and its stored file?\n\n' +
              'This cannot be undone. To take it off this product only, use ' +
              '"Remove from product" instead.'
            }
          />
        </div>
      </div>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* Library picker                                                              */
/* -------------------------------------------------------------------------- */

function LibraryPicker({
  productId,
  assets,
  disabled,
}: {
  productId: string
  assets: LibraryAsset[]
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)

  if (assets.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <Button type="button" variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? 'Hide media library' : `Choose from media library (${assets.length})`}
      </Button>

      {open && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {assets.map((asset) => (
            <li key={asset.id} className="panel-sm flex flex-col overflow-hidden rounded-md bg-ink-800">
              <div className="aspect-4/3 overflow-hidden bg-ink-700">
                {asset.kind === 'video' ? (
                  <div className="flex size-full items-center justify-center font-mono text-[0.625rem] tracking-widest text-smoke uppercase">
                    Video
                  </div>
                ) : (
                  <MediaImage
                    src={asset.url}
                    alt={asset.altText}
                    width={asset.width}
                    height={asset.height}
                    mimeType={asset.mimeType}
                    sizes="200px"
                    className="size-full object-cover"
                  />
                )}
              </div>
              <div className="flex flex-col gap-2 p-2">
                <span className="truncate font-mono text-[0.625rem] text-smoke">
                  {asset.title ?? (asset.altText || 'Untitled')}
                </span>
                <ActionButton
                  action={attachLibraryMediaAction}
                  fields={{ productId, mediaId: asset.id }}
                  label="Add"
                  variant="primary"
                  disabled={disabled}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                     */
/* -------------------------------------------------------------------------- */

export function ProductMediaManager({
  productId,
  items,
  libraryAssets,
}: {
  productId: string
  items: MediaItem[]
  libraryAssets: LibraryAsset[]
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [order, setOrder] = useState<string[] | null>(null)
  const [, formAction] = useActionState<ActionResult<void> | null, FormData>(
    reorderProductMediaAction,
    null,
  )
  const formRef = useRef<HTMLFormElement>(null)

  const atLimit = items.length >= MAX_MEDIA_PER_PRODUCT
  const remaining = Math.max(0, MAX_MEDIA_PER_PRODUCT - items.length)
  const hasPrimary = items.some((item) => item.isPrimary)

  /** Displayed order: primary pinned, then the local drag order if any. */
  const primary = items.filter((item) => item.isPrimary)
  const rest = items.filter((item) => !item.isPrimary)
  const arranged =
    order === null
      ? rest
      : [...rest].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  const displayed = [...primary, ...arranged]

  const commitOrder = (next: string[]) => {
    setOrder(next)
    // Submitted through a real form so it works identically without the drag layer.
    requestAnimationFrame(() => formRef.current?.requestSubmit())
  }

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return setDragId(null)
    const ids = arranged.map((item) => item.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return setDragId(null)
    ids.splice(to, 0, ...ids.splice(from, 1))
    setDragId(null)
    commitOrder(ids)
  }

  return (
    <div className="flex flex-col gap-6">
      <UploadPanel productId={productId} disabled={atLimit} remaining={remaining} />

      <LibraryPicker productId={productId} assets={libraryAssets} disabled={atLimit} />

      {items.length === 0 ? (
        <Alert tone="info" title="No media yet">
          This product shows the placeholder on the storefront. Upload an image or
          GIF to give it a thumbnail.
        </Alert>
      ) : (
        <>
          {!hasPrimary && (
            <Alert tone="warning" title="No thumbnail selected">
              Product cards will fall back to whichever image sorts first. Choose
              one explicitly with &ldquo;Set as thumbnail&rdquo;.
            </Alert>
          )}

          {/* The reorder form the drag layer submits into. */}
          <form ref={formRef} action={formAction} className="hidden">
            <input type="hidden" name="productId" value={productId} />
            {arranged.map((item) => (
              <input key={item.id} type="hidden" name="placementId" value={item.id} />
            ))}
          </form>

          <p className="font-mono text-xs text-smoke">
            The thumbnail always leads the gallery. Drag the rest to reorder, or
            use the move buttons.
          </p>

          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {displayed.map((item, index) => (
              <MediaCard
                key={item.id}
                productId={productId}
                item={item}
                index={index}
                count={displayed.length}
                dragging={dragId === item.id}
                onDragStart={() => setDragId(item.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => handleDrop(item.id)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
