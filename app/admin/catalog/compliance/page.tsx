import type { Metadata } from 'next'

import {
  CatalogComplianceWorkbench,
  type ComplianceRow,
} from '@/components/admin/catalog-compliance'
import { Alert } from '@/components/ui/feedback'
import { requirePermission } from '@/lib/auth/dal'
import { CLASSIFICATION_MATRIX, loadVariantCompliance } from '@/lib/catalog/compliance'
import { SUPPORTED_CANNABIS_CLASSES } from '@/lib/orders/limits'

export const metadata: Metadata = {
  title: 'Catalog compliance',
  robots: { index: false, follow: false },
}

/**
 * Catalog compliance — classifying what each product physically is.
 *
 * Gated on `catalog_compliance_admin`, a grant that is deliberately NOT implied
 * by the admin role and is separate from `compliance_admin`. Publishing the
 * legal caps and deciding which cap a product falls under are different jobs,
 * usually held by different people; combining them would mean anyone who could
 * classify a product could also move the rule it is measured against.
 *
 * The page renders its own `<main>`, like every other admin route.
 */
export default async function CatalogCompliancePage() {
  await requirePermission('catalog_compliance_admin')

  /**
   * Inactive variants are included deliberately. A product being drafted is
   * exactly when its classification should be settled — leaving it until
   * activation means the first person to notice is a customer whose bag refuses
   * the item.
   */
  const variants = await loadVariantCompliance({ includeInactive: true })

  const rows: ComplianceRow[] = variants.map((v) => ({
    variantId: v.variantId,
    sku: v.sku,
    label: v.label,
    productName: v.productName,
    active: v.active && v.productActive,
    cannabisClass: v.cannabisClass,
    measurementBasis: v.measurementBasis,
    measurementValue: v.measurementValue,
    measurementUnit: v.measurementUnit,
    usableEquivalentGrams: v.usableEquivalentGrams,
    concentrateGrams: v.concentrateGrams,
    immaturePlantCount: v.immaturePlantCount,
    ready: v.ready,
    rejectionKind: v.rejection?.kind ?? null,
    reason: v.reason,
  }))

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="mb-2 font-display text-2xl tracking-tight text-white uppercase">
        Catalog compliance
      </h1>
      <p className="mb-6 max-w-3xl text-sm text-smoke">
        What each variant physically is, and how it is measured. These values
        decide which legal cap a product counts against, so they are entered by
        hand and audited — nothing here is inferred from a product name, a
        category, a description or a THC figure.
      </p>

      <div className="mb-6">
        <Alert tone="info" title="Corrections are safe; history is not rewritten">
          A classification can be corrected at any time. Order lines snapshot the
          values used for their own transaction, so a correction changes what
          will be sold next — never what was sold before.
        </Alert>
      </div>

      <CatalogComplianceWorkbench
        rows={rows}
        matrix={CLASSIFICATION_MATRIX}
        classes={SUPPORTED_CANNABIS_CLASSES}
      />
    </main>
  )
}
