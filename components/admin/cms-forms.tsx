'use client'

import { useActionState } from 'react'

import { AdminForm, DeleteButton } from '@/components/admin/admin-form'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Label, Textarea } from '@/components/ui/field'
import { Alert } from '@/components/ui/feedback'
import {
  archiveCampaignAction,
  archiveMediaAction,
  replaceMediaAction,
  saveBadgeAction,
  saveCampaignAction,
  saveCollectionAction,
  saveHomepageSectionAction,
  saveMediaAction,
  toggleCollectionProductAction,
  toggleProductBadgeAction,
} from '@/lib/cms/actions'
import type { ActionResult } from '@/lib/result'
import { cn } from '@/lib/utils'

/**
 * CMS admin forms.
 *
 * Admin sits at 5% brand intensity (DESIGN.md §9) — type, hairlines, tabular
 * data. Every control here is from the frozen design system; nothing new is
 * invented.
 *
 * Client Components because they hold form state. None of them read the session
 * or the database: authorization happens in the Server Component that renders
 * them and again inside every action.
 */

const selectClass = cn(
  'h-11 w-full rounded-md bg-ink-700 px-3 font-ui text-base text-white',
  'border-solid border-ink [border-width:var(--outline-ink)]',
)

/** ISO → the `datetime-local` value shape, in the browser's own zone. */
function toLocalInput(date: Date | string | null | undefined): string {
  if (!date) return ''
  const value = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}

/**
 * The publishing window — the one control that makes scheduling work.
 *
 * Status plus an optional start and end. Whether something is live is computed
 * from these at read time, so "publish on Friday at 9am" needs no cron: set
 * `scheduled` with a start date and it goes live on its own.
 */
function PublishFields({
  keyPrefix,
  status,
  publishAt,
  unpublishAt,
  priority,
  errors,
}: {
  keyPrefix: string
  status?: string
  publishAt?: Date | string | null
  unpublishAt?: Date | string | null
  priority?: number
  errors?: Record<string, string[]>
}) {
  return (
    <fieldset className="flex flex-col gap-4 border-t border-ink-600 pt-4">
      <legend className="font-data text-xs tracking-widest text-smoke uppercase">
        Scheduling
      </legend>

      <div className="grid gap-4 sm:grid-cols-4">
        <Field id={`${keyPrefix}-status`} label="Status" required>
          {(props) => (
            <select name="status" defaultValue={status ?? 'draft'} className={selectClass} {...props}>
              <option value="draft">Draft — never live</option>
              <option value="scheduled">Scheduled — live inside the window</option>
              <option value="published">Published — live now</option>
              <option value="archived">Archived — retired</option>
            </select>
          )}
        </Field>

        <Field
          id={`${keyPrefix}-publish`}
          label="Starts"
          hint="Leave blank for immediately"
          error={errors?.publishAt?.[0]}
        >
          {(props) => (
            <Input type="datetime-local" name="publishAt" defaultValue={toLocalInput(publishAt)} {...props} />
          )}
        </Field>

        <Field
          id={`${keyPrefix}-unpublish`}
          label="Ends"
          hint="Leave blank for never"
          error={errors?.unpublishAt?.[0]}
        >
          {(props) => (
            <Input type="datetime-local" name="unpublishAt" defaultValue={toLocalInput(unpublishAt)} {...props} />
          )}
        </Field>

        <Field id={`${keyPrefix}-priority`} label="Priority" hint="Higher wins ties">
          {(props) => (
            <Input type="number" name="priority" defaultValue={String(priority ?? 0)} {...props} />
          )}
        </Field>
      </div>
    </fieldset>
  )
}

/** Live / scheduled / draft, using the frozen Badge variants. */
export function StatusPill({ status, liveNow }: { status: string; liveNow?: boolean }) {
  if (liveNow) return <Badge variant="signal">Live now</Badge>
  if (status === 'scheduled') return <Badge variant="ember">Scheduled</Badge>
  if (status === 'archived') return <Badge variant="outline">Archived</Badge>
  if (status === 'published') return <Badge variant="smoke">Published — outside window</Badge>
  return <Badge variant="smoke">Draft</Badge>
}

/* -------------------------------------------------------------------------- */

type CampaignValues = {
  id: string
  slug: string
  type: string
  title: string
  subtitle: string | null
  body: string | null
  ctaLabel: string | null
  ctaHref: string | null
  heroMediaId: string | null
  status: string
  publishAt: Date | string | null
  unpublishAt: Date | string | null
  priority: number
}

const CAMPAIGN_TYPES = [
  ['hero', 'Hero'],
  ['new_drop', 'New Drop'],
  ['weekend_sale', 'Weekend Sale'],
  ['staff_pick', 'Staff Pick'],
  ['limited_supply', 'Limited Supply'],
  ['holiday', 'Holiday'],
  ['brand_collab', 'Brand Collaboration'],
  ['announcement', 'Announcement (bar)'],
] as const

export function CampaignForm({
  campaign,
  media,
}: {
  campaign?: CampaignValues
  media: Array<{ id: string; title: string | null; altText: string }>
}) {
  const key = campaign?.id ?? 'new'
  return (
    <AdminForm
      action={saveCampaignAction}
      submitLabel={campaign ? 'Save campaign' : 'Create campaign'}
      successMessage="Campaign saved."
      secondary={
        campaign ? (
          <DeleteButton
            action={archiveCampaignAction}
            hiddenFields={{ id: campaign.id }}
            label="Archive"
            confirmMessage={`Archive "${campaign.title}"? It stops appearing immediately.`}
          />
        ) : undefined
      }
    >
      {(errors) => (
        <>
          {campaign && <input type="hidden" name="id" value={campaign.id} />}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`c-title-${key}`} label="Title" error={errors?.title?.[0]} required>
              {(props) => <Input name="title" defaultValue={campaign?.title ?? ''} {...props} />}
            </Field>
            <Field id={`c-slug-${key}`} label="Slug" error={errors?.slug?.[0]} required>
              {(props) => <Input name="slug" defaultValue={campaign?.slug ?? ''} {...props} />}
            </Field>
            <Field id={`c-type-${key}`} label="Type" required>
              {(props) => (
                <select name="type" defaultValue={campaign?.type ?? 'hero'} className={selectClass} {...props}>
                  {CAMPAIGN_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <Field id={`c-sub-${key}`} label="Subtitle" error={errors?.subtitle?.[0]}>
            {(props) => <Input name="subtitle" defaultValue={campaign?.subtitle ?? ''} {...props} />}
          </Field>

          <Field
            id={`c-body-${key}`}
            label="Message"
            hint="Used by the announcement bar"
            error={errors?.body?.[0]}
          >
            {(props) => <Textarea name="body" defaultValue={campaign?.body ?? ''} {...props} />}
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`c-cta-${key}`} label="CTA label">
              {(props) => <Input name="ctaLabel" defaultValue={campaign?.ctaLabel ?? ''} {...props} />}
            </Field>
            <Field
              id={`c-href-${key}`}
              label="CTA link"
              hint="Path on this site, e.g. /shop"
              error={errors?.ctaHref?.[0]}
            >
              {(props) => <Input name="ctaHref" defaultValue={campaign?.ctaHref ?? ''} {...props} />}
            </Field>
            <Field id={`c-media-${key}`} label="Hero artwork">
              {(props) => (
                <select name="heroMediaId" defaultValue={campaign?.heroMediaId ?? ''} className={selectClass} {...props}>
                  <option value="">None</option>
                  {media.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.title ?? asset.altText ?? asset.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <PublishFields
            keyPrefix={`c-${key}`}
            status={campaign?.status}
            publishAt={campaign?.publishAt}
            unpublishAt={campaign?.unpublishAt}
            priority={campaign?.priority}
            errors={errors}
          />
        </>
      )}
    </AdminForm>
  )
}

/* -------------------------------------------------------------------------- */

export function CollectionForm({
  collection,
}: {
  collection?: {
    id: string
    slug: string
    name: string
    description: string | null
    status: string
    publishAt: Date | string | null
    unpublishAt: Date | string | null
    priority: number
  }
}) {
  const key = collection?.id ?? 'new'
  return (
    <AdminForm
      action={saveCollectionAction}
      submitLabel={collection ? 'Save collection' : 'Create collection'}
      successMessage="Collection saved."
    >
      {(errors) => (
        <>
          {collection && <input type="hidden" name="id" value={collection.id} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`col-name-${key}`} label="Name" error={errors?.name?.[0]} required>
              {(props) => <Input name="name" defaultValue={collection?.name ?? ''} {...props} />}
            </Field>
            <Field id={`col-slug-${key}`} label="Slug" error={errors?.slug?.[0]} required>
              {(props) => <Input name="slug" defaultValue={collection?.slug ?? ''} {...props} />}
            </Field>
          </div>
          <Field id={`col-desc-${key}`} label="Description">
            {(props) => <Textarea name="description" defaultValue={collection?.description ?? ''} {...props} />}
          </Field>
          <PublishFields
            keyPrefix={`col-${key}`}
            status={collection?.status}
            publishAt={collection?.publishAt}
            unpublishAt={collection?.unpublishAt}
            priority={collection?.priority}
            errors={errors}
          />
        </>
      )}
    </AdminForm>
  )
}

/**
 * Product membership toggles.
 *
 * One tiny form per product rather than a multi-select, so each toggle is an
 * independent action that works without JavaScript and cannot lose the rest of
 * the selection if one write fails.
 */
export function MembershipToggles({
  parentField,
  parentId,
  childField,
  items,
  selected,
  action,
}: {
  parentField: string
  parentId: string
  childField: string
  items: Array<{ id: string; name: string; status?: string }>
  selected: string[]
  action: (
    previous: ActionResult<void> | null,
    formData: FormData,
  ) => Promise<ActionResult<void>>
}) {
  const [state, formAction] = useActionState<ActionResult<void> | null, FormData>(action, null)
  const selectedSet = new Set(selected)

  return (
    <div className="flex flex-col gap-3">
      {state && !state.ok && (
        <Alert tone="error" title="Could not update">
          {state.message}
        </Alert>
      )}
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => {
          const isSelected = selectedSet.has(item.id)
          return (
            <li key={item.id}>
              <form action={formAction}>
                <input type="hidden" name={parentField} value={parentId} />
                <input type="hidden" name={childField} value={item.id} />
                <input type="hidden" name="add" value={isSelected ? '0' : '1'} />
                <Button
                  type="submit"
                  size="sm"
                  variant={isSelected ? 'confirm' : 'outline'}
                  aria-pressed={isSelected}
                >
                  {isSelected ? '✓ ' : '+ '}
                  {item.name}
                  {item.status && item.status !== 'active' ? ` (${item.status})` : ''}
                </Button>
              </form>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

const BADGE_VARIANTS = ['ember', 'volt', 'flare', 'cream', 'smoke', 'outline'] as const

export function BadgeForm({
  badge,
}: {
  badge?: {
    id: string
    slug: string
    label: string
    icon: string | null
    variant: string
    description: string | null
    active: boolean
    priority: number
  }
}) {
  const key = badge?.id ?? 'new'
  return (
    <AdminForm
      action={saveBadgeAction}
      submitLabel={badge ? 'Save badge' : 'Create badge'}
      successMessage="Badge saved."
    >
      {(errors) => (
        <>
          {badge && <input type="hidden" name="id" value={badge.id} />}
          <div className="grid gap-4 sm:grid-cols-4">
            <Field id={`b-label-${key}`} label="Label" error={errors?.label?.[0]} required>
              {(props) => <Input name="label" defaultValue={badge?.label ?? ''} {...props} />}
            </Field>
            <Field id={`b-slug-${key}`} label="Slug" error={errors?.slug?.[0]} required>
              {(props) => <Input name="slug" defaultValue={badge?.slug ?? ''} {...props} />}
            </Field>
            <Field id={`b-icon-${key}`} label="Icon" hint="Optional emoji">
              {(props) => <Input name="icon" defaultValue={badge?.icon ?? ''} {...props} />}
            </Field>
            <Field id={`b-variant-${key}`} label="Colour" required>
              {(props) => (
                <select name="variant" defaultValue={badge?.variant ?? 'ember'} className={selectClass} {...props}>
                  {BADGE_VARIANTS.map((variant) => (
                    <option key={variant} value={variant}>{variant}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <Field id={`b-desc-${key}`} label="Description">
            {(props) => <Input name="description" defaultValue={badge?.description ?? ''} {...props} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`b-priority-${key}`} label="Priority" hint="Higher shows first on a card">
              {(props) => <Input type="number" name="priority" defaultValue={String(badge?.priority ?? 0)} {...props} />}
            </Field>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-white">
                <input
                  type="checkbox"
                  name="active"
                  value="true"
                  defaultChecked={badge?.active ?? true}
                  className="size-5 rounded-sm border-2 border-ink bg-ink-700 accent-volt"
                />
                Active
              </label>
            </div>
          </div>
        </>
      )}
    </AdminForm>
  )
}

/* -------------------------------------------------------------------------- */

const SECTION_TYPES = [
  ['hero', 'Hero'],
  ['announcement_bar', 'Announcement bar'],
  ['featured_products', 'Featured products'],
  ['collections', 'Collections'],
  ['categories', 'Categories'],
  ['promotions', 'Promotions'],
] as const

export function HomepageSectionForm({
  section,
  campaigns,
  collections,
}: {
  section?: {
    id: string
    type: string
    name: string
    heading: string | null
    eyebrow: string | null
    subheading: string | null
    campaignId: string | null
    collectionId: string | null
    sortOrder: number
    status: string
    publishAt: Date | string | null
    unpublishAt: Date | string | null
    priority: number
  }
  campaigns: Array<{ id: string; title: string }>
  collections: Array<{ id: string; name: string }>
}) {
  const key = section?.id ?? 'new'
  return (
    <AdminForm
      action={saveHomepageSectionAction}
      submitLabel={section ? 'Save section' : 'Add section'}
      successMessage="Homepage section saved."
    >
      {(errors) => (
        <>
          {section && <input type="hidden" name="id" value={section.id} />}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`s-name-${key}`} label="Name" hint="Internal label" error={errors?.name?.[0]} required>
              {(props) => <Input name="name" defaultValue={section?.name ?? ''} {...props} />}
            </Field>
            <Field id={`s-type-${key}`} label="Section" required>
              {(props) => (
                <select name="type" defaultValue={section?.type ?? 'featured_products'} className={selectClass} {...props}>
                  {SECTION_TYPES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={`s-sort-${key}`} label="Order">
              {(props) => <Input type="number" name="sortOrder" defaultValue={String(section?.sortOrder ?? 0)} {...props} />}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`s-eyebrow-${key}`} label="Eyebrow">
              {(props) => <Input name="eyebrow" defaultValue={section?.eyebrow ?? ''} {...props} />}
            </Field>
            <Field id={`s-heading-${key}`} label="Heading">
              {(props) => <Input name="heading" defaultValue={section?.heading ?? ''} {...props} />}
            </Field>
            <Field id={`s-subheading-${key}`} label="Subheading">
              {(props) => <Input name="subheading" defaultValue={section?.subheading ?? ''} {...props} />}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`s-campaign-${key}`} label="Campaign" hint="For hero and promotions">
              {(props) => (
                <select name="campaignId" defaultValue={section?.campaignId ?? ''} className={selectClass} {...props}>
                  <option value="">None</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>{campaign.title}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={`s-collection-${key}`} label="Collection" hint="For featured products">
              {(props) => (
                <select name="collectionId" defaultValue={section?.collectionId ?? ''} className={selectClass} {...props}>
                  <option value="">None — use featured flag</option>
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>{collection.name}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <PublishFields
            keyPrefix={`s-${key}`}
            status={section?.status}
            publishAt={section?.publishAt}
            unpublishAt={section?.unpublishAt}
            priority={section?.priority}
            errors={errors}
          />
        </>
      )}
    </AdminForm>
  )
}

/* -------------------------------------------------------------------------- */

export function MediaForm({
  asset,
}: {
  asset?: {
    id: string
    url: string
    title: string | null
    altText: string
    focalX: string
    focalY: string
  }
}) {
  const key = asset?.id ?? 'new'
  return (
    <AdminForm
      action={saveMediaAction}
      submitLabel={asset ? 'Save asset' : 'Add asset'}
      successMessage="Asset saved."
      secondary={
        asset ? (
          <DeleteButton
            action={archiveMediaAction}
            hiddenFields={{ id: asset.id }}
            label="Archive"
            confirmMessage="Archive this asset? It stays resolvable for anything already using it."
          />
        ) : undefined
      }
    >
      {(errors) => (
        <>
          {asset && <input type="hidden" name="id" value={asset.id} />}
          <Field id={`m-url-${key}`} label="URL" error={errors?.url?.[0]} required>
            {(props) => <Input name="url" defaultValue={asset?.url ?? ''} {...props} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`m-title-${key}`} label="Title" hint="Editor-facing name">
              {(props) => <Input name="title" defaultValue={asset?.title ?? ''} {...props} />}
            </Field>
            <Field
              id={`m-alt-${key}`}
              label="Alt text"
              hint="Leave blank only if purely decorative"
              error={errors?.altText?.[0]}
            >
              {(props) => <Input name="altText" defaultValue={asset?.altText ?? ''} {...props} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`m-fx-${key}`}>Focal point X</Label>
              <Input
                id={`m-fx-${key}`}
                name="focalX"
                type="range"
                min="0"
                max="1"
                step="0.01"
                defaultValue={asset?.focalX ?? '0.5'}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`m-fy-${key}`}>Focal point Y</Label>
              <Input
                id={`m-fy-${key}`}
                name="focalY"
                type="range"
                min="0"
                max="1"
                step="0.01"
                defaultValue={asset?.focalY ?? '0.5'}
              />
            </div>
          </div>
        </>
      )}
    </AdminForm>
  )
}

/** Replace: inserts a new asset and retires the old one, preserving lineage. */
export function ReplaceMediaForm({ assetId }: { assetId: string }) {
  const [state, formAction] = useActionState<ActionResult<void> | null, FormData>(
    replaceMediaAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-2">
      {state && !state.ok && (
        <Alert tone="error" title="Could not replace">
          {state.message}
        </Alert>
      )}
      <input type="hidden" name="id" value={assetId} />
      <div className="flex gap-2">
        <Input name="url" placeholder="New asset URL" aria-label="Replacement URL" />
        <Button type="submit" variant="outline" size="sm">
          Replace
        </Button>
      </div>
    </form>
  )
}

export { toggleCollectionProductAction, toggleProductBadgeAction }
