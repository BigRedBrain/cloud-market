'use client'

import { AdminForm, DeleteButton } from '@/components/admin/admin-form'
import { Field, Input, Textarea } from '@/components/ui/field'
import {
  deleteBrandAction,
  deleteCategoryAction,
  deleteProductAction,
  deleteVariantAction,
  saveBrandAction,
  saveCategoryAction,
  saveProductAction,
  saveVariantAction,
} from '@/lib/catalog/admin-actions'
import { cn } from '@/lib/utils'

/**
 * Concrete admin forms.
 *
 * Client Components because they hold form state — but none of them read the
 * session or the database. Authorization happens in the Server Component that
 * renders them and again inside every action, which is the only layer that
 * counts.
 */

const selectClass = cn(
  'h-11 w-full rounded-md bg-ink-700 px-3 font-ui text-base text-white',
  'border-solid border-ink [border-width:var(--outline-ink)]',
)

function Checkbox({
  name,
  label,
  defaultChecked,
}: {
  name: string
  label: string
  defaultChecked?: boolean
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-white">
      <input
        type="checkbox"
        name={name}
        value="true"
        defaultChecked={defaultChecked}
        className="size-5 rounded-sm border-2 border-ink bg-ink-700 accent-volt"
      />
      {label}
    </label>
  )
}

/* -------------------------------------------------------------------------- */

export function BrandForm({
  brand,
}: {
  brand?: { id: string; slug: string; name: string; description: string | null; active: boolean }
}) {
  return (
    <AdminForm
      action={saveBrandAction}
      submitLabel={brand ? 'Save brand' : 'Create brand'}
      successMessage="Brand saved."
      secondary={
        brand ? (
          <DeleteButton
            action={deleteBrandAction}
            hiddenFields={{ id: brand.id }}
            confirmMessage={`Delete "${brand.name}"? Products must be moved or archived first.`}
          />
        ) : undefined
      }
    >
      {(errors) => (
        <>
          {brand && <input type="hidden" name="id" value={brand.id} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`brand-name-${brand?.id ?? 'new'}`} label="Name" error={errors?.name?.[0]} required>
              {(props) => <Input name="name" defaultValue={brand?.name ?? ''} {...props} />}
            </Field>
            <Field id={`brand-slug-${brand?.id ?? 'new'}`} label="Slug" error={errors?.slug?.[0]} required>
              {(props) => <Input name="slug" defaultValue={brand?.slug ?? ''} {...props} />}
            </Field>
          </div>
          <Field id={`brand-desc-${brand?.id ?? 'new'}`} label="Description">
            {(props) => <Textarea name="description" defaultValue={brand?.description ?? ''} {...props} />}
          </Field>
          <Checkbox name="active" label="Active" defaultChecked={brand?.active ?? true} />
        </>
      )}
    </AdminForm>
  )
}

/* -------------------------------------------------------------------------- */

export function CategoryForm({
  category,
}: {
  category?: {
    id: string
    slug: string
    name: string
    description: string | null
    sortOrder: number
    active: boolean
  }
}) {
  const key = category?.id ?? 'new'
  return (
    <AdminForm
      action={saveCategoryAction}
      submitLabel={category ? 'Save category' : 'Create category'}
      successMessage="Category saved."
      secondary={
        category ? (
          <DeleteButton
            action={deleteCategoryAction}
            hiddenFields={{ id: category.id }}
            confirmMessage={`Delete "${category.name}"? Products must be moved or archived first.`}
          />
        ) : undefined
      }
    >
      {(errors) => (
        <>
          {category && <input type="hidden" name="id" value={category.id} />}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`cat-name-${key}`} label="Name" error={errors?.name?.[0]} required>
              {(props) => <Input name="name" defaultValue={category?.name ?? ''} {...props} />}
            </Field>
            <Field id={`cat-slug-${key}`} label="Slug" error={errors?.slug?.[0]} required>
              {(props) => <Input name="slug" defaultValue={category?.slug ?? ''} {...props} />}
            </Field>
            <Field id={`cat-sort-${key}`} label="Sort order" error={errors?.sortOrder?.[0]}>
              {(props) => (
                <Input
                  name="sortOrder"
                  type="number"
                  inputMode="numeric"
                  defaultValue={String(category?.sortOrder ?? 0)}
                  {...props}
                />
              )}
            </Field>
          </div>
          <Field id={`cat-desc-${key}`} label="Description">
            {(props) => <Textarea name="description" defaultValue={category?.description ?? ''} {...props} />}
          </Field>
          <Checkbox name="active" label="Active" defaultChecked={category?.active ?? true} />
        </>
      )}
    </AdminForm>
  )
}

/* -------------------------------------------------------------------------- */

type ProductFormValues = {
  id: string
  slug: string
  name: string
  shortDescription: string | null
  description: string | null
  brandId: string
  categoryId: string
  status: string
  featured: boolean
  newArrival: boolean
  strainType: string | null
  thcPercent: string | null
  cbdPercent: string | null
  genetics: string | null
  effects: string[] | null
  flavors: string[] | null
  labTestReference: string | null
}

export function ProductForm({
  product,
  brands,
  categories,
}: {
  product?: ProductFormValues
  brands: Array<{ id: string; name: string }>
  categories: Array<{ id: string; name: string }>
}) {
  const key = product?.id ?? 'new'

  return (
    <AdminForm
      action={saveProductAction}
      submitLabel={product ? 'Save product' : 'Create product'}
      successMessage="Product saved."
      secondary={
        product ? (
          <DeleteButton
            action={deleteProductAction}
            hiddenFields={{ id: product.id }}
            confirmMessage={`Delete "${product.name}"? It will be archived and hidden from the shop.`}
          />
        ) : undefined
      }
    >
      {(errors) => (
        <>
          {product && <input type="hidden" name="id" value={product.id} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`p-name-${key}`} label="Name" error={errors?.name?.[0]} required>
              {(props) => <Input name="name" defaultValue={product?.name ?? ''} {...props} />}
            </Field>
            <Field id={`p-slug-${key}`} label="Slug" error={errors?.slug?.[0]} required>
              {(props) => <Input name="slug" defaultValue={product?.slug ?? ''} {...props} />}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`p-brand-${key}`} label="Brand" error={errors?.brandId?.[0]} required>
              {(props) => (
                <select name="brandId" defaultValue={product?.brandId ?? ''} className={selectClass} {...props}>
                  <option value="">Choose…</option>
                  {brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>{brand.name}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={`p-cat-${key}`} label="Category" error={errors?.categoryId?.[0]} required>
              {(props) => (
                <select name="categoryId" defaultValue={product?.categoryId ?? ''} className={selectClass} {...props}>
                  <option value="">Choose…</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.name}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field id={`p-status-${key}`} label="Status" error={errors?.status?.[0]} required>
              {(props) => (
                <select name="status" defaultValue={product?.status ?? 'draft'} className={selectClass} {...props}>
                  <option value="draft">Draft — hidden from shop</option>
                  <option value="active">Active — live</option>
                  <option value="archived">Archived — retired</option>
                </select>
              )}
            </Field>
          </div>

          <Field id={`p-short-${key}`} label="Short description" error={errors?.shortDescription?.[0]}>
            {(props) => <Input name="shortDescription" defaultValue={product?.shortDescription ?? ''} {...props} />}
          </Field>

          <Field id={`p-desc-${key}`} label="Description">
            {(props) => <Textarea name="description" defaultValue={product?.description ?? ''} {...props} />}
          </Field>

          <fieldset className="flex flex-col gap-4 border-t border-ink-600 pt-4">
            <legend className="font-data text-xs tracking-widest text-smoke uppercase">
              Cannabis attributes
            </legend>

            <div className="grid gap-4 sm:grid-cols-4">
              <Field id={`p-strain-${key}`} label="Strain type">
                {(props) => (
                  <select name="strainType" defaultValue={product?.strainType ?? ''} className={selectClass} {...props}>
                    <option value="">None</option>
                    <option value="indica">Indica</option>
                    <option value="">None</option>
                    <option value="indica">Indica</option>
                    <option value="sativa">Sativa</option>
                    <option value="hybrid">Hybrid</option>
                    <option value="hybrid_i">Hybrid I</option>
                    <option value="hybrid_s">Hybrid S</option>
                    <option value="cbd">CBD</option>
                  </select>
                )}
              </Field>
              <Field id={`p-thc-${key}`} label="THC %" error={errors?.thcPercent?.[0]}>
                {(props) => <Input name="thcPercent" inputMode="decimal" defaultValue={product?.thcPercent ?? ''} {...props} />}
              </Field>
              <Field id={`p-cbd-${key}`} label="CBD %" error={errors?.cbdPercent?.[0]}>
                {(props) => <Input name="cbdPercent" inputMode="decimal" defaultValue={product?.cbdPercent ?? ''} {...props} />}
              </Field>
              <Field id={`p-lab-${key}`} label="Lab test ref">
                {(props) => <Input name="labTestReference" defaultValue={product?.labTestReference ?? ''} {...props} />}
              </Field>
            </div>

            <Field id={`p-genetics-${key}`} label="Genetics" hint="e.g. Zkittlez × Gelato">
              {(props) => <Input name="genetics" defaultValue={product?.genetics ?? ''} {...props} />}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`p-effects-${key}`} label="Effects" hint="Comma separated">
                {(props) => <Input name="effects" defaultValue={product?.effects?.join(', ') ?? ''} {...props} />}
              </Field>
              <Field id={`p-flavors-${key}`} label="Flavours" hint="Comma separated">
                {(props) => <Input name="flavors" defaultValue={product?.flavors?.join(', ') ?? ''} {...props} />}
              </Field>
            </div>
          </fieldset>

          <div className="flex flex-wrap gap-5 border-t border-ink-600 pt-4">
            <Checkbox name="featured" label="Featured" defaultChecked={product?.featured} />
            <Checkbox name="newArrival" label="New arrival" defaultChecked={product?.newArrival} />
          </div>
        </>
      )}
    </AdminForm>
  )
}

/* -------------------------------------------------------------------------- */

export function VariantForm({
  productId,
  variant,
}: {
  productId: string
  variant?: {
    id: string
    sku: string
    label: string
    weightGrams: string | null
    priceCents: number
    compareAtPriceCents: number | null
    inventoryQuantity: number
    active: boolean
    sortOrder: number
  }
}) {
  const key = variant?.id ?? 'new'
  const dollars = (cents: number | null | undefined) =>
    cents === null || cents === undefined ? '' : (cents / 100).toFixed(2)

  return (
    <AdminForm
      action={saveVariantAction}
      submitLabel={variant ? 'Save variant' : 'Add variant'}
      successMessage="Variant saved."
      secondary={
        variant ? (
          <DeleteButton
            action={deleteVariantAction}
            hiddenFields={{ id: variant.id, productId }}
            confirmMessage={`Delete variant "${variant.label}" (${variant.sku})? The SKU stays reserved.`}
          />
        ) : undefined
      }
    >
      {(errors) => (
        <>
          <input type="hidden" name="productId" value={productId} />
          {variant && <input type="hidden" name="id" value={variant.id} />}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={`v-label-${key}`} label="Label" hint="3.5g, 10 pk, Large" error={errors?.label?.[0]} required>
              {(props) => <Input name="label" defaultValue={variant?.label ?? ''} {...props} />}
            </Field>
            <Field id={`v-sku-${key}`} label="SKU" error={errors?.sku?.[0]} required>
              {(props) => <Input name="sku" defaultValue={variant?.sku ?? ''} {...props} />}
            </Field>
            <Field id={`v-weight-${key}`} label="Weight (g)" error={errors?.weightGrams?.[0]}>
              {(props) => <Input name="weightGrams" inputMode="decimal" defaultValue={variant?.weightGrams ?? ''} {...props} />}
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            <Field id={`v-price-${key}`} label="Price ($)" error={errors?.price?.[0]} required>
              {(props) => <Input name="price" inputMode="decimal" defaultValue={dollars(variant?.priceCents)} {...props} />}
            </Field>
            <Field id={`v-compare-${key}`} label="Compare at ($)" error={errors?.compareAtPrice?.[0]}>
              {(props) => (
                <Input name="compareAtPrice" inputMode="decimal" defaultValue={dollars(variant?.compareAtPriceCents)} {...props} />
              )}
            </Field>
            <Field id={`v-stock-${key}`} label="Stock" error={errors?.inventoryQuantity?.[0]} required>
              {(props) => (
                <Input
                  name="inventoryQuantity"
                  type="number"
                  inputMode="numeric"
                  defaultValue={String(variant?.inventoryQuantity ?? 0)}
                  {...props}
                />
              )}
            </Field>
            <Field id={`v-sort-${key}`} label="Sort order">
              {(props) => (
                <Input name="sortOrder" type="number" inputMode="numeric" defaultValue={String(variant?.sortOrder ?? 0)} {...props} />
              )}
            </Field>
          </div>

          <Checkbox name="active" label="Active" defaultChecked={variant?.active ?? true} />
        </>
      )}
    </AdminForm>
  )
}
