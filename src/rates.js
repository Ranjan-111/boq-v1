/* Rate books (#15).

   A price is a fact with an owner and a date, or it does not exist. Unlike every
   other number in this system, a rate is not derived from geometry -- it comes
   from outside -- so it carries where it came from, who supplied it, and when it
   was valid. A rate without that provenance is refused at construction: it is
   worse than a missing rate, because a missing rate is visibly missing.

   Never invent a rate. A line with no applicable rate has no amount. That is a
   state, not zero, and it is distinguishable from a genuinely free item -- the
   same discipline as not_measurable versus measured_zero, applied to money. */

class RateError extends Error {}

const PRICING_STATUSES = Object.freeze([
  'priced',         // a live rate applied
  'no_rate',        // nothing in the book prices this item
  'stale_rate',     // a rate exists but its validity window has passed
  'unit_mismatch',  // the rate prices a different unit than the line measures
  'no_quantity'     // the line has no quantity to price
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new RateError(`Rate book ${field} is required.`);
  return value.trim();
}
function requireDate(value, field) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw new RateError(`Rate ${field} must be an ISO date (YYYY-MM-DD); a price with no date is not a fact.`);
  return value;
}

/**
 * Immutable and versioned, like a ruleset: a price change is a new version, so a
 * BOQ priced in March still reproduces March's numbers in October.
 */
function createRateBook({ id, studioId, label = '', version, currency, locality = null, source, rates = [], publishedOn = null, kind = 'studio' } = {}) {
  requireText(id, 'id');
  requireText(studioId, 'studioId');
  requireText(currency, 'currency (store it explicitly, never assume)');
  if (!Number.isInteger(version) || version < 1) throw new RateError('Rate book version must be a positive integer.');
  if (!source || typeof source !== 'object') throw new RateError('A rate book must record its source.');
  requireText(source.label, 'source.label');
  requireText(source.suppliedBy, 'source.suppliedBy');

  const normalized = rates.map((rate) => {
    requireText(rate?.itemCode, 'rate.itemCode');
    requireText(rate?.unit, 'rate.unit');
    if (!Number.isFinite(rate?.amount) || rate.amount < 0) throw new RateError(`Rate for ${rate?.itemCode} must be a finite non-negative amount.`);
    const validFrom = requireDate(rate.validFrom, 'validFrom');
    const validTo = requireDate(rate.validTo, 'validTo');
    if (validTo < validFrom) throw new RateError(`Rate for ${rate.itemCode} ends before it starts.`);
    return Object.freeze({
      itemCode: rate.itemCode, unit: rate.unit, amount: rate.amount,
      validFrom, validTo, locality: rate.locality ?? locality ?? null,
      source: Object.freeze({ ...source })
    });
  });

  return Object.freeze({
    id, studioId, label, version, currency, locality, kind, publishedOn,
    source: Object.freeze({ ...source }),
    rates: Object.freeze(normalized)
  });
}

function isStale(rate, on) {
  if (!rate) return false;
  return String(on) > rate.validTo;
}
function isNotYetValid(rate, on) {
  if (!rate) return false;
  return String(on) < rate.validFrom;
}

/** The most recently-starting rate for an item, regardless of staleness, so a
    stale rate can be reported rather than silently treated as absent. */
function findRate(book, itemCode, locality = null) {
  const candidates = book.rates.filter((rate) => rate.itemCode === itemCode
    && (!locality || !rate.locality || rate.locality === locality));
  if (!candidates.length) return null;
  return [...candidates].sort((left, right) => right.validFrom.localeCompare(left.validFrom))[0];
}

/**
 * Price one BOQ line. Returns a record from which `amount` is re-derivable:
 * quantity x rate.amount, with the rate and its provenance attached.
 */
function priceLine(line, book, { on = new Date().toISOString().slice(0, 10), locality = null } = {}) {
  const base = {
    measurement: line.measurement, quantity: line.quantity ?? null, unit: line.unit ?? null,
    currency: book.currency, rateBookId: book.id, rateBookVersion: book.version,
    pricedOn: on, rate: null, amount: null
  };
  const rate = findRate(book, line.measurement, locality ?? book.locality);
  if (!rate) return { ...base, status: 'no_rate', reason: `No rate in ${book.label || book.id} v${book.version} prices ${line.measurement}. This line has no amount; it is not free.` };
  const withRate = { ...base, rate };
  if (isStale(rate, on)) return { ...withRate, status: 'stale_rate', reason: `The rate for ${line.measurement} expired on ${rate.validTo} and cannot price a BOQ dated ${on}.` };
  if (isNotYetValid(rate, on)) return { ...withRate, status: 'stale_rate', reason: `The rate for ${line.measurement} is not valid until ${rate.validFrom}.` };
  if (rate.unit !== line.unit) return { ...withRate, status: 'unit_mismatch', reason: `The rate for ${line.measurement} is per ${rate.unit} but the quantity is in ${line.unit}. Pricing is refused rather than multiplying incompatible units.` };
  if (!Number.isFinite(line.quantity)) return { ...withRate, status: 'no_quantity', reason: `${line.measurement} has no quantity (${line.measurementStatus || 'absent'}), so it has no amount.` };
  /* Unrounded on purpose: rounding happens once, at presentation. */
  return { ...withRate, status: 'priced', amount: line.quantity * rate.amount };
}

/* Currency has minor units; rounding to two places is a presentation concern.
   Never round inside a running total -- three lines that each round up become a
   total that is wrong by three half-units. */
function roundMoney(amount) {
  if (!Number.isFinite(amount)) return null;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Sums exact amounts and rounds once. Reports what it could not price rather
    than quietly presenting a partial figure as a whole-project total. */
function totalOf(pricedLines = []) {
  const currencies = new Set(pricedLines.map((line) => line.currency).filter(Boolean));
  if (currencies.size > 1) throw new RateError(`Refusing to total mixed currencies: ${[...currencies].join(', ')}. Convert explicitly with a dated rate.`);
  const priced = pricedLines.filter((line) => line.status === 'priced' && Number.isFinite(line.amount));
  const exact = priced.reduce((sum, line) => sum + line.amount, 0);
  const unpriced = pricedLines.length - priced.length;
  return {
    currency: [...currencies][0] ?? null,
    amount: roundMoney(exact),
    exactAmount: exact,
    pricedLines: priced.length,
    unpricedLines: unpriced,
    complete: unpriced === 0,
    unpricedReasons: pricedLines.filter((line) => line.status !== 'priced').map((line) => ({ measurement: line.measurement, status: line.status, reason: line.reason }))
  };
}

module.exports = { createRateBook, priceLine, totalOf, roundMoney, isStale, isNotYetValid, findRate, RateError, PRICING_STATUSES };
