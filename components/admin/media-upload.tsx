'use client'

import { upload } from '@vercel/blob/client'
import { useCallback, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/skeleton'
import {
  ACCEPTED_MIME_TYPES,
  BLOB_PREFIX,
  kindForMimeType,
  maxBytesFor,
  MEDIA_ACCESS,
} from '@/lib/media/constants'
import { finalizeUploadAction } from '@/lib/media/actions'
import { cn } from '@/lib/utils'

/**
 * Library-level upload — creates an unattached asset.
 *
 * The same transport and the same server-side verification as the product
 * editor, with no `productId`, so the result lands in the library for any
 * product, campaign or collection to pick up later. Deliberately a separate,
 * smaller component rather than a mode flag on the product manager: this one has
 * no gallery, no ordering and no thumbnail concept, and folding them together
 * would mean a pile of conditionals over two genuinely different screens.
 */

type Entry = { name: string; status: 'busy' | 'done' | 'error'; message?: string }

export function MediaLibraryUpload() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const inputId = useId()

  const send = useCallback(async (files: File[]) => {
    for (const file of files) {
      const kind = file.type ? kindForMimeType(file.type) : null
      if (!kind) {
        setEntries((c) => [
          ...c,
          { name: file.name, status: 'error', message: 'unsupported type' },
        ])
        continue
      }
      if (file.size > maxBytesFor(kind)) {
        setEntries((c) => [...c, { name: file.name, status: 'error', message: 'too large' }])
        continue
      }

      setEntries((c) => [...c, { name: file.name, status: 'busy' }])
      const update = (patch: Partial<Entry>) =>
        setEntries((c) =>
          c.map((e) => (e.name === file.name && e.status === 'busy' ? { ...e, ...patch } : e)),
        )

      try {
        const blob = await upload(
          `${BLOB_PREFIX}/${Date.now()}-${file.name.toLowerCase().replace(/[^a-z0-9.\-_]+/g, '-')}`,
          file,
          {
            /** See `MEDIA_ACCESS` — every object in this store is private. */
            access: MEDIA_ACCESS,
            handleUploadUrl: '/api/admin/media/upload',
            contentType: file.type,
            multipart: file.size > 8 * 1024 * 1024,
          },
        )

        const payload = new FormData()
        payload.set('url', blob.url)
        payload.set('title', file.name.slice(0, 160))

        const result = await finalizeUploadAction(null, payload)
        if (result.ok) {
          update({ status: 'done' })
          window.location.reload()
        } else {
          update({ status: 'error', message: result.message })
        }
      } catch (error) {
        update({
          status: 'error',
          message: error instanceof Error ? error.message : 'upload failed',
        })
      }
    }
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void send(Array.from(event.dataTransfer.files))
        }}
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 text-center',
          'transition-colors motion-reduce:transition-none',
          dragging ? 'border-ember bg-ink-700' : 'border-smoke/50 bg-ink-800',
        )}
      >
        <p className="font-display text-lg tracking-tight text-white uppercase">Upload media</p>
        <p className="max-w-md text-sm text-smoke">
          Drag files here or choose them. Images and GIFs to 25&nbsp;MB, video to
          150&nbsp;MB. Animated GIFs keep their animation.
        </p>

        <label htmlFor={inputId} className="sr-only">
          Choose media files to upload
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={ACCEPTED_MIME_TYPES.join(',')}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void send(files)
          }}
          className="sr-only"
        />
        <Button type="button" variant="primary" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
      </div>

      {entries.length > 0 && (
        <ul className="flex flex-col gap-2" aria-live="polite">
          {entries.map((entry, index) => (
            <li
              key={`${entry.name}-${index}`}
              className="flex items-center gap-3 rounded-md bg-ink-800 px-3 py-2 font-mono text-xs"
            >
              {entry.status === 'busy' && <Spinner label="Uploading" />}
              <span className="truncate text-cream">{entry.name}</span>
              <span
                className={cn(
                  'ml-auto shrink-0',
                  entry.status === 'error' ? 'text-flare' : 'text-smoke',
                )}
              >
                {entry.status === 'busy' && 'uploading…'}
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
