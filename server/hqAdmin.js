/* server/hqAdmin.js — admin routes the owner's assistant reaches through HQ.
 *
 * Some admin routes are also served at /api/hq/admin/..., with the same
 * handler: the admin's Needs attention, Newsletter, Sponsors and Analytics
 * data (and /activity: views, clicks and shares per day and event), plus the few actions the owner lets his assistant take for him
 * (restore or dismiss a hidden event, dismiss a message, hide or restore a
 * sponsor placement or mark it a test, send a test issue or the issue, fix
 * a subscriber's typo after the @).
 * The gate (index.js adminOrHq) lets HQ_REPLY_KEY in at the /api/hq/ path
 * only, never at /api/admin/, and sets req.admin.kind 'hq' so a handler can
 * hold the assistant to less (viaHq). HQ asks the owner before every action.
 */

export const hqPaths = p => [p, p.replace(/^\/api\/admin\//, '/api/hq/admin/')];
export const viaHq = req => Boolean(req.admin && req.admin.kind === 'hq');
