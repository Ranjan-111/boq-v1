/* Vendor offers (#16).

   An offer is an offer, not a selection. Eligible vendors are surfaced with
   their price and validity and the human chooses -- nothing here picks, ranks by
   price, or marks one "recommended", because a nudge is a choice made on the
   operator's behalf without their knowing it.

   A vendor choice never changes a quantity. Offers price what was measured; they
   have no path back into measurement. */

const { RateError } = require('./rates');

class VendorError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new VendorError(`Vendor offer ${field} is required.`);
  return value.trim();
}
function requireDate(value, field) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) throw new VendorError(`Vendor offer ${field} must be an ISO date; an offer with no date is not an offer.`);
  return value;
}

function createVendorOffer({ id, studioId, vendorId, vendorName, itemCode, unit, amount, currency, validFrom, validTo, source, leadTimeDays = null, locality = null } = {}) {
  requireText(id, 'id'); requireText(studioId, 'studioId');
  requireText(vendorId, 'vendorId'); requireText(vendorName, 'vendorName');
  requireText(itemCode, 'itemCode'); requireText(unit, 'unit');
  requireText(currency, 'currency');
  if (!Number.isFinite(amount) || amount < 0) throw new VendorError(`Vendor offer for ${itemCode} needs a finite non-negative amount.`);
  if (!source || typeof source !== 'object') throw new VendorError('A vendor offer must record where it came from.');
  requireText(source.label, 'source.label'); requireText(source.suppliedBy, 'source.suppliedBy');
  return Object.freeze({
    id, studioId, vendorId, vendorName, itemCode, unit, amount, currency,
    validFrom: requireDate(validFrom, 'validFrom'), validTo: requireDate(validTo, 'validTo'),
    leadTimeDays, locality, source: Object.freeze({ ...source })
  });
}

/**
 * Eligible offers for one item. Deliberately returns no selection, no
 * recommendation and no cheapest: the caller shows them and the human decides.
 */
function eligibleOffers(offers = [], { itemCode, studioId, unit, on = new Date().toISOString().slice(0, 10), locality = null } = {}) {
  const scoped = offers.filter((offer) => offer.studioId === studioId && offer.itemCode === itemCode);
  const eligible = [];
  const stale = [];
  const ineligible = [];
  for (const offer of scoped) {
    if (String(on) > offer.validTo) { stale.push({ ...offer, reason: `This offer expired on ${offer.validTo}.` }); continue; }
    if (String(on) < offer.validFrom) { stale.push({ ...offer, reason: `This offer is not valid until ${offer.validFrom}.` }); continue; }
    if (unit && offer.unit !== unit) { ineligible.push({ ...offer, reason: `Unit mismatch: the offer is priced per ${offer.unit} but the quantity is measured in ${unit}.` }); continue; }
    if (locality && offer.locality && offer.locality !== locality) { ineligible.push({ ...offer, reason: `Offer covers ${offer.locality}, not ${locality}.` }); continue; }
    eligible.push(offer);
  }
  /* Stable by vendor name, explicitly NOT by price -- ordering by price is a
     recommendation wearing a sort order. */
  eligible.sort((left, right) => left.vendorName.localeCompare(right.vendorName));
  return {
    itemCode, unit, on,
    status: eligible.length ? 'offers_available' : 'none_eligible',
    reason: eligible.length ? null : `No eligible vendor offer for ${itemCode} on ${on}. This is not a price of zero.`,
    offers: eligible, stale, ineligible
  };
}

module.exports = { createVendorOffer, eligibleOffers, VendorError };
