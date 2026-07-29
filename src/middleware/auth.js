'use strict';

// Session shape:
//   req.session.admin  = { id, email, displayName }   -> admin area
//   req.session.family = { id, name }                  -> parent portal
// The two are independent; a request is never both.

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin/login');
}

// Parent guard. Beyond checking that a parent is logged in, this is the single
// choke point that hands downstream handlers the session family id. Every
// parent query MUST scope on req.familyId — never on a route/query parameter.
function requireParent(req, res, next) {
  if (req.session && req.session.family) {
    req.familyId = req.session.family.id;
    return next();
  }
  return res.redirect('/portal/login');
}

// Expose the current user to all views without each route wiring it in.
function exposeUser(req, res, next) {
  res.locals.admin = (req.session && req.session.admin) || null;
  res.locals.family = (req.session && req.session.family) || null;
  next();
}

module.exports = { requireAdmin, requireParent, exposeUser };
