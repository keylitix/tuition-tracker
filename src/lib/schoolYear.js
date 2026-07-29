'use strict';

// A school year is 'YYYY-YYYY+1'. Oklahoma school years start in the fall, so we
// roll over on August 1: Aug–Dec belongs to the year that just started, Jan–Jul
// to the year that began the previous August.
//
// Used only as a fallback when a Stripe event carries no explicit school_year in
// metadata — admin-entered rows always carry an explicit year.
function currentSchoolYear(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1; // 1-12
  const start = m >= 8 ? y : y - 1;
  return `${start}-${start + 1}`;
}

function isValidSchoolYear(value) {
  return typeof value === 'string' && /^\d{4}-\d{4}$/.test(value);
}

module.exports = { currentSchoolYear, isValidSchoolYear };
