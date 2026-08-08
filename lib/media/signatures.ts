/**
 * Content sniffing — what a file ACTUALLY is, from its bytes.
 *
 * A filename extension is a claim by whoever named the file, and a `Content-Type`
 * header is a claim by whoever uploaded it. Neither survives contact with an
 * attacker, and neither is consulted here: everything below reads the leading
 * bytes of the object and decides for itself.
 *
 * Pure, synchronous, dependency-free, operating on a `Uint8Array`. That is a
 * deliberate shape — it means the whole security-relevant core of the upload
 * path can be tested with byte literals and no network, no database and no
 * storage provider.
 */

import type { MediaKind } from './constants'

/** How much of a file the caller needs to fetch for these to work. */
export const SNIFF_BYTES = 4096

export type SniffResult = {
  mimeType: string
  kind: MediaKind
  /** True only for a GIF proven to carry more than one frame. */
  animated: boolean
  width: number | null
  height: number | null
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return ''
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index])
  }
  return out
}

const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

/* -------------------------------------------------------------------------- */
/* Formats we refuse outright                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Executables, archives and documents, matched explicitly.
 *
 * Strictly redundant — anything that is not a recognised image or video is
 * rejected by the default branch anyway — but named here so that the *reason*
 * an upload was refused can say "that is a ZIP archive" instead of "unknown",
 * and so the test suite can assert on each class of hostile input individually.
 *
 * ZIP matters most: `.docx`, `.jar`, `.apk` and a plain renamed `.zip` all share
 * the `PK\x03\x04` header, and a ZIP whose bytes happen to also parse as an
 * image is the classic polyglot upload.
 */
const REFUSED_SIGNATURES: ReadonlyArray<{
  label: string
  signature: readonly number[]
  offset?: number
}> = [
  { label: 'ZIP archive (or .docx/.jar/.apk)', signature: [0x50, 0x4b, 0x03, 0x04] },
  { label: 'ZIP archive', signature: [0x50, 0x4b, 0x05, 0x06] },
  { label: 'Windows executable', signature: [0x4d, 0x5a] },
  { label: 'Linux executable', signature: [0x7f, 0x45, 0x4c, 0x46] },
  { label: 'Mach-O executable', signature: [0xfe, 0xed, 0xfa, 0xce] },
  { label: 'Mach-O executable', signature: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: 'RAR archive', signature: [0x52, 0x61, 0x72, 0x21] },
  { label: '7-Zip archive', signature: [0x37, 0x7a, 0xbc, 0xaf] },
  { label: 'gzip archive', signature: [0x1f, 0x8b] },
  { label: 'PDF document', signature: [0x25, 0x50, 0x44, 0x46] },
  { label: 'shell script', signature: [0x23, 0x21] },
  /** SVG and HTML both start a markup document; see the SVG note in constants. */
  { label: 'markup document', signature: [0x3c, 0x3f, 0x78, 0x6d, 0x6c] },
  { label: 'markup document', signature: [0x3c, 0x73, 0x76, 0x67] },
]

export function refusedFormatLabel(bytes: Uint8Array): string | null {
  for (const entry of REFUSED_SIGNATURES) {
    if (startsWith(bytes, entry.signature, entry.offset ?? 0)) return entry.label
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* GIF                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Walks a GIF's block structure counting image descriptors.
 *
 * Two frames means animated. This is not used to gate the upload — a static GIF
 * is perfectly valid and is stored unchanged either way — it exists so the admin
 * can say "GIF · animated" and so the test suite can assert, on the bytes that
 * came back out of storage, that the animation actually survived the round trip.
 *
 * Returns false rather than throwing on a truncated buffer: the caller only
 * fetches the first few KB, so running out of bytes is the normal case for a
 * large GIF and simply means "no second frame seen yet".
 */
function gifIsAnimated(bytes: Uint8Array): boolean {
  // 6-byte header, 7-byte logical screen descriptor.
  let cursor = 13
  const packed = bytes[10]
  const hasGlobalColorTable = (packed & 0x80) !== 0
  if (hasGlobalColorTable) {
    const tableSize = 3 * 2 ** ((packed & 0x07) + 1)
    cursor += tableSize
  }

  let frames = 0

  const skipSubBlocks = () => {
    while (cursor < bytes.length) {
      const size = bytes[cursor]
      cursor += 1
      if (size === 0) return true
      cursor += size
    }
    return false
  }

  while (cursor < bytes.length) {
    const block = bytes[cursor]

    if (block === 0x3b) return frames > 1 // trailer
    if (block === 0x21) {
      // Extension: label, then sub-blocks.
      cursor += 2
      if (!skipSubBlocks()) return frames > 1
      continue
    }
    if (block === 0x2c) {
      frames += 1
      if (frames > 1) return true

      // Image descriptor is 10 bytes; bit 7 of byte 9 flags a local table.
      const localPacked = bytes[cursor + 9]
      cursor += 10
      if (localPacked !== undefined && (localPacked & 0x80) !== 0) {
        cursor += 3 * 2 ** ((localPacked & 0x07) + 1)
      }
      cursor += 1 // LZW minimum code size
      if (!skipSubBlocks()) return frames > 1
      continue
    }

    // Unrecognised byte — a malformed or truncated file. Stop walking.
    return frames > 1
  }

  return frames > 1
}

/* -------------------------------------------------------------------------- */
/* Per-format dimension readers                                                */
/* -------------------------------------------------------------------------- */

/** JPEG: walk the marker chain to the first SOF segment. */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let cursor = 2
  while (cursor + 9 < bytes.length) {
    if (bytes[cursor] !== 0xff) {
      cursor += 1
      continue
    }
    const marker = bytes[cursor + 1]

    // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

    if (isStartOfFrame) {
      return { height: u16be(bytes, cursor + 5), width: u16be(bytes, cursor + 7) }
    }

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      cursor += 2
      continue
    }

    const length = u16be(bytes, cursor + 2)
    if (length <= 0) return null
    cursor += 2 + length
  }
  return null
}

/** WebP: three sub-formats, three different places to read from. */
function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(bytes, 12, 4)

  if (chunk === 'VP8X') {
    // 24-bit little-endian, stored as (value - 1).
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
    return { width, height }
  }

  if (chunk === 'VP8 ') {
    // Lossy: 14-bit dimensions after the 3-byte start code.
    return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
  }

  if (chunk === 'VP8L') {
    // Lossless: 14 bits each, packed across four bytes.
    const bits = u32be(bytes, 21)
    const value =
      ((bits >>> 24) & 0xff) |
      (((bits >>> 16) & 0xff) << 8) |
      (((bits >>> 8) & 0xff) << 16) |
      ((bits & 0xff) << 24)
    return { width: 1 + (value & 0x3fff), height: 1 + ((value >>> 14) & 0x3fff) }
  }

  return null
}

/**
 * AVIF / HEIF: scan for the `ispe` (image spatial extents) box.
 *
 * A full ISOBMFF box-tree walk would be more correct, but `ispe` carries a
 * distinctive four-byte type followed by a version/flags word, and it always
 * lives in the metadata near the head of the file — well inside the window the
 * caller fetched. A linear scan is adequate and cannot loop.
 */
function isoImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  /**
   * The bound reads exactly as far as the fields actually consumed: 4 bytes of
   * type, 4 of version/flags, then two 32-bit extents — 16 in total. An earlier
   * `cursor + 20 < length` guard was both too strict and off by one, and it
   * silently skipped an `ispe` that ended the buffer, which is precisely where
   * it sits in a minimal AVIF.
   */
  for (let cursor = 4; cursor + 16 <= bytes.length; cursor += 1) {
    if (ascii(bytes, cursor, 4) !== 'ispe') continue
    // 4 bytes type, 4 bytes version+flags, then width and height.
    const width = u32be(bytes, cursor + 8)
    const height = u32be(bytes, cursor + 12)
    if (width > 0 && height > 0 && width < 100_000 && height < 100_000) {
      return { width, height }
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* The sniffer                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Identifies a buffer, or returns null if it is not something we accept.
 *
 * Null is the safe default and the only outcome for anything unrecognised —
 * there is no "probably fine" branch. Dimensions are best-effort and may come
 * back null for a valid file (a JPEG whose SOF sits past the sniff window, an
 * AVIF with unusual box ordering); that degrades the admin display, never the
 * security decision.
 */
export function sniff(bytes: Uint8Array): SniffResult | null {
  /* ---- Images ---------------------------------------------------------- */

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const size = jpegDimensions(bytes)
    return {
      mimeType: 'image/jpeg',
      kind: 'image',
      animated: false,
      width: size?.width ?? null,
      height: size?.height ?? null,
    }
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // IHDR is always the first chunk: 8-byte signature, 4-byte length, 4-byte type.
    const hasHeader = ascii(bytes, 12, 4) === 'IHDR'
    return {
      mimeType: 'image/png',
      kind: 'image',
      animated: false,
      width: hasHeader ? u32be(bytes, 16) : null,
      height: hasHeader ? u32be(bytes, 20) : null,
    }
  }

  const gifHeader = ascii(bytes, 0, 6)
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return {
      mimeType: 'image/gif',
      kind: 'image',
      animated: gifIsAnimated(bytes),
      width: u16le(bytes, 6),
      height: u16le(bytes, 8),
    }
  }

  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const size = webpDimensions(bytes)
    return {
      mimeType: 'image/webp',
      kind: 'image',
      animated: false,
      width: size?.width ?? null,
      height: size?.height ?? null,
    }
  }

  /* ---- ISO base media: AVIF, MP4, QuickTime ---------------------------- */

  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4)

    if (brand === 'avif' || brand === 'avis') {
      const size = isoImageDimensions(bytes)
      return {
        mimeType: 'image/avif',
        kind: 'image',
        animated: brand === 'avis',
        width: size?.width ?? null,
        height: size?.height ?? null,
      }
    }

    if (brand === 'qt  ') {
      return {
        mimeType: 'video/quicktime',
        kind: 'video',
        animated: false,
        width: null,
        height: null,
      }
    }

    const MP4_BRANDS = new Set([
      'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42',
      'avc1', 'mmp4', 'M4V ', 'M4A ', 'dash', 'cmfc',
    ])
    if (MP4_BRANDS.has(brand)) {
      return {
        mimeType: 'video/mp4',
        kind: 'video',
        animated: false,
        width: null,
        height: null,
      }
    }

    // An ftyp box with an unrecognised brand. Not proven safe — refuse.
    return null
  }

  /* ---- Matroska / WebM -------------------------------------------------- */

  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    /**
     * EBML covers both WebM and MKV. The doctype string appears in the header
     * within the first few dozen bytes; anything that is not WebM is refused,
     * because a browser cannot play MKV.
     */
    const head = ascii(bytes, 0, Math.min(bytes.length, 256))
    if (head.includes('webm')) {
      return {
        mimeType: 'video/webm',
        kind: 'video',
        animated: false,
        width: null,
        height: null,
      }
    }
    return null
  }

  return null
}
