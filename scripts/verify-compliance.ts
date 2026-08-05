/**
 * Michigan purchase-limit compliance.
 *
 *   npx tsx scripts/verify-compliance.ts
 *
 * Pure calculation, no database, no server — `lib/orders/limits.ts` and
 * `lib/orders/exact.ts` have no I/O precisely so this can hammer them.
 *
 * WHAT IS BEING PROVED, and why each case is here rather than assumed:
 *
 *   - concentrate is 1:1 by gram weight AND separately capped at 15 g. The
 *     previous implementation weighted it 5:1 into a single total, which
 *     matched no rule in the guidance and both refused lawful baskets and
 *     permitted unlawful ones.
 *   - infused equivalency is by finished-product mass and volume, never by THC.
 *   - immature plants are counted, capped at 3, and contribute no weight.
 *   - unknown, unclassified, unmeasured and zero-measured cannabis FAIL CLOSED.
 *   - `non_cannabis` is exempt without creating a bypass for anything else.
 *   - the arithmetic is exact: no binary floating point anywhere near a cap.
 */
import {
  CALCULATION_VERSION,
  CLASS_EQUIVALENCE,
  CLASS_MEASUREMENT,
  CRA_DEFAULT_RULES,
  evaluateOrderLimits,
  formatGrams,
  isSupportedClass,
  SUPPORTED_CANNABIS_CLASSES,
  type LimitLineInput,
  type LimitRule,
} from '../lib/orders/limits'
import {
  add,
  compare,
  fromDecimalString,
  multiply,
  rational,
  toFixed,
  toRatioString,
  GRAMS_PER_OUNCE,
  USABLE_CAP_GRAMS,
} from '../lib/orders/exact'

let passed = 0
let failed = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`    ok    ${name}`)
  } else {
    failed += 1
    failures.push(name)
    console.log(`    FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const section = (t: string) => console.log(`\n${t}`)

const RULES: LimitRule[] = CRA_DEFAULT_RULES

/** Builds a line in the class's own legal measurement unit. */
const line = (
  cls: string,
  value: string | null,
  quantity = 1,
  basis?: string | null,
): LimitLineInput => ({
  variantId: `v-${cls}-${value}-${quantity}`,
  quantity,
  cannabisClass: cls,
  measurementValue: value,
  measurementBasis:
    basis === undefined
      ? isSupportedClass(cls)
        ? CLASS_MEASUREMENT[cls].basis
        : null
      : basis,
})

const evaluate = (lines: LimitLineInput[]) => evaluateOrderLimits(lines, RULES)

/* ============================================== 1. EXACT ARITHMETIC ====== */
section('[1] The arithmetic is exact')
{
  check(
    'an ounce is exactly 28.349523125 g',
    toFixed(GRAMS_PER_OUNCE, 9) === '28.349523125',
    toFixed(GRAMS_PER_OUNCE, 9),
  )
  check(
    '2.5 oz is exactly 70.87380781250 g',
    toFixed(USABLE_CAP_GRAMS, 11) === '70.87380781250',
    toFixed(USABLE_CAP_GRAMS, 11),
  )

  /**
   * The case that motivates the whole exact module: in binary floating point
   * 0.1 + 0.2 !== 0.3. If a cap comparison ran on `Number`, a basket assembled
   * from tenths would land on the wrong side of a legal limit for no reason a
   * person could explain.
   */
  check('0.1 + 0.2 is exactly 0.3',
    compare(add(fromDecimalString('0.1'), fromDecimalString('0.2')), fromDecimalString('0.3')) === 0)
  check('and the float version genuinely disagrees', 0.1 + 0.2 !== 0.3)

  /** Summing a third thirty times returns exactly ten, with no drift. */
  let sum = fromDecimalString('0')
  for (let i = 0; i < 30; i += 1) sum = add(sum, rational(1n, 3n))
  check('thirty thirds sum to exactly ten', compare(sum, rational(10n)) === 0, toFixed(sum, 10))

  /**
   * 1 oz = 45359237/1600000 g exactly (a pound is 453.59237 g by definition),
   * so one fluid ounce of liquid infused product is 45359237/57600000 g of
   * usable equivalent. In decimal that is 0.787487... recurring — which is
   * precisely why the conversion is stored as a ratio and not as a number.
   */
  check(
    'an ounce reduces to 45359237/1600000 g',
    toRatioString(GRAMS_PER_OUNCE) === '45359237/1600000',
    toRatioString(GRAMS_PER_OUNCE),
  )
  check(
    'the liquid conversion is a non-terminating fraction, held exactly',
    toRatioString(CLASS_EQUIVALENCE.infused_liquid) === '45359237/57600000',
    toRatioString(CLASS_EQUIVALENCE.infused_liquid),
  )
  check(
    'and it is genuinely non-terminating as a decimal',
    toFixed(CLASS_EQUIVALENCE.infused_liquid, 12) === '0.787486753472',
    toFixed(CLASS_EQUIVALENCE.infused_liquid, 12),
  )
}

/* ================================================ 2. CONCENTRATE ========= */
section('[2] Concentrate: 1:1 by weight, plus its own 15 g ceiling')
{
  const ten = evaluate([line('concentrate', '10.0000')])
  check(
    '10 g of concentrate contributes 10 g to the usable total',
    formatGrams(ten.totalUsableEquivalentGrams) === '10.00000',
    formatGrams(ten.totalUsableEquivalentGrams),
  )
  check(
    '10 g of concentrate contributes 10 g to the concentrate cap',
    formatGrams(ten.totalConcentrateGrams) === '10.00000',
    formatGrams(ten.totalConcentrateGrams),
  )
  check('10 g of concentrate is allowed', ten.allowed)

  const fifteen = evaluate([line('concentrate', '15.0000')])
  check('exactly 15 g of concentrate is allowed', fifteen.allowed, fifteen.reason ?? '')
  check(
    'and the usable total is well under its own cap at that point',
    compare(fifteen.totalUsableEquivalentGrams, USABLE_CAP_GRAMS) < 0,
  )

  const overByAMilligram = evaluate([line('concentrate', '15.0010')])
  check('15.001 g of concentrate is refused', !overByAMilligram.allowed)
  check(
    'and the refusal names the concentrate cap, not the usable one',
    overByAMilligram.breaches.some((b) => b.cap === 'concentrate') &&
      !overByAMilligram.breaches.some((b) => b.cap === 'usable'),
    JSON.stringify(overByAMilligram.breaches),
  )

  const sixteen = evaluate([line('concentrate', '16.0000')])
  check('16 g of concentrate is refused', !sixteen.allowed)

  /**
   * The regression that matters most. Under the old 5:1 weighting, 16 g of
   * concentrate scored 80 g and tripped the USABLE cap — the right answer for
   * the wrong reason. It also meant 15 g scored 75 g and was refused, which was
   * simply wrong. Here 16 g scores 16 g against the usable cap and is refused
   * only by the concentrate ceiling.
   */
  check(
    'the old 5:1 weighting is gone — 16 g scores 16 g, not 80 g',
    formatGrams(sixteen.totalUsableEquivalentGrams) === '16.00000',
    formatGrams(sixteen.totalUsableEquivalentGrams),
  )
  check(
    'so 16 g breaches ONLY the concentrate cap',
    sixteen.breaches.length === 1 && sixteen.breaches[0].cap === 'concentrate',
    JSON.stringify(sixteen.breaches),
  )
}

/* ============================================ 3. FLOWER + CONCENTRATE ==== */
section('[3] Flower and concentrate combine 1:1 toward the usable cap')
{
  const mixed = evaluate([line('flower', '20.0000'), line('concentrate', '10.0000')])
  check(
    '20 g flower + 10 g concentrate = 30 g usable equivalent',
    formatGrams(mixed.totalUsableEquivalentGrams) === '30.00000',
    formatGrams(mixed.totalUsableEquivalentGrams),
  )
  check(
    'and only the concentrate counts toward the concentrate cap',
    formatGrams(mixed.totalConcentrateGrams) === '10.00000',
    formatGrams(mixed.totalConcentrateGrams),
  )
  check('the basket is allowed', mixed.allowed)

  /** Exactly at the usable cap: 70.87380781250 g of flower. */
  const exact = evaluate([line('flower', '70.8738078125')])
  check('exactly 2.5 oz of flower is allowed', exact.allowed, exact.reason ?? '')

  const overByAMicrogram = evaluate([line('flower', '70.8739')])
  check('a hair over 2.5 oz is refused', !overByAMicrogram.allowed)
  check(
    'and it is the usable cap that refuses it',
    overByAMicrogram.breaches.some((b) => b.cap === 'usable'),
  )

  /** Quantity multiplies the per-unit measurement. */
  const many = evaluate([line('flower', '3.5000', 8)])
  check(
    '8 × 3.5 g = 28 g',
    formatGrams(many.totalUsableEquivalentGrams) === '28.00000',
    formatGrams(many.totalUsableEquivalentGrams),
  )
}

/* ================================================ 4. INFUSED SOLID ======= */
section('[4] Solid infused: equivalency by finished-product MASS')
{
  /**
   * The rule is "16 oz of finished product = 1 oz usable", which is a MASS
   * ratio and therefore unit-independent: dividing grams by 16 is the same
   * statement. Asserted on the ratio itself, because 16 oz is 453.59237 g and
   * the measurement column carries four decimal places — the exact quantity is
   * not representable, and rounding it to 453.5924 would make this assertion
   * fail for a reason that has nothing to do with the conversion.
   */
  check(
    'the solid conversion is exactly 1/16 by mass',
    toRatioString(CLASS_EQUIVALENCE.infused_solid) === '1/16',
    toRatioString(CLASS_EQUIVALENCE.infused_solid),
  )

  /** 160 g of finished product = 10 g usable. Exactly representable. */
  const solid = evaluate([line('infused_solid', '160.0000')])
  check(
    '160 g of solid infused product = 10 g usable',
    formatGrams(solid.totalUsableEquivalentGrams) === '10.00000',
    formatGrams(solid.totalUsableEquivalentGrams),
  )
  check('it contributes nothing to the concentrate cap',
    formatGrams(solid.totalConcentrateGrams) === '0.00000')

  /** 100 g of finished product = 6.25 g usable. */
  const hundred = evaluate([line('infused_solid', '100.0000')])
  check(
    '100 g of solid infused product = 6.25 g usable',
    formatGrams(hundred.totalUsableEquivalentGrams) === '6.25000',
    formatGrams(hundred.totalUsableEquivalentGrams),
  )

  /** 40 oz of finished product = 2.5 oz usable, exactly at the cap. */
  const atCap = evaluate([
    line('infused_solid', toFixed(multiply(rational(40n), GRAMS_PER_OUNCE), 4)),
  ])
  check('40 oz of solid infused product sits exactly at the cap', atCap.allowed,
    `${formatGrams(atCap.totalUsableEquivalentGrams)}`)

  const overCap = evaluate([line('infused_solid', '1200.0000')])
  check('1200 g of solid infused product is refused', !overCap.allowed)
}

/* =============================================== 5. INFUSED LIQUID ======= */
section('[5] Liquid infused: equivalency by finished-product VOLUME')
{
  /** 36 fl oz = 1 oz usable. */
  const thirtySix = evaluate([line('infused_liquid', '36.0000')])
  check(
    '36 fl oz of liquid infused product = 1 oz usable',
    formatGrams(thirtySix.totalUsableEquivalentGrams) === toFixed(GRAMS_PER_OUNCE, 5),
    `${formatGrams(thirtySix.totalUsableEquivalentGrams)} vs ${toFixed(GRAMS_PER_OUNCE, 5)}`,
  )

  /** 90 fl oz = 2.5 oz usable, exactly at the cap. */
  const atCap = evaluate([line('infused_liquid', '90.0000')])
  check('90 fl oz sits exactly at the cap', atCap.allowed,
    `${formatGrams(atCap.totalUsableEquivalentGrams)} vs ${formatGrams(USABLE_CAP_GRAMS)}`)
  check(
    'and it equals the cap exactly, not approximately',
    compare(atCap.totalUsableEquivalentGrams, USABLE_CAP_GRAMS) === 0,
  )

  const overCap = evaluate([line('infused_liquid', '90.0001')])
  check('90.0001 fl oz is refused', !overCap.allowed)

  /**
   * The measurement is VOLUME. Feeding the same number through the solid (mass)
   * conversion produces a different answer, which is the whole reason the basis
   * is recorded and checked.
   */
  const asSolid = evaluate([line('infused_solid', '36.0000')])
  check(
    'the same number as mass gives a different — and wrong — answer',
    formatGrams(asSolid.totalUsableEquivalentGrams) !==
      formatGrams(thirtySix.totalUsableEquivalentGrams),
    `${formatGrams(asSolid.totalUsableEquivalentGrams)} vs ${formatGrams(thirtySix.totalUsableEquivalentGrams)}`,
  )

  const wrongBasis = evaluate([
    line('infused_liquid', '36.0000', 1, 'finished_net_weight_grams'),
  ])
  check('a liquid product measured in grams is REFUSED, not converted',
    !wrongBasis.allowed && wrongBasis.rejections[0]?.kind === 'basis_mismatch',
    JSON.stringify(wrongBasis.rejections[0]))
}

/* ================================================= 6. THC IS NOT USED ==== */
section('[6] THC milligrams do not determine equivalency')
{
  /**
   * `LimitLineInput` has no THC field at all, which is the strongest possible
   * form of this guarantee: potency cannot influence the calculation because
   * the calculation cannot see it. Asserted explicitly so that adding one
   * later is a deliberate act that breaks a test.
   */
  const keys = Object.keys(line('infused_solid', '100.0000'))
  check(
    'the limit input carries no THC field',
    !keys.some((k) => /thc|potency|mg/i.test(k)),
    keys.join(','),
  )

  /**
   * Two products of identical finished mass convert identically. If potency
   * were involved, a 100 mg bar and a 10 mg bar of the same weight would
   * differ — and they must not.
   */
  const a = evaluate([line('infused_solid', '100.0000')])
  const b = evaluate([line('infused_solid', '100.0000', 1)])
  check(
    'identical finished mass gives identical equivalency regardless of potency',
    compare(a.totalUsableEquivalentGrams, b.totalUsableEquivalentGrams) === 0,
  )
}

/* ================================================ 7. IMMATURE PLANTS ===== */
section('[7] Immature plants: counted, capped at 3, no weight')
{
  const three = evaluate([line('immature_plant', '1.0000', 3)])
  check('three immature plants are allowed', three.allowed, three.reason ?? '')
  check('they count as 3', three.totalImmaturePlants === 3, String(three.totalImmaturePlants))
  check(
    'and contribute no usable weight',
    formatGrams(three.totalUsableEquivalentGrams) === '0.00000',
  )

  const four = evaluate([line('immature_plant', '1.0000', 4)])
  check('four immature plants are refused', !four.allowed)
  check(
    'and the refusal names the plant cap',
    four.breaches.length === 1 && four.breaches[0].cap === 'immature_plants',
    JSON.stringify(four.breaches),
  )

  /** Plants alongside a full flower basket: independent caps, both apply. */
  const mixed = evaluate([line('flower', '28.0000'), line('immature_plant', '1.0000', 4)])
  check('plants breach independently of a lawful flower quantity', !mixed.allowed)
  check(
    'the flower is not what refused it',
    mixed.breaches.every((b) => b.cap === 'immature_plants'),
    JSON.stringify(mixed.breaches),
  )
}

/* ================================================ 8. FAIL CLOSED ========= */
section('[8] Unknown, unclassified and unmeasured fail closed')
{
  for (const cls of ['other', 'edible', 'widget', '']) {
    const result = evaluate([line(cls, '10.0000', 1, 'net_weight_grams')])
    check(
      `"${cls || '(empty)'}" is refused`,
      !result.allowed && result.rejections[0]?.kind === 'unsupported_class',
      JSON.stringify(result.rejections[0]),
    )
  }

  const noMeasurement = evaluate([line('flower', null)])
  check(
    'flower with no measurement is refused',
    !noMeasurement.allowed && noMeasurement.rejections[0]?.kind === 'missing_measurement',
    JSON.stringify(noMeasurement.rejections[0]),
  )

  const noBasis = evaluate([line('flower', '3.5000', 1, null)])
  check(
    'flower with no measurement basis is refused',
    !noBasis.allowed && noBasis.rejections[0]?.kind === 'missing_measurement',
    JSON.stringify(noBasis.rejections[0]),
  )

  const zero = evaluate([line('flower', '0.0000')])
  check(
    'a cannabis variant measuring zero is refused, not sold as weightless',
    !zero.allowed && zero.rejections[0]?.kind === 'zero_equivalent_cannabis',
    JSON.stringify(zero.rejections[0]),
  )

  const negative = evaluate([line('flower', '-1.0000')])
  check(
    'a negative measurement is refused',
    !negative.allowed && negative.rejections[0]?.kind === 'invalid_measurement',
    JSON.stringify(negative.rejections[0]),
  )

  const noRule = evaluateOrderLimits(
    [line('concentrate', '1.0000')],
    RULES.filter((r) => r.cannabisClass !== 'concentrate'),
  )
  check(
    'a class with no published rule is refused',
    !noRule.allowed && noRule.rejections[0]?.kind === 'no_rule',
    JSON.stringify(noRule.rejections[0]),
  )

  const zeroRule = evaluateOrderLimits(
    [line('flower', '10.0000')],
    RULES.map((r) =>
      r.cannabisClass === 'flower' ? { ...r, equivalence: rational(0n) } : r,
    ),
  )
  check(
    'a published conversion of zero on a cannabis class is refused',
    !zeroRule.allowed && zeroRule.rejections[0]?.kind === 'zero_equivalent_cannabis',
    JSON.stringify(zeroRule.rejections[0]),
  )

  /**
   * A refused line must not simply be omitted from the totals — that is exactly
   * how an unmeasured product ends up sold alongside a lawful one.
   */
  const mixedWithBad = evaluate([line('flower', '10.0000'), line('other', '10.0000')])
  check('one bad line refuses the whole basket', !mixedWithBad.allowed)
}

/* ============================================== 9. NON-CANNABIS ========== */
section('[9] Non-cannabis merchandise is exempt without creating a bypass')
{
  const merch = evaluate([line('non_cannabis', null, 5)])
  check('non-cannabis merchandise is allowed with no measurement', merch.allowed,
    merch.reason ?? '')
  check(
    'and contributes to nothing',
    formatGrams(merch.totalUsableEquivalentGrams) === '0.00000' &&
      formatGrams(merch.totalConcentrateGrams) === '0.00000' &&
      merch.totalImmaturePlants === 0,
  )

  const withCannabis = evaluate([line('flower', '28.0000'), line('non_cannabis', null, 2)])
  check('it sits alongside cannabis without changing the totals',
    formatGrams(withCannabis.totalUsableEquivalentGrams) === '28.00000',
    formatGrams(withCannabis.totalUsableEquivalentGrams))

  /**
   * THE BYPASS THAT MUST NOT EXIST: setting a cannabis product's basis to
   * `exempt` while leaving its class alone. The class is what decides, and a
   * mismatched basis is refused rather than honoured.
   */
  const bypass = evaluate([line('flower', '1000.0000', 1, 'exempt')])
  check(
    'a cannabis class with an exempt basis is REFUSED, not waved through',
    !bypass.allowed && bypass.rejections[0]?.kind === 'basis_mismatch',
    JSON.stringify(bypass.rejections[0]),
  )

  /** And the reverse: non_cannabis carrying a cannabis basis. */
  const reverse = evaluate([line('non_cannabis', '1000.0000', 1, 'net_weight_grams')])
  check(
    'non-cannabis carrying a cannabis basis is refused',
    !reverse.allowed && reverse.rejections[0]?.kind === 'basis_mismatch',
    JSON.stringify(reverse.rejections[0]),
  )
}

/* ============================================= 10. INDEPENDENT CAPS ====== */
section('[10] The three caps are enforced independently')
{
  /** Under all three. */
  const fine = evaluate([
    line('flower', '20.0000'),
    line('concentrate', '10.0000'),
    line('immature_plant', '1.0000', 2),
  ])
  check('a basket under every cap passes', fine.allowed, fine.reason ?? '')

  /** Over the usable cap only. */
  const overUsable = evaluate([line('flower', '80.0000')])
  check('over usable only', !overUsable.allowed &&
    overUsable.breaches.length === 1 && overUsable.breaches[0].cap === 'usable')

  /** Over concentrate only. */
  const overConcentrate = evaluate([line('concentrate', '16.0000')])
  check('over concentrate only', !overConcentrate.allowed &&
    overConcentrate.breaches.length === 1 && overConcentrate.breaches[0].cap === 'concentrate')

  /** Over plants only. */
  const overPlants = evaluate([line('immature_plant', '1.0000', 5)])
  check('over plants only', !overPlants.allowed &&
    overPlants.breaches.length === 1 && overPlants.breaches[0].cap === 'immature_plants')

  /** Over all three at once — every breach reported, not just the first. */
  const overAll = evaluate([
    line('flower', '60.0000'),
    line('concentrate', '20.0000'),
    line('immature_plant', '1.0000', 9),
  ])
  check('all three breaches are reported together', overAll.breaches.length === 3,
    JSON.stringify(overAll.breaches.map((b) => b.cap)))

  /**
   * The property a single weighted score cannot express: a basket that is
   * comfortably inside the usable cap and still unlawful on concentrate.
   */
  const insideUsableOverConcentrate = evaluate([line('concentrate', '20.0000')])
  check(
    'inside the usable cap yet over the concentrate cap is still refused',
    compare(insideUsableOverConcentrate.totalUsableEquivalentGrams, USABLE_CAP_GRAMS) < 0 &&
      !insideUsableOverConcentrate.allowed,
  )
}

/* ============================================ 11. PER TRANSACTION ======== */
section('[11] Limits apply per transaction, not over a rolling window')
{
  /**
   * `evaluateOrderLimits` takes exactly two arguments. The prior-purchases
   * parameter is gone, so a rolling 24-hour total cannot be reintroduced by
   * accident — only by changing this signature, which breaks this assertion.
   */
  check('the evaluator takes no prior-purchases argument',
    evaluateOrderLimits.length === 2, String(evaluateOrderLimits.length))

  const first = evaluate([line('flower', '60.0000')])
  const second = evaluate([line('flower', '60.0000')])
  check('two separate transactions of 60 g each are both allowed',
    first.allowed && second.allowed)
  check('while 120 g in ONE transaction is refused',
    !evaluate([line('flower', '120.0000')]).allowed)
}

/* ============================================ 12. THE MATRIX HOLDS ======= */
section('[12] Every supported class is fully specified')
{
  for (const cls of SUPPORTED_CANNABIS_CLASSES) {
    const spec = CLASS_MEASUREMENT[cls]
    const equivalence = CLASS_EQUIVALENCE[cls]
    check(`${cls} has a measurement basis and unit`,
      Boolean(spec?.basis) && Boolean(spec?.unit))
    check(`${cls} has a conversion`, equivalence !== undefined)

    /** Only the two deliberate exemptions may convert to nothing. */
    const mayBeZero = cls === 'immature_plant' || cls === 'non_cannabis'
    check(
      `${cls} converts to zero only if that is deliberate`,
      (equivalence.n === 0n) === mayBeZero,
      `${toRatioString(equivalence)}, mayBeZero=${mayBeZero}`,
    )
  }

  check('every default rule carries all three caps',
    CRA_DEFAULT_RULES.every(
      (r) => r.usableEquivalentCapGrams && r.concentrateCapGrams && r.immaturePlantCapUnits === 3,
    ))
  check('the calculation version is recorded', CALCULATION_VERSION === 2,
    String(CALCULATION_VERSION))
  check('legacy classes are not supported',
    !isSupportedClass('other') && !isSupportedClass('edible'))
}

console.log('\n==========================================================')
console.log(`RESULT: ${passed} passed, ${failed} failed`)
if (failures.length) for (const f of failures) console.log(`  • ${f}`)
console.log('==========================================================')
process.exit(failed === 0 ? 0 : 1)
