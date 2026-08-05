# Purchase Limit Compliance (Phase 4.3)

Branch `feat/checkout-orders`. Migrations 0008–0015, development only —
production remains on 0007.

> **CHECKOUT MUST REMAIN DISABLED.** The code enforces it: every cannabis line
> fails closed without a supported classification, an authoritative measurement,
> and a published rule. Production has none of the three.

---

## 1. What changed and why

The Michigan CRA guidance resolved two assumptions this system had been carrying
as placeholders, and both were **wrong in ways that mattered**:

| Was | Is | Consequence of the error |
| --- | --- | --- |
| Concentrate weighted **5:1** into one total | **1:1** by gram weight, plus a **separate 15 g cap** | 15 g of concentrate — the legal maximum — scored 75 g and was refused. A weighted score cannot express "inside one cap, at the limit of another". |
| Limits over a **rolling 24 hours** | **Per transaction** | The medical-caregiver model applied to adult-use. Refused lawful customers on a rule that does not exist. |
| `other` factor **0** | `other` is **unsupported**; exemption requires `non_cannabis` | A product left on the default classification sold with **no cap at all**. |
| Edible equivalency by mass, "approximated" | **Solid** by finished mass (16 oz = 1 oz), **liquid** by finished volume (36 fl oz = 1 oz) | One class could not represent two different conversions. |

Two further problems surfaced while implementing it, and both are fixed here:

- **Binary floating point.** An ounce is 28.349523125 g, and the liquid
  conversion is 28.349523125/36 — non-terminating. `Number` cannot hold either
  exactly. All limit arithmetic now runs in exact `bigint` rationals.
- **`weight_grams` was doing two jobs.** It is a merchandising figure — the
  "3.5g" on the label, sometimes the packaged weight including the container.
  A legal calculation cannot depend on which meaning the person entering the
  product had in mind, so the compliance measurement is now its own column with
  one stated meaning.

---

## 2. The classification and measurement matrix

Every sellable variant must carry a **supported class**, the **one measurement
basis that class permits**, and an **authoritative per-unit value**. Anything
else is refused.

| Class | Measurement basis | Unit | Conversion to usable equivalent | Counts toward |
| --- | --- | --- | --- | --- |
| `flower` | `net_weight_grams` | g | **1/1** | usable |
| `concentrate` | `net_weight_grams` | g | **1/1** | usable **and** concentrate |
| `infused_solid` | `finished_net_weight_grams` | g | **1/16** | usable |
| `infused_liquid` | `finished_volume_fluid_ounces` | fl oz | **45359237/57600000** | usable |
| `immature_plant` | `unit_count` | unit | **0/1** | plants only |
| `non_cannabis` | `exempt` | — | **0/1** | nothing |

`edible` and `other` remain in the database enum — Postgres cannot remove a
value and rows reference both — and are **unsupported**: absent from
`SUPPORTED_CANNABIS_CLASSES`, refused by checkout, refused by rule publication,
and reported by the readiness gate.

**Only two classes may convert to zero**, and both say so in their names. A zero
conversion on any other class is refused at publication *and* again at checkout,
because a database restored without the publication checks would otherwise sell
with no cap and nothing would notice.

### The liquid conversion, worked through

36 fl oz = 1 oz usable. An ounce is 45359237/1600000 g exactly (a pound is
453.59237 g by definition). So one fluid ounce contributes

```
45359237/1600000 ÷ 36  =  45359237/57600000  g  =  0.787486753472…  g
```

Non-terminating. Stored as two integers; never as a decimal.

### THC is not used

`LimitLineInput` has **no THC field**. Potency cannot influence equivalency
because the calculation cannot see it — the strongest available form of that
guarantee, and asserted directly so adding one later breaks a test. Two products
of identical finished mass convert identically regardless of potency.

---

## 3. The three caps

Enforced **independently**, at draft creation and again at placement. A basket
must pass **every** one.

| Cap | Value | Exact |
| --- | --- | --- |
| Usable-marijuana equivalent | 2.5 oz | **70.87380781250 g** |
| Concentrate | 15 g | 15 |
| Immature plants | 3 | 3 |

Not compressed into a weighted total. 15 g of concentrate sits well inside the
usable ceiling and is simultaneously at its own legal maximum; one number cannot
say both.

The cap columns are `numeric(18,11)` so 2.5 oz fits **exactly**. At five decimal
places it stored as 70.87381 — two micrograms *above* the legal maximum, which
is the wrong direction to round a cap, and it also made the seed script
non-idempotent because the value it wrote back never matched what it had written.

---

## 4. What an order line records

Enough to reproduce the decision without re-deriving it:

```
cannabis_class            measurement_basis        measurement_value
measurement_unit          usable_equivalent_grams  concentrate_grams
immature_plant_count      purchase_limit_rule_id   calculation_version
equivalence_numerator     equivalence_denominator
```

`calculation_version` is **2**. Version 1 was the weighted-factor, rolling-window
model; a line stamped v1 was decided by different arithmetic and must not be
re-checked as though it were the same question.

Order level: `total_equivalent_grams`, `total_concentrate_grams`,
`total_immature_plants`.

### Timing

| When | Rule applied |
| --- | --- |
| Draft created | The rule in force at that moment |
| **Placement** | Re-resolved — the rule in force **now** |
| After placement | Frozen forever |

A scheduled change can land inside the fifteen-minute draft window. Placement
re-resolves rather than trusting the draft, and the governance suite proves both
halves: the mid-draft change is applied at placement, and an order placed
earlier still cites its own original rule.

---

## 5. Fail-closed points

| Point | Behaviour |
| --- | --- |
| Catalog activation | `verify:catalog` reports every variant that cannot enter checkout |
| Add to checkout | `startCheckoutAction` refuses and audits `PURCHASE_LIMIT_BLOCKED` |
| Draft creation | `resolveLimitRules` then `evaluateOrderLimits` — both refuse |
| Order placement | Re-resolved and re-evaluated inside the placement transaction |

Refused conditions: unsupported class, missing class, missing measurement,
missing basis, basis/class mismatch, zero measurement on a cannabis item,
negative measurement, no rule in force, more than one rule in force, published
conversion of zero on a cannabis class.

**A rejected line refuses the whole basket.** Omitting it from the totals is
exactly how an unmeasured product gets sold alongside a lawful one.

**Placement stays transactional.** A compliance failure returns before the
transaction opens, so no order is created and no inventory allocation is left
stranded.

---

## 6. Rule publication refusals

`validateRuleValues` runs **before** the password is requested, so a bad number
never costs a re-authentication attempt or contends with a colleague's publish.

| Refusal | Condition |
| --- | --- |
| `unsupported_class` | `edible`, `other`, anything not in the matrix |
| `zero_conversion` | Conversion of 0 on a class that contains cannabis |
| `incompatible_units` | Basis does not match the class's one legal basis |
| `invalid_cap` | Any cap ≤ 0, or a non-integer plant cap |
| `would_orphan_class` | A class that is sellable today would stop being |
| `identical` / `before_current` / `effective_in_past` / `concurrent_publish` | Timeline refusals, from earlier phases |

Overlapping windows are impossible at the database level — the exclusion
constraint from migration 0011.

### The confirmation summary

Before publishing, the screen shows the rule **actually in force** (read
server-side, so it cannot be stale) beside the incoming values: version,
conversion as a ratio, all three caps, the measurement basis and unit, whether
the change is immediate or scheduled and in which timezone, and an explicit
statement that a zero conversion would mean no cap at all. Reason and publisher
are required and recorded.

A full graphical diff and two-person approval remain out of scope, as agreed.

---

## 7. Baseline development rule values

Seeded in development by `npm run db:seed:limits:dev -- --confirm --supersede`
(the script refuses production). **These are the CRA
figures and are what production should receive once counsel confirms them.**

| Class | Version | Conversion | Basis | Usable cap | Concentrate cap | Plants |
| --- | --- | --- | --- | --- | --- | --- |
| `flower` | v4 | 1/1 | net_weight_grams | 70.87380781250 | 15 | 3 |
| `concentrate` | v4 | 1/1 | net_weight_grams | 70.87380781250 | 15 | 3 |
| `infused_solid` | v3 | 1/16 | finished_net_weight_grams | 70.87380781250 | 15 | 3 |
| `infused_liquid` | v3 | 45359237/57600000 | finished_volume_fluid_ounces | 70.87380781250 | 15 | 3 |
| `immature_plant` | v3 | 0/1 | unit_count | 70.87380781250 | 15 | 3 |
| `non_cannabis` | v3 | 0/1 | exempt | 70.87380781250 | 15 | 3 |

Legacy `edible` and `other` rows remain open with null conversions. They cannot
be deleted and do not need superseding — checkout refuses those classes outright.

**Still awaiting confirmation:** whether `immature_plant` should also carry a
usable-equivalent contribution, and whether any product type in the catalog maps
to a class not in this matrix. The two items previously flagged — the concentrate
factor and edible equivalency — are now resolved by the guidance.

---

## 8. Catalog readiness gate

```bash
npm run verify:catalog            # active variants
npm run verify:catalog -- --all   # include inactive and deleted
npm run verify:catalog -- --json  # machine-readable
```

Read-only and safe against production. **No `--fix`**: rewriting a product's
classification or its compliance measurement is a decision about what a real
physical item is, and a script that guessed would be inventing legal facts.

Reports separately: `missing_class`, `fallback_other`, `legacy_edible`,
`unsupported_class`, `missing_measurement_value`, `missing_measurement_basis`,
`incompatible_basis`, `zero_measurement`, `negative_measurement`,
`no_rule_in_force`, and `active_despite_failure` — the last being the urgent
one, since those variants are customer-visible right now and fail only at the
last step of checkout.

### Current development output

```
variants scanned:     33
classes with a rule:  concentrate, flower, immature_plant,
                      infused_liquid, infused_solid, non_cannabis

fallback_other  (33)   classified `other` — the unsafe legacy fallback

NOT READY — 33 variant(s) cannot enter checkout
            33 of them are ACTIVE and customer-visible
```

**This is the gate working, not a defect.** The development catalog was seeded
in Phase 2 with no cannabis classification at all, so every variant defaults to
`other`. It has deliberately not been bulk-rewritten: classifying 33 invented
products would prove nothing about the gate, whereas leaving them demonstrates
that it catches exactly this condition. Real catalog data must be classified as
it is entered.

---

## 9. Verification

```
npm run test:compliance    92 passed, 0 failed   (pure, no I/O)
npm run test:governance   104 passed, 0 failed   (database + domain)
npm run test:limits:http   49 passed, 0 failed   (HTTP surface)
```

`test:compliance` proves, among others: 10 g of concentrate contributes 10 g to
**both** the usable total and the concentrate cap; 15 g is allowed and 15.001 g
is not; 16 g breaches **only** the concentrate cap (under the old 5:1 weighting
it scored 80 g and tripped the usable cap — the right answer for the wrong
reason); flower and concentrate combine 1:1; solid equivalency is 1/16 by mass
and liquid is by volume; the same number through the wrong basis gives a
different answer and is refused rather than converted; three plants pass and
four fail; `other`, `edible`, unknown, missing, zero and negative all fail
closed; `non_cannabis` is exempt while a cannabis class carrying an `exempt`
basis is refused; 0.1 + 0.2 is exactly 0.3 while the float version is not.

The limit properties were **moved out of `test:math`**, which is about money.
Mixing them meant a change to tax code and a change to a legal cap shared one
pass/fail number.

---

## 10. Migration order

| # | What | Reversible |
| --- | --- | --- |
| 0008 | Orders, lines, events, payments, fulfilments, rules | Tables yes, enum values **no** |
| 0009 | Permissions, rule versioning, guard triggers | Triggers yes, enum values **no** |
| 0010 | Guard allows a **future** boundary to move | Yes |
| 0011 | `scheduler_runs`, `btree_gist`, overlap exclusion constraint | Yes |
| 0012 | One `running` scheduler run per job | Yes |
| **0013** | **Measurement model**: 4 new classes, `measurement_basis` enum, variant + order-line + rule columns; guard extended to freeze them | Columns yes, enum values **no** |
| **0014** | Cap columns to `numeric(18,11)` so 2.5 oz is exact | Yes |

Production is on **0007**. All seven are pending. Apply in order through the
gated sequence in [ORDERS.md](ORDERS.md) §14.

---

## 11. Remaining manual production steps

1. **Legal sign-off** on the §7 matrix, specifically the two open items.
2. Apply 0008–0015 through the gated sequence.
3. Run the §8 privilege SQL in [PURCHASE-LIMITS.md](PURCHASE-LIMITS.md) as the
   owner; `npm run verify:privileges` until all-PASS.
4. Publish the confirmed rules through `/admin/purchase-limits` — **one way,
   no undo**. The seeder refuses production and cannot be used here.
5. Load real catalog data with classification and measurement on every variant.
6. `npm run verify:catalog` until it reports **READY**.
7. Set `CRON_SECRET`; confirm the plan supports the cron interval
   (ORDERS.md §13).
8. Work the checklists in ORDERS.md §12 and PURCHASE-LIMITS.md §11.
9. **Only then** enable checkout.
