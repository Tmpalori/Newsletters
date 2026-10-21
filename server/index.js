/* server/index.js — Lightweight Express server for The Vic 361.
 *
 * Responsibilities:
 *   - Public POST /api/submissions endpoint backed by Postgres (or JSON file)
 *   - Admin GET/POST /api/admin/submissions[...] gated by ADMIN_TOKEN
 *   - Serves the existing static site from /docs (so a Railway deploy can
 *     stand alone without GitHub Pages — DNS cutover is a separate decision)
 *
 * Hard rules:
 *   - Public submissions go to a review queue; the AI review
 *     (server/submissionReview.js) publishes the clean ones and flags the rest.
 *   - When TURNSTILE_SECRET_KEY is set, missing/invalid tokens are rejected.
 *   - Submitter email + IP never leave the admin scope.
 */

import { town, townConfig, useTown, VICTORIA, townAssetPath, townPaths, townBootProblems, townWorkflowsReady, victoriaBootProblem } from './town.js';
import { localizeHtml } from './localize.js';
import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { promises as fsp, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStore, isOutage, normalizePayload, newId, nowIso, applyEventEdits, eventKeyOf, parseEventKey, withoutSubmitter, resolveEditKey, withPublishedLock } from './db.js';
import { validateSubmission, validateEventEdit, checkBotSignals } from './validate.js';
import { reportHoneypot } from './honeypot.js';
import { verifyTurnstile, turnstileHostnames } from './turnstile.js';
import { createFormGuard } from './formGuard.js';
import { createDropNotices } from './dropNotices.js';
import { createEventRecaps } from './eventRecaps.js';
import { EMAIL_CHECK_JS, impossibleEmailError } from './emailTypos.js';
import { createRateLimiter, ipKey, railwayRealIp } from './rateLimit.js';
import { createAuth, MIN_SECRET } from './auth.js';
import { createGithub } from './github.js';
import { readMetadataFile, buildSourcesPayload } from './sources.js';
import { crawlerMiddleware, beaconRow, summarize } from './analytics.js';
import { activitySummary, ACTIVITY_MAX_DAYS } from './activity.js';
import { pixelId, metaPixelJs } from './metaPixel.js';
import { registerEventCheck, withoutHidden, visibleKeyed, stripKeys, keyedEvents } from './eventcheck.js';
import { registerGrowth } from './growth.js';
import { registerPrivacy, purgePersonalData } from './privacy.js';
import { registerHq, buildSummary, keyOk, jobsSummary, hypeBlocks, morningBlocks, hqAlertText } from './hq.js';
import { hqPaths } from './hqAdmin.js';
import { registerOpsReport } from './opsReport.js';
import { createJobs, canRunOnWorker } from './jobs.js';
import { createSections, sectionsConfig, SECTION_PAGES } from './sections.js';
import { withInbox } from './inbox.js';
import { townStyleCss, townSubmitCss } from './palette.js';
import { newsletterConfig, createResend, registerNewsletter, signupFormHtml, normalizeEmail, sampleEmailPreviews, EDITIONS, issueFacts } from './newsletter.js';
import { createTremendous, tremendousConfig } from './referralRewards.js';
import { createMailer, renderSubmissionReceived, renderSubmissionLive, setWeekendIssue } from './notify.js';
import { registerSubmissionReview, isPaidPick } from './submissionReview.js';
import { stripeConfig, createStripe, createSponsors, samplePreviews, renderLogoTooLargePage, sameEvent, eventWeekStats, LEAD_IN_DAYS } from './sponsors.js';
import { partnerState, partnerBoxHtml, renderPartnersPage, categoryOf } from './partners.js';
import { slackConfig, createSlack, slackEscape } from './slack.js';
import { createInbound, inboundConfig } from './inbound.js';
import { registerContact } from './contact.js';
import { renderEventCard, eventCardVersion } from './ogImage.js';
import { capDays, pickDays, shown } from './scoring.js';
import { createAutoPublish, unpublishEvent, replacePublishedEvent, forgetRemoved } from './autopublish.js';
import { createScheduler, schedulerEnabled, startLabel, checkTownSchedule, missedCollect, slotStart, JOBS } from './scheduler.js';
import * as sponsorsModule from './sponsors.js';
import crypto from 'node:crypto';
import { verifyPass, MIN_SSO_SECRET } from './sso.js';
import {
  HUB_PAGES, localDateStr, renderHome, renderHubPage, renderEventPage,
  renderAboutPage, renderAdvertisePage, advertiseStats, renderNotFoundPage, renderSitemap, renderLlmsTxt
  , fillSeasonalNav, setSectionNav, fillReach, setReach, reachNumbers, currentWeek, addDays, shiftToWeek
} from './seo.js';
import {
  businessConfig, useBusiness, hasLegalName, hasContactEmail, mailingAddress,
  renderPrivacyPage, renderTermsPage, renderAdvertisingTermsPage, renderAccessibilityPage
} from './legal.js';
import {
  buildVenues, venueFor, renderVenuePage, renderVenueIndex, venuesWithEvents,
  townSeasons, activeSeasons, renderSeasonPage, renderIcs, eventActionsHtml
} from './guides.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
// Hourly site check (healthCheck): fewer upcoming events than this, or no
// new collect in this many days (it runs Sunday and Wednesday), alerts.
const MIN_UPCOMING = 10;
const STALE_COLLECT_DAYS = 8;
// The hourly check says so when a collect hasn't landed this long after its slot.
const COLLECT_LATE_HOURS = 3;

const BASE_CSP = "frame-ancestors 'self'; object-src 'none'; base-uri 'self'";

// The admin page keeps its session token in localStorage, so it gets a
// script CSP: only its own files and its inline theme snippet (allowed by
// hash, computed here so editing the snippet can't silently break it) may
// run. It loads no analytics, pixel or Turnstile.
async function adminPageCsp() {
  let html = '';
  try { html = await fsp.readFile(path.join(DOCS_DIR, 'admin.html'), 'utf8'); } catch (_) { /* no admin page */ }
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => ` 'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return `script-src 'self'${hashes.join('')}; ${BASE_CSP}`;
}

async function readJsonFile(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

function safeTokenEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// Express 4 doesn't catch a rejected promise from an async handler: the
// request hangs and the rejection goes unhandled (a database blip left the
// submit form and admin tabs spinning). Send every handler's rejection to
// next(err) so the error handler answers. Error handlers (4 args) and
// mounted apps/routers pass through untouched.
function catchAsync(fn) {
  if (typeof fn !== 'function' || fn.length >= 4 || fn.handle) return fn;
  return function (req, res, next) {
    const out = fn.call(this, req, res, next);
    if (out && typeof out.catch === 'function') out.catch(err => next(err || new Error('handler rejected')));
    return out;
  };
}

// Wraps app.get/post/... so routes registered anywhere (including the
// register* helpers in other modules) get catchAsync.
function catchAsyncRoutes(app) {
  for (const method of ['use', 'all', 'get', 'post', 'put', 'patch', 'delete']) {
    const orig = app[method].bind(app);
    app[method] = (...args) => {
      if (method === 'get' && args.length === 1) return orig(...args); // app.get(setting)
      return orig(...args.map(a => (Array.isArray(a) ? a.map(catchAsync) : catchAsync(a))));
    };
  }
  return app;
}

export async function createApp(opts = {}) {
  const app = catchAsyncRoutes(express());

  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? null;
  const turnstileSecret = opts.turnstileSecret ?? process.env.TURNSTILE_SECRET_KEY ?? null;
  const turnstileSiteKey = opts.turnstileSiteKey ?? process.env.TURNSTILE_SITE_KEY ?? null;
  // Railway's edge is the one proxy in front of us. Trusting exactly one hop
  // makes req.ip the address Railway saw; `true` would trust the left-most
  // X-Forwarded-For entry, which any client can set to dodge rate limits.
  const trustProxy = opts.trustProxy ?? 1;
  if (trustProxy) app.set('trust proxy', trustProxy === true ? 1 : trustProxy);
  // On Railway the edge sets X-Real-IP to the visitor's address
  // (docs.railway.com: Public Networking > Specs & Limits); prefer it so the
  // rate limits key on the real client however many hops sit in between.
  if (trustProxy && (opts.railway ?? Boolean(process.env.RAILWAY_ENVIRONMENT_NAME))) {
    app.use(railwayRealIp());
  }

  // Canonical host. www.thevic361.com is where Google already indexes the
  // site and where all real traffic lands; the bare domain 301s to it so
  // search engines see one site instead of two copies.
  // The town (server/town.js): TOWN in Railway, unset = Victoria; opts.town for tests.
  useTown(townConfig(process.env, opts));
  // A service with TOWN forgotten but another town's SITE_URL would be a
  // silent clone of Victoria: stop before anything starts. Reads the
  // service's own SITE_URL (opts.envSiteUrl for tests), never opts.siteUrl.
  const victoriaProblem = victoriaBootProblem(town, opts.envSiteUrl ?? process.env.SITE_URL ?? '');
  if (victoriaProblem) throw new Error(victoriaProblem);
  // Who runs the site, for the legal pages (server/legal.js): Railway's
  // BUSINESS_LEGAL_NAME, BUSINESS_CONTACT_EMAIL and NEWSLETTER_ADDRESS.
  useBusiness(businessConfig(process.env, opts));
  // The town's data files (townPaths): repo-relative for GitHub, absolute on disk.
  const PATHS = townPaths();
  const CANDIDATES_FILE = path.join(REPO_ROOT, PATHS.candidates);
  const COLLECTION_METADATA_FILE = path.join(REPO_ROOT, PATHS.collectionMetadata);
  const EVENTS_FILE = path.join(REPO_ROOT, PATHS.events);
  const VENUES_FILE = path.join(REPO_ROOT, PATHS.venues);
  checkTownSchedule();
  const siteUrl = (opts.siteUrl ?? process.env.SITE_URL ?? town.siteUrl).replace(/\/+$/, '');
  // Where a Turnstile token may have been solved (server/turnstile.js).
  const turnstileHosts = opts.turnstileHostnames ?? [...new Set([...turnstileHostnames(siteUrl, process.env.RAILWAY_PUBLIC_DOMAIN), ...turnstileHostnames(town.siteUrl)])];
  // Owner pings in Slack (server/slack.js); a no-op until SLACK_WEBHOOK_URL is set.
  // Every ping is also kept in the owner inbox for HQ (server/inbox.js).
  let inboxStore = null;
  // Every town's messages carry its tag: SLACK_TOWN_TAG, else its city (as
  // scripts/slack_notify.py does), so the shared channels read the same.
  const townTag = opts.slackTownTag ?? ((process.env.SLACK_TOWN_TAG || '').trim() || town.city);
  const rawSlack = opts.slack || createSlack(slackConfig(process.env, { ...opts, slackTownTag: townTag }));
  const slack = withInbox(rawSlack, () => inboxStore);
  const canonicalHost = new URL(siteUrl).host;
  const apexHost = canonicalHost.replace(/^www\./, '');
  app.use((req, res, next) => {
    // Squarespace's domain forwarding (which answers the bare domain)
    // sends thevic361.com/about to www.thevic361.com//about, which no route
    // matches. Collapse the leading slashes. The result always starts with
    // a single "/", so it stays on this site (never "//evil.example").
    const url = req.originalUrl.replace(/^\/{2,}/, '/');
    if (apexHost !== canonicalHost && req.hostname === apexHost) {
      return res.redirect(301, siteUrl + url);
    }
    if (url !== req.originalUrl) return res.redirect(301, url);
    next();
  });

  // Baseline security headers. Public pages get no script CSP: they rely on
  // inline scripts (GA bootstrap, JSON-LD, page scripts in seo.js and
  // sponsors.js), inline onload/onclick handlers, Google Analytics, the Meta
  // Pixel and Turnstile, so a useful script-src needs per-response nonces
  // and no inline handlers first. Their CSP only locks down framing,
  // plugins and <base> hijacking; the admin page gets script-src too.
  app.disable('x-powered-by');
  const adminCsp = await adminPageCsp();
  app.use((req, res, next) => {
    // express.static decodes %-escapes and normalizes the path before it
    // picks a file, so decide on the same form: /admin%2Ehtml and
    // /%61dmin.html serve admin.html and must get its CSP too. (The static
    // handler below also sets it by the file it actually serves.)
    let p = req.path;
    try { p = path.posix.normalize(decodeURIComponent(p)); } catch (_) { /* bad escape: answered 400 later */ }
    const isAdminPage = /^\/admin(\.html)?$/i.test(p);
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'Strict-Transport-Security': 'max-age=31536000',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': isAdminPage ? adminCsp : BASE_CSP
    });
    next();
  });

  app.use(compression());

  // Username/password login + signed session tokens. Replaces the old
  // browser-side GitHub PAT flow. When ADMIN_USERNAME / ADMIN_PASSWORD /
  // ADMIN_SESSION_SECRET are set, /api/admin/login issues bearer tokens that
  // gate every /api/admin/* route. The legacy ADMIN_TOKEN is still accepted as
  // a fallback so existing scripts/configs keep working.
  const auth = opts.auth || createAuth({
    username: opts.adminUsername,
    password: opts.adminPassword,
    secret: opts.adminSessionSecret,
    ttlHours: opts.adminSessionTtlHours
  });

  // Server-side GitHub publisher. When GITHUB_TOKEN/GITHUB_PAT is set, the
  // admin can publish docs/events.json via /api/admin/publish-events without
  // ever holding a GitHub PAT in the browser.
  const github = opts.github || createGithub({
    token: opts.githubToken,
    owner: opts.githubOwner,
    repo: opts.githubRepo,
    branch: opts.githubBranch,
    fetch: opts.fetch
  });

  // Per-IP login throttle. 10 attempts / 15 min — enough for an admin who
  // typoes their password a few times, way too few for online brute force.
  // IPv6 clients are keyed on their /64 (ipKey), which one subscriber owns.
  const loginLimiter = opts.loginLimiter || createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 10
  });
  // Wrong legacy ADMIN_TOKEN guesses on /api/admin/*, per client.
  const authFailLimiter = opts.authFailLimiter || createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 20
  });
  // Failed logins and wrong admin tokens from everyone together. Past it,
  // Slack hears about it once. It only alerts: blocking every address would
  // also lock the owner out for as long as an attack lasts, and each address
  // already has its own budget above.
  const authFailGlobal = opts.authFailGlobal || createRateLimiter({
    windowMs: 15 * 60 * 1000, max: 100
  });
  const clientKey = req => ipKey(req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  function recordAuthFailure() {
    authFailGlobal.check('all');
    if (!authFailGlobal.peek('all').ok) {
      slack.alert('admin-auth-flood', 'Many failed admin sign-ins',
        'Too many failed admin sign-ins or wrong admin tokens in 15 minutes, from many addresses. ' +
        'Each address is still limited on its own; consider changing ADMIN_PASSWORD if it keeps up (that also signs out every session).');
    }
  }

  const railwayEnv = opts.railwayEnvironment ?? process.env.RAILWAY_ENVIRONMENT_NAME;
  // A PR preview (Railway environment "<service>-pr-<n>", never production)
  // has no published list, so it shows the bundled sample moved into this
  // week (shiftToWeek) instead of a week of "No events".
  const previewSample = opts.previewSample ?? (/-pr-\d+$/.test(railwayEnv || '') && railwayEnv !== 'production');
  // ready() had to create the subscribers or sponsor_orders table: in
  // production that's a new, empty database (a recreated Postgres service
  // or volume), and the list, orders, approvals and edits are gone unless
  // restored from a backup (AGENTS.md, Backups). PR environments and local
  // runs start empty on purpose.
  const onTablesCreated = tables => {
    if (railwayEnv !== 'production') return;
    console.error('[db] production database had no', tables.join(', '), 'table: created empty');
    slack.alert('db-fresh', 'Production database looks new and empty',
      `The server had to create the ${tables.join(' and ')} table${tables.length > 1 ? 's' : ''}, so this database has no subscribers or sponsor orders. ` +
      'If DATABASE_URL now points at a recreated Postgres, restore the latest Railway backup (AGENTS.md, Backups) before the next newsletter (Monday or Thursday).');
  };
  const storeBundle = opts.storeBundle ?? await createStore({
    databaseUrl: opts.databaseUrl,
    file: opts.storageFile,
    onTablesCreated,
    onUnavailable: err => slack.alert('db-boot', 'Database unreachable at boot',
      `${err.message}\nThe site is up on the bundled events.json and retries the database on the next request.`)
  });
  const store = storeBundle.store;
  inboxStore = store;
  // The newsletter's extra sections (server/sections.js, SECTIONS.md): off
  // unless the town's sections.json says "enabled" (or SECTIONS=1).
  const sections = createSections({ store, cfg: opts.sectionsConfig || sectionsConfig(town, { env: opts.sectionsEnv || process.env }),
    slack, siteUrl, nowFn: () => (opts.now || (() => new Date()))() });
  // Their pages join the menu only when they're on (server/seo.js navHtml).
  setSectionNav(sections.enabled ? SECTION_PAGES : []);
  // The town's jobs on Railway (server/jobs.js, JOBS_ON_RAILWAY.md): off
  // (404, nothing queued) unless JOBS_ON_RAILWAY=1 and JOBS_SECRET are set.
  const jobs = opts.jobs || createJobs({
    store, slack, siteUrl, env: opts.jobsEnv || process.env,
    listReplies: sections.listReplies, onFile: sections.onFile,
    issueFacts: async edition => issueFacts((await shownPayload({})).events, { now: (opts.now || (() => new Date()))(), edition }),
    nowFn: () => (opts.now || (() => new Date()))(),
    // Victoria's social kit was posted from GitHub, which kept what went out
    // in git (docs/social/latest/posted.json): her worker starts from it, so
    // the day she moved never posts a day and kind twice.
    seeds: town.id === VICTORIA.id ? { social_posted: () => readJsonFile(opts.socialPostedFile || path.join(DOCS_DIR, 'social', 'latest', 'posted.json')).catch(() => null) } : {},
    // AUTO_PUBLISH=0 (the owner publishes by hand) holds the new candidates for the admin.
    // A publish that fails is retried hourly, which says when it caught up.
    publish: async () => {
      if ((opts.jobsEnv || process.env).AUTO_PUBLISH === '0') return null;
      try {
        const r = await publishFresh();
        if (r && r.ok === false) autoFailed = true;
        return r;
      } catch (err) { autoFailed = true; throw err; }
    }
  });
  // Pings from before the store existed (a database alert at boot), and any
  // a database outage held back, go in now and every 2 minutes after.
  slack.flushInbox();
  const inboxRetry = setInterval(() => { if (slack.pendingInbox()) slack.flushInbox(); }, 2 * 60 * 1000);
  if (inboxRetry.unref) inboxRetry.unref();
  // An injected Postgres store (tests) gets the same hook.
  if (store && 'onTablesCreated' in store && !store.onTablesCreated) store.onTablesCreated = onTablesCreated;
  // Production on the JSON file store means DATABASE_URL resolved empty (a
  // renamed or re-provisioned Postgres service): everything looks fine, and
  // every subscriber, submission and paid order written meanwhile is lost
  // on the next deploy (Railway's disk is ephemeral). Loud, not silent.
  const missingDatabase = railwayEnv === 'production' && storeBundle.kind !== 'postgres';
  const NO_DATABASE = 'Production is running without its database (DATABASE_URL is missing or empty), so new subscribers, submissions and orders are kept on a disk that is wiped on the next deploy. Fix the DATABASE_URL reference in Railway.';
  if (missingDatabase) {
    console.error('[db] production without DATABASE_URL: using the ephemeral file store');
    slack.alert('db-missing', 'Production has no database', NO_DATABASE);
  }

  // Admin secrets too short to resist distributed guessing (auth.weak, plus
  // the legacy token here). Not a boot failure: the live site may run on
  // them today, and refusing to start would take it down. The session
  // secret and token are random keys nobody types, so a short one is
  // required in the setup checklist and alerts on every production boot.
  // The password is the owner's call (one they chose and are sure of may
  // be short): only a "recommended" setup item, no alert and no log line.
  const isPasswordNote = w => w.startsWith('ADMIN_PASSWORD ');
  const shortPassword = (auth.weak || []).filter(isPasswordNote);
  const weakAdminSecrets = [...(auth.weak || []).filter(w => !isPasswordNote(w)),
    ...(adminToken && String(adminToken).length < MIN_SECRET ? [`ADMIN_TOKEN is shorter than ${MIN_SECRET} characters`] : [])];
  const WEAK_ADMIN_FIX = 'Set a longer ADMIN_SESSION_SECRET (`openssl rand -hex 32`) in Railway; replace ADMIN_TOKEN the same way ' +
    'or remove it if no script uses it. Changing the secret signs out every admin session.';
  const SHORT_PASSWORD_FIX = 'A longer ADMIN_PASSWORD (12+ characters; a passphrase is fine) is harder to guess from many ' +
    'addresses at once. Changing it signs out every admin session.';
  if (weakAdminSecrets.length) {
    console.warn('[auth] weak admin secrets:', weakAdminSecrets.join('; '));
    if (railwayEnv === 'production') {
      slack.alert('admin-weak-secrets', 'Admin login secrets are too short', `${weakAdminSecrets.join('; ')}. ${WEAK_ADMIN_FIX}`);
    }
  }

  // Note crawler hits on public pages for the admin Traffic tab. Registered
  // before every route so it sees the server-rendered pages too.
  if (typeof store.recordTraffic === 'function') app.use(crawlerMiddleware(store, () => (opts.now || (() => new Date()))()));

  const submitLimiter = opts.submitLimiter || createRateLimiter({
    windowMs: 60 * 1000, max: 5
  });
  const submitLimiterDaily = opts.submitLimiterDaily || createRateLimiter({
    windowMs: 24 * 60 * 60 * 1000, max: 30
  });
  // "We got it" emails per recipient address, whatever IP sends the form.
  const receiptLimiter = createRateLimiter({ windowMs: 24 * 60 * 60 * 1000, max: 3 });
  // No visitor stuck on a public form, and the owner hears when one is
  // (server/formGuard.js).
  const formGuard = opts.formGuard || createFormGuard({
    slack, verifyTurnstile, clientKey,
    turnstileOpts: () => ({ secret: turnstileSecret, fetch: opts.fetch, hostnames: turnstileHosts })
  });

  // ─── Sponsor checkout (Stripe; see server/sponsors.js) ───
  // Created here because the Stripe webhook needs the raw body and so must
  // be registered before the JSON parser below. Its page routes come later.
  const stripeCfg = stripeConfig(process.env, opts);
  // Resend: the newsletter and the "we got it" emails (server/notify.js).
  const newsletter = newsletterConfig(process.env, opts);
  // Another town on settings or a database copied from Victoria's would
  // link, mail and write as The Vic 361: stop before serving anything
  // (MULTI_CITY_PLAN.md 2.5). Victoria skips both checks.
  if (town.id !== VICTORIA.id) {
    const problems = townBootProblems(town, { siteUrl, emailFrom: newsletter.from });
    if (problems.length) throw new Error(`TOWN=${town.id} won't start: ${problems.join('; ')}`);
    if (typeof store.claimTown === 'function') {
      // A database blip at boot is retried for about a minute (Railway
      // restarts it after that); "couldn't check" is never "claimed".
      const waits = opts.claimRetryMs || [2000, 5000, 10000, 15000, 30000];
      let owner;
      for (let i = 0; ; i++) {
        try { owner = await store.claimTown(town.id); break; } catch (err) {
          if (i >= waits.length || !isOutage(err)) throw err;
          console.warn(`[db] TOWN=${town.id}: database unreachable at boot (${err.message}); retrying in ${waits[i] / 1000}s`);
          await new Promise(r => setTimeout(r, waits[i]));
        }
      }
      if (owner.town !== town.id) {
        throw new Error(`TOWN=${town.id} won't start: its database ${owner.town ? `belongs to TOWN=${owner.town}`
          : 'already holds subscribers, orders or submissions from before towns (Victoria\'s)'}; check DATABASE_URL`);
      }
    }
  }
  // Sales and confirmation copy only promise the Thursday issue while it's on.
  setWeekendIssue(newsletter.weekend);
  const nlResend = opts.resend || createResend(newsletter.apiKey);
  // Referral gift cards (server/referralRewards.js); unset means the owner
  // sends them by hand from the admin list.
  const tremendous = opts.tremendous || createTremendous(tremendousConfig(process.env, opts));
  const mailer = createMailer({ resend: nlResend, config: newsletter });

  const sponsors = createSponsors({
    store, siteUrl, config: stripeCfg, slack, mailer, mailAddress: newsletter.address,
    nowFn: () => (opts.now || (() => new Date()))(),
    stripe: opts.stripe || createStripe(stripeCfg.secretKey),
    getVenues: () => venues,
    // The public events before placements, to show in the Sponsors tab when
    // a paid Vic's Pick isn't on the site.
    getPayload: () => loadPublicPayload(),
    // Signs category partners' manage links (server/partners.js). A secret
    // that doesn't change with deploys, so links in old emails keep working.
    manageSecret: opts.partnerManageSecret ?? process.env.PARTNER_LINK_SECRET ?? process.env.ADMIN_SESSION_SECRET ?? stripeCfg.webhookSecret ?? ''
  });
  sponsors.registerWebhook(app);
  // Replies to news@thevic361.com, received by Resend, posted to Slack
  // (server/inbound.js). Raw body too, so also before the JSON parser.
  const inbound = createInbound({ config: inboundConfig(process.env, opts), apiKey: newsletter.apiKey, slack, siteUrl,
    fetchImpl: opts.inboundFetch || globalThis.fetch, nowFn: () => (opts.now ? opts.now().getTime() : Date.now()),
    otherDomains: opts.inboundOtherDomains, store, onReply: sections.enabled ? sections.saveReply : null });
  inbound.register(app);

  // The admin's sponsor edit can carry a new logo (a data URL, shrunk in
  // the browser), so it alone gets a bigger JSON limit.
  // Save & Publish sends the whole live list (~450 bytes an event), which
  // outgrows 64 KB around 150 events, so it gets room too.
  const smallJson = express.json({ limit: '64kb' });
  const sponsorEditJson = express.json({ limit: '600kb' });
  const publishJson = express.json({ limit: '2mb' });
  // The jobs API (server/jobs.js) parses its own bodies, after its secret
  // checks out: a collect's candidates are a few MB.
  app.use((req, res, next) => (req.path.startsWith('/api/jobs/') ? next()
    : (/^\/api\/admin\/sponsors\/[^/]+$/.test(req.path) ? sponsorEditJson
      : req.path === '/api/admin/publish-events' ? publishJson : smallJson)(req, res, next)));
  // The sponsor checkout form can carry a logo (a data URL, shrunk in the
  // browser), so it alone gets a bigger limit.
  const smallForms = express.urlencoded({ extended: false, limit: '64kb' });
  const checkoutForm = express.urlencoded({ extended: false, limit: '600kb' });
  app.use((req, res, next) => (req.path === '/advertise/checkout' ? checkoutForm : smallForms)(req, res, next));
  // The browser's own reports of a form it couldn't finish (server/formGuard.js).
  formGuard.registerRoutes(app, { limiter: opts.formProblemLimiter || createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 }) });

  // ─── Public config (site key only — never expose secret) ───
  app.get('/api/config', (req, res) => {
    res.json({
      turnstile_site_key: turnstileSiteKey || null,
      turnstile_required: Boolean(turnstileSecret),
      storage: storeBundle.kind,
      // Tells the admin UI which auth flows are usable. Login is preferred;
      // legacy is a fallback for existing scripts that still post ADMIN_TOKEN.
      admin_login_enabled: auth.configured,
      admin_legacy_token_enabled: Boolean(adminToken),
      // The admin will only show the publish button when a server-side GitHub
      // token is configured. No secret value is exposed.
      github_publish_enabled: !jobs.enabled && github.isConfigured(),
      github_owner: github.owner,
      github_repo: github.repo,
      github_branch: github.branch,
      github_events_path: PATHS.events,
      github_candidates_path: PATHS.candidates,
      // What the admin needs to word things for this town (docs/admin.js).
      town: { id: town.id, siteName: town.siteName, domain: town.domain, city: town.city, pickName: town.pickName, timezone: town.timezone },
      // The Sources tab uses this to enable or disable Pull Now, which
      // queues a collect for the town's jobs worker.
      sources_trigger_enabled: jobs.enabled,
      sources_actions_url: null,
      // Another town only: whether it may start workflows yet (TOWN_WORKFLOWS=1
      // once its GitHub Environment exists), for scripts/launch_check.py. A
      // flag, no secret. Victoria's config stays exactly as it was until her
      // jobs move to Railway; then it says so too, which GitHub's submission
      // review cron reads to stand down (JOBS_ON_RAILWAY.md phase 5).
      ...(town.id !== VICTORIA.id ? { town_workflows: jobs.enabled || townWorkflowsReady(), jobs_on_railway: jobs.enabled }
        : jobs.enabled ? { jobs_on_railway: true } : {}),
      // A paused town (TOWN_DORMANT=1), for the admin and HQ.
      ...(town.dormant ? { dormant: true } : {})
    });
  });

  // ─── Admin: login ─────────────────────────────────────────────────────
  // Body: { username, password }. Returns { ok, token, expires_at } on success.
  app.post('/api/admin/login', async (req, res) => {
    const burst = loginLimiter.check(clientKey(req));
    if (!burst.ok) {
      res.set('Retry-After', String(burst.retryAfter || 60));
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    if (!auth.configured) {
      return res.status(503).json({
        ok: false,
        error: 'login-not-configured',
        message: 'Set ADMIN_USERNAME, ADMIN_PASSWORD, and ADMIN_SESSION_SECRET to enable login.'
      });
    }
    const body = req.body || {};
    const result = auth.checkLogin({
      username: typeof body.username === 'string' ? body.username : '',
      password: typeof body.password === 'string' ? body.password : ''
    });
    if (!result.ok) {
      recordAuthFailure();
      // Generic message — never disclose which field was wrong.
      return res.status(401).json({ ok: false, error: 'invalid-credentials' });
    }
    const token = auth.signToken();
    const expiresAt = new Date(Date.now() + auth.ttlMs).toISOString();
    res.json({ ok: true, token, expires_at: expiresAt });
  });

  // ─── Admin: sign-in from HQ (server/sso.js) ────────────────────────────
  // HQ posts a one-time pass here (a form POST from the owner's browser).
  // A good pass for this town, inside its minute and never used before,
  // gets the same session token a password login gets, stored by a tiny
  // page that then opens the admin. Anything else is refused the same way.
  // Off (404) until HQ_SSO_SECRET is set; it needs the admin login set up
  // too, since the session is that login's.
  // Trimmed (a stray newline in Railway shouldn't break it), at least
  // MIN_SSO_SECRET long, and never the same as another secret: equal to the
  // read-only HQ_API_KEY it would let anyone holding that key mint admin
  // passes. Anything else leaves it off and says why at boot.
  const ssoSecret = String(opts.ssoSecret ?? process.env.HQ_SSO_SECRET ?? '').trim();
  const ssoClash = [['HQ_API_KEY', opts.hqApiKey ?? process.env.HQ_API_KEY], ['ADMIN_SESSION_SECRET', opts.adminSessionSecret ?? process.env.ADMIN_SESSION_SECRET],
    ['ADMIN_PASSWORD', opts.adminPassword ?? process.env.ADMIN_PASSWORD], ['ADMIN_TOKEN', adminToken]]
    .filter(([, v]) => ssoSecret && v && String(v).trim() === ssoSecret).map(([k]) => k);
  const ssoOn = ssoSecret.length >= MIN_SSO_SECRET && !ssoClash.length;
  if (ssoSecret && !ssoOn) {
    console.warn(`[admin] HQ sign-in is off: HQ_SSO_SECRET ${ssoClash.length ? `is the same as ${ssoClash.join(', ')}` : `is shorter than ${MIN_SSO_SECRET} characters`}; give it its own value`);
  }
  // Its own budget, counting refusals only: opening the admin from HQ a
  // dozen times a day must not lock the owner out of either sign-in.
  const ssoFailures = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  // Pages the sign-in may land on: docs/admin.js PANELS, nothing else.
  const SSO_TABS = new Set(['home', 'attention', 'inbox', 'growth', 'traffic', 'picker', 'submissions', 'preview', 'newsletter', 'sources', 'sponsors', 'settings']);
  app.post('/api/admin/sso', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    if (!ssoOn) return res.status(404).json({ ok: false, error: 'not-found' });
    const who = clientKey(req);
    if (!ssoFailures.peek(who).ok) {
      res.set('Retry-After', '900');
      return res.status(429).type('text').send('Too many failed tries. Wait a few minutes and open the admin from HQ again.');
    }
    const refuse = reason => {
      ssoFailures.check(who);
      recordAuthFailure();
      console.warn('[admin] HQ sign-in refused:', reason);
      return res.status(401).type('text').send('That sign-in link didn\'t work (it may have expired). Open the admin from HQ again.');
    };
    if (!auth.configured) return res.status(503).type('text').send('Admin login isn\'t set up on this town yet.');
    const v = verifyPass(ssoSecret, (req.body || {}).pass, { slug: town.id, siteUrl });
    if (!v.ok) return refuse(v.reason);
    // One use, across every container: the nonce is claimed in the database.
    // No database, no sign-in (never fail open).
    let claimed = false;
    try { claimed = (await store.claimJobRun('hq-sso', v.payload.n)).claimed; } catch (err) { return refuse('nonce store unavailable'); }
    if (!claimed) return refuse('pass already used');
    const token = auth.signToken({ sub: auth.username });
    console.info(`[admin] signed in from HQ as ${v.payload.sub}`);
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
    });
    // The token is base64url and a dot; JSON.stringify plus escaping "<"
    // keeps it a string literal whatever it holds.
    const literal = JSON.stringify(token).replace(/</g, '\\u003c');
    // The admin page HQ's button was for (admin.js openTabFromHash): one of
    // the admin's own page names, else Overview.
    const tab = SSO_TABS.has((req.body || {}).tab) ? `#tab=${req.body.tab}` : '';
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Signing in…</title><p>Signing in…</p>` +
      `<script nonce="${nonce}">try{localStorage.setItem('vic361_admin_session',${literal})}catch(e){}location.replace('/admin.html${tab}')</script>`);
  });

  // ─── Admin: who am I ──────────────────────────────────────────────────
  // Lets the UI silently confirm a stored session is still valid before
  // showing the dashboard, instead of pinging /api/admin/submissions just to
  // probe auth.
  app.get('/api/admin/me', (req, res) => {
    const ok = checkAdminAuth(req);
    if (!ok.ok) return res.status(ok.reason === 'rate-limited' ? 429 : 401).json({ ok: false, error: ok.reason });
    res.json({ ok: true, kind: ok.kind, sub: ok.sub || null });
  });

  // ─── Health ───
  // ?deep=1 also asks the database (for the uptime check), so "the page
  // loads but nothing can be saved or published" counts as down. Plain
  // /api/health stays process-only, so a database blip can't fail a deploy.
  // SELECT 1 with a deadline: rejects on an error or after ms (a hung
  // database accepts the connection and never answers).
  async function pingDatabase(ms) {
    let timer;
    try {
      await Promise.race([
        storeBundle.pool.query('SELECT 1'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('database timeout')), ms); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  app.get('/api/health', async (req, res) => {
    if (req.query.deep && missingDatabase) {
      return res.status(503).json({ ok: false, storage: storeBundle.kind, error: 'no-database' });
    }
    if (req.query.deep && storeBundle.pool) {
      try {
        await pingDatabase(5000);
      } catch (err) {
        console.error('[health] database check failed:', err?.message || err);
        return res.status(503).json({ ok: false, storage: storeBundle.kind, error: 'database' });
      }
    }
    res.json({ ok: true, storage: storeBundle.kind });
  });

  // Express 4 doesn't pass a rejected async handler to the error
  // middleware: the request would hang. This does, so it gets the JSON 500
  // (and the Slack alert with the path).
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ─── Public: submit ───
  app.post('/api/submissions', wrap(async (req, res) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Limits key on the /64 for IPv6 (clientKey), so rotating addresses
    // inside one subscriber's block doesn't buy fresh budgets.
    const burst = submitLimiter.check(clientKey(req));
    if (!burst.ok) {
      formGuard.rejected('submit', req, ['too many submissions (burst limit)']);
      res.set('Retry-After', String(burst.retryAfter || 60));
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    const daily = submitLimiterDaily.check(clientKey(req));
    if (!daily.ok) {
      formGuard.rejected('submit', req, ['too many submissions today']);
      res.set('Retry-After', String(daily.retryAfter || 3600));
      return res.status(429).json({ ok: false, error: 'rate-limited-daily' });
    }

    // Bot signals (honeypot, timing) — cheapest checks first.
    const bot = checkBotSignals(req.body || {});
    if (!bot.ok) {
      // Return 200 to bots so they don't retry/iterate; log for visibility.
      // A trap hit also reaches Slack (once a day), so autofill filling the
      // hidden field for a real organizer can be noticed.
      console.warn('[submissions] bot-signal-block:', bot.reason, ip);
      if (bot.reason === 'honeypot') reportHoneypot('submit', bot.field, { slack });
      return res.json({ ok: true, queued: false });
    }

    const v = validateSubmission(req.body || {});
    if (!v.ok) {
      formGuard.rejected('submit', req, Object.values(v.errors));
      return res.status(400).json({ ok: false, errors: v.errors });
    }

    // The bot check (when TURNSTILE_SECRET_KEY is set). A check that didn't
    // pass no longer turns the event away: it joins the queue labeled, and
    // the review can't approve it on its own (server/submissionReview.js
    // botUnverified). Only a token solved on someone else's site, which
    // none of our visitors send, is refused.
    const ts = await formGuard.botCheck('submit', req, req.body && req.body.turnstile_token);
    if (!ts.ok && ts.error === 'hostname-mismatch') {
      return res.status(400).json({ ok: false, error: 'turnstile-failed' });
    }
    const botNote = ts.ok ? '' : `Bot check didn't pass (${ts.error}); make sure it's a real event before approving.`;

    const dup = await store.findDuplicate({
      date: v.data.payload.date,
      name: v.data.payload.name,
      venue: v.data.payload.venue
    });
    if (dup) {
      formGuard.ok('submit', req);
      return res.json({
        ok: true,
        queued: false,
        duplicate: true,
        message: 'A matching submission is already in our review queue.'
      });
    }

    const now = nowIso();
    const row = {
      id: newId(),
      created_at: now,
      updated_at: now,
      status: 'pending',
      source: 'submission',
      submitter_kind: v.data.submitter_kind,
      submitter_name: v.data.submitter_name,
      submitter_email: v.data.submitter_email,
      submitter_ip: typeof ip === 'string' ? ip.slice(0, 64) : null,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 256),
      payload: normalizePayload(v.data.payload),
      admin_notes: '',
      // placement_emails: sent after /submit said we'd email if it doesn't
      // make its day's list (server/dropNotices.js); earlier ones weren't.
      review_history: [{ at: now, action: 'submitted', note: 'Public submission', placement_emails: true, ...(botNote ? { bot_check: 'failed' } : {}) }]
    };
    if (botNote) row.admin_notes = botNote;
    await store.insert(row);
    formGuard.ok('submit', req);
    const ev = row.payload;
    slack.notify({
      channel: 'inbox',
      title: botNote ? '📝 New event submitted (bot check didn’t pass: check it)' : '📝 New event submitted',
      fields: [['Event', ev.name], ['When', [ev.date, ev.time].filter(Boolean).join(' ')], ['Venue', ev.venue],
        ['From', [row.submitter_name, row.submitter_email].filter(Boolean).join(' · ')]],
      text: ev.description ? ev.description.slice(0, 300) : '',
      link: `${siteUrl}/admin.html`, footer: 'The AI review will publish it or flag it for you, usually within the hour'
    });
    // Tell them it worked and what happens next (no-op without Resend).
    if (row.submitter_email && receiptLimiter.check(row.submitter_email.toLowerCase()).ok) {
      // No paid upsell here: the submit form promises the address isn't
      // used for marketing.
      const mail = renderSubmissionReceived(ev, { siteUrl, address: newsletter.address });
      mailer.send(row.submitter_email, mail, `${town.keyPrefix}-submission-${row.id}`);
    }
    return res.status(201).json({ ok: true, queued: true, id: row.id });
  }));

  // ─── Admin auth middleware ─────────────────────────────────────────────
  // Two acceptable credentials, in priority order:
  //   1. Session token from /api/admin/login (ADMIN_USERNAME / PASSWORD /
  //      SESSION_SECRET). Preferred.
  //   2. Legacy ADMIN_TOKEN (kept so existing scripts still work).
  // If *neither* is configured the API returns 503 so the UI can prompt the
  // operator to finish env setup instead of looking like a generic 401.
  function checkAdminAuth(req) {
    const hdr = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    const provided = m ? m[1] : (req.headers['x-admin-token'] || '');
    if (!provided) return { ok: false, reason: 'missing-credentials' };

    if (auth.configured) {
      const v = auth.verifyToken(provided);
      if (v.ok) return { ok: true, kind: 'session', sub: v.payload.sub };
      // Fall through to legacy token check before giving up.
    }
    if (adminToken) {
      // Session tokens are signed, so only the legacy token can be guessed:
      // throttle wrong ones per client, checked before comparing.
      const key = clientKey(req);
      if (!authFailLimiter.peek(key).ok) return { ok: false, reason: 'rate-limited' };
      if (safeTokenEqual(provided, adminToken)) return { ok: true, kind: 'legacy-token' };
      authFailLimiter.check(key);
      recordAuthFailure();
    }
    return { ok: false, reason: 'unauthorized' };
  }

  function requireAdmin(req, res, next) {
    if (!auth.configured && !adminToken) {
      return res.status(503).json({
        ok: false,
        error: 'admin-not-configured',
        message: 'Set ADMIN_USERNAME + ADMIN_PASSWORD + ADMIN_SESSION_SECRET (recommended) or ADMIN_TOKEN to enable admin endpoints.'
      });
    }
    const result = checkAdminAuth(req);
    if (!result.ok && result.reason === 'rate-limited') {
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    if (!result.ok) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    req.admin = { kind: result.kind, sub: result.sub || null };
    next();
  }

  // The admin's own routes that the owner's assistant also reaches through
  // HQ (server/hqAdmin.js): requireAdmin at /api/admin/..., HQ_REPLY_KEY at
  // /api/hq/admin/... (and nothing else there). Without a usable reply key
  // the /api/hq/ paths don't exist. hqReplyOn is set further down.
  const hqAdminLimiter = opts.hqAdminLimiter || createRateLimiter({ windowMs: 60 * 1000, max: 60 });
  function adminOrHq(req, res, next) {
    if (!req.path.startsWith('/api/hq/')) return requireAdmin(req, res, next);
    if (!hqReplyOn) return res.status(404).json({ ok: false, error: 'not-found' });
    if (!hqAdminLimiter.check(`hq-admin:${clientKey(req)}`).ok) return res.status(429).json({ ok: false, error: 'rate-limited' });
    if (!keyOk(req.get('authorization'), hqReplyKey)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    req.admin = { kind: 'hq', sub: 'hq' };
    next();
  }

  // ─── Admin: list ───
  app.get('/api/admin/submissions', requireAdmin, wrap(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const rows = await store.list({ status: status || undefined });
    res.json({ ok: true, submissions: rows });
  }));

  // ─── Admin: detail ───
  app.get('/api/admin/submissions/:id', requireAdmin, wrap(async (req, res) => {
    const row = await store.get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'not-found' });
    res.json({ ok: true, submission: row });
  }));

  // ─── Admin: status transition ───
  // Body: { status, payload?, admin_notes?, note? }
  // Allowed transitions: pending -> approved|rejected|duplicate, plus edits
  // to payload while pending. "approved" rows show up as candidates the editor
  // can include in the next publish (the existing GitHub-API publish flow on
  // docs/admin.html still owns the actual events.json write).
  app.post('/api/admin/submissions/:id', requireAdmin, wrap(async (req, res) => {
    const out = await decideSubmission(req.params.id, req.body || {});
    res.status(out.code).json(out.json);
  }));

  // The admin's edit/decision on one submission, shared with HQ's
  // POST /api/hq/submissions/:id (`via: 'hq'`, recorded in the history).
  // Answers { code, json } for the route to send.
  async function decideSubmission(id, body, { via = '' } = {}) {
    const row = await store.get(id);
    if (!row) return { code: 404, json: { ok: false, error: 'not-found' } };

    const patch = {};
    const ALLOWED = new Set(['pending', 'approved', 'rejected', 'duplicate']);
    if (body.status !== undefined) {
      if (!ALLOWED.has(body.status)) return { code: 400, json: { ok: false, error: 'bad-status' } };
      patch.status = body.status;
    }
    if (body.payload !== undefined) {
      // Admin edits run validation in lenient mode for submitter contact
      // fields. The public form still enforces first/last/email/phone, but a
      // legacy row created before PR #32 doesn't have those fields and an
      // admin shouldn't have to retype someone else's info to fix a typo on
      // the venue. Format checks (email shape, phone digit count) still run
      // when a value is present. The row-level submitter_email and
      // submitter_name are preserved by leaving them out of the patch.
      const v = validateSubmission(body.payload, { adminEdit: true });
      if (!v.ok) return { code: 400, json: { ok: false, errors: v.errors } };
      patch.payload = normalizePayload(v.data.payload);
      // A changed address replaces the row's, where every email to the
      // submitter goes ("you're live", reminders). Before this the admin
      // couldn't fix one at all: a Star 402 organizer's "...@gmail.comm"
      // bounced with no way to correct it. Blank keeps the old address; a
      // new one gets the public form's checks, typo endings included.
      const newEmail = String(v.data.submitter_email || '').trim();
      if (newEmail && newEmail.toLowerCase() !== String(row.submitter_email || '').toLowerCase()) {
        const email = normalizeEmail(newEmail);
        const err = !email ? 'Email looks invalid.' : impossibleEmailError(email);
        if (err) return { code: 400, json: { ok: false, errors: { submitter_email: err } } };
        patch.submitter_email = email;
      }
    }
    if (typeof body.admin_notes === 'string') {
      patch.admin_notes = body.admin_notes.slice(0, 2000);
    }
    const oldKey = eventKeyOf(row.payload || {});
    const rekeyed = Boolean(patch.payload) && eventKeyOf(patch.payload) !== oldKey;
    const history = Array.isArray(row.review_history) ? row.review_history.slice() : [];
    history.push({
      at: nowIso(),
      action: patch.status ? ('status:' + patch.status) : 'edit',
      ...(patch.submitter_email ? { email_changed: true } : {}),
      note: typeof body.note === 'string' ? body.note.slice(0, 500) : '',
      ...(via ? { via } : {}),
      // The key it had before this edit, so a later un-approve can still
      // find the live event if it kept the old one.
      ...(rekeyed ? { prev_key: oldKey } : {})
    });
    patch.review_history = history;

    const now = (opts.now || (() => new Date()))();
    const wasApproved = row.status === 'approved';
    const isApproved = (patch.status || row.status) === 'approved';
    const updated = await store.update(id, patch);
    const result = { ok: true, submission: updated, unpublished: false };

    // Editing an approved (live) submission updates the live event too.
    if (wasApproved && isApproved && patch.payload) {
      try {
        result.updated_live = await replacePublishedEvent(store, oldKey, patch.payload, now);
        if (result.updated_live) archiveEvents(((await store.getPublished()) || {}).events || []);
      } catch (err) {
        console.warn('[admin] live update after edit failed:', err.message);
        result.updated_live = false;
      }
    }

    // Un-approving takes it off the site too (it may have gone live through
    // auto-publish or the AI review); otherwise it would stay published.
    // Tries every key it has had, so an edit before the reject can't leave
    // the old version up.
    if (wasApproved && !isApproved) {
      let keys = [oldKey, eventKeyOf((updated || {}).payload || {}),
        ...history.map(h => h && h.prev_key).filter(Boolean)];
      // "Duplicate" says the event is listed already. When the collector
      // lists it too (same key, or the same event under another name), the
      // live listing is that one: taking it down would remove the only
      // listing, and recording its key as removed would stop auto-publish
      // from ever putting the collector's copy back. So leave those up.
      if (patch.status === 'duplicate') {
        let collector = [];
        try {
          const c = await readCandidates();
          collector = Array.isArray(c && c.events) ? c.events : [];
        } catch (_) { /* no candidates: unpublish as before */ }
        const listed = k => {
          const ev = parseEventKey(k);
          return collector.some(c => eventKeyOf(c) === k || (ev && sameEvent(c, ev)));
        };
        const before = keys.length;
        keys = keys.filter(k => !listed(k));
        if (keys.length < before) result.kept_listing = true;
      }
      try {
        result.unpublished = keys.length ? await unpublishEvent(store, keys, now) : false;
        // Settles the archive: its page now answers 410 for good.
        if (result.unpublished) archiveEvents(((await store.getPublished()) || {}).events || []);
      } catch (err) {
        console.warn('[admin] unpublish after un-approve failed:', err.message);
      }
    }
    // Someone paid for this one: turning it away needs a refund or a fix.
    if (isPaidPick(row) && (patch.status === 'rejected' || patch.status === 'duplicate') && patch.status !== row.status) {
      slack.notify({ channel: 'sales', title: `⚠️ Paid ${town.pickName} marked ${patch.status}: ${(row.payload || {}).name}`,
        text: `${row.submitter_name || 'The buyer'} (${row.submitter_email || 'no email'}) paid for this pick. ` +
          (patch.status === 'duplicate'
            ? 'Check the Sponsors tab shows it on the site (the pin has to find the listed event); if not, refund it in Stripe.'
            : 'Refund it in Stripe and hide the order in the Sponsors tab.'),
        link: `${siteUrl}/admin.html` });
    }

    // Approving by hand publishes it now (approved submissions only, like
    // the AI review) and emails the submitter once it's live.
    if (!wasApproved && isApproved && updated) {
      try { await forgetRemoved(store, eventKeyOf(updated.payload || {})); } catch (err) {
        console.warn('[admin] clearing removed mark failed:', err.message);
      }
      const res2 = await publishApproved([updated]);
      result.published = res2.published;
      result.live = res2.live[0];
    }
    return { code: 200, json: result };
  }

  // ─── Admin: candidates fetch ──────────────────────────────────────────
  // Tries GitHub first (so the editor sees the latest candidates.json), then
  // falls back to the bundled candidates.json on disk if the token is missing
  // or the GitHub API rejects us. The fallback keeps the admin usable on
  // Railway when GITHUB_TOKEN is unset or expired — the editor can still
  // pick events and publish them; only the GitHub commit step needs the
  // token.
  //
  // Approved submissions from the local store are *always* merged in so the
  // editor sees them in the picker without needing a separate "Pull approved"
  // round trip.
  const candidatesFile = opts.candidatesFile || CANDIDATES_FILE;
  // The collector's latest candidates: the bundled candidates.json (a
  // commit), or with jobs on Railway the copy the last collect handed the
  // site, whichever was collected later. Victoria (no jobs on Railway)
  // reads only the file, as before.
  async function readCandidates() {
    let fromFile = null;
    let fileErr = null;
    try { fromFile = await readJsonFile(candidatesFile); } catch (err) { fileErr = err; }
    // A failed read of the collect's copy fails the whole read: falling back
    // to the bundled file would publish an older collect over a newer one.
    const fromJobs = jobs.enabled ? (((await store.getTownFile('candidates')) || {}).data || null) : null;
    const at = c => Date.parse((c && c.last_updated) || '') || 0;
    if (fromJobs && (!fromFile || at(fromJobs) >= at(fromFile))) return fromJobs;
    if (fileErr) throw fileErr;
    return fromFile;
  }
  app.get('/api/admin/candidates', requireAdmin, async (req, res) => {
    let sha = null;
    let events = [];
    let source = 'unknown';
    let warning = null;

    if (jobs.enabled) {
      try {
        const got = await readCandidates();
        events = Array.isArray(got && got.events) ? got.events : [];
        source = 'jobs';
      } catch (_) { /* fall through to GitHub / the file */ }
    }
    if (source !== 'jobs' && !jobs.enabled && github.isConfigured()) {
      try {
        const got = await github.getJsonFile(PATHS.candidates);
        sha = got.sha;
        events = Array.isArray(got.data && got.data.events) ? got.data.events : [];
        source = 'github';
      } catch (err) {
        console.warn('[admin] candidates github fetch failed, falling back to local file:', err.message);
        warning = `github-fetch-failed-${err.status || 'error'}`;
      }
    }

    if (source !== 'github' && source !== 'jobs') {
      try {
        const local = await readJsonFile(candidatesFile);
        events = Array.isArray(local && local.events) ? local.events : [];
        source = 'local-file';
      } catch (err) {
        if (err.code === 'ENOENT') {
          source = 'empty';
          events = [];
        } else {
          console.error('[admin] local candidates read failed:', err.message);
          return res.status(500).json({
            ok: false, error: 'candidates-read-failed', message: err.message
          });
        }
      }
    }

    // Merge approved submissions so the editor sees them in the picker.
    try {
      const approved = await store.list({ status: 'approved', fromDate: localDateStr(nowFn()) });
      const seen = new Set(events.map(e =>
        [e.date || '', e.name || '', e.venue || ''].join('|')
      ));
      for (const r of approved) {
        const ev = {
          ...withoutSubmitter(r.payload),
          submitted: true, // the event score's community-submission bonus
          _source: r.source || 'submission',
          _source_id: r.id,
          _submitter_kind: r.submitter_kind || null
        };
        const k = [ev.date || '', ev.name || '', ev.venue || ''].join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        events.push(ev);
      }
    } catch (err) {
      console.warn('[admin] approved submissions merge skipped:', err.message);
    }

    // Apply admin event-edits overlay last so the editor sees the corrected
    // version of every candidate, regardless of source. Failures here are
    // best-effort — without overlays the admin still sees the raw events.
    let edits = [];
    try {
      edits = await store.listEventEdits();
    } catch (err) {
      console.warn('[admin] event_edits list failed:', err.message);
    }
    events = applyEventEdits(events, edits);

    res.json({
      ok: true,
      sha,
      source,
      warning,
      data: { events }
    });
  });

  // ─── Admin: edit a candidate event ────────────────────────────────────
  // POST /api/admin/event-edits
  // Body: { original_key, payload: { name, date, time, end_time, venue,
  //         address, description, url, icons, free } }
  //
  // The original_key is the eventKey (date|name|venue) of the candidate row
  // the admin is correcting; the server uses it to attach the edit to the
  // right source row even when the admin changes the date/name/venue. The
  // overlay is applied automatically in /api/admin/candidates and
  // /api/admin/published-events so the picker, preview, newsletter, and
  // published shape all stay in sync — without duplicating the row.
  //
  // This endpoint never publishes to the public site by itself. The admin
  // still has to hit Save & Publish to push the corrected event live, which
  // preserves the existing approval/publish workflow.
  // True when the event an edit targets is known and has no start time:
  // the published list, the collector's candidates or an earlier edit of
  // it. Then the edit may leave the time blank (validateEventEdit). An
  // event that can't be found keeps the requirement.
  async function neverHadTime(key) {
    const found = [];
    const add = list => { for (const e of list || []) if (e && eventKeyOf(e) === key) found.push(e); };
    try { add(((await store.getPublished()) || {}).events); } catch (_) { /* unreadable: unknown */ }
    try { add((await readCandidates()).events); } catch (_) { /* none */ }
    try {
      for (const ed of await store.listEventEdits()) {
        if (ed.original_key === key || eventKeyOf(ed.payload || {}) === key) found.push(ed.payload || {});
      }
    } catch (_) { /* none */ }
    return found.length > 0 && found.every(e => !String(e.time || '').trim());
  }

  app.post('/api/admin/event-edits', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const original_key = typeof body.original_key === 'string'
      ? body.original_key.trim().slice(0, 600)
      : '';
    // Names and venues can contain '|' themselves, so "at least three
    // parts", not exactly three (see parseEventKey).
    if (!original_key || original_key.split('|').length < 3) {
      return res.status(400).json({
        ok: false,
        error: 'bad-original-key',
        message: 'original_key must be "date|name|venue".'
      });
    }
    const v = validateEventEdit(body.payload || {}, { timeOptional: await neverHadTime(original_key) });
    if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });

    try {
      let previousKey = null;
      let target = original_key;
      try {
        const edits = await store.listEventEdits();
        let stored = null;
        try {
          const pub = await store.getPublished();
          stored = new Set(((pub && pub.events) || []).map(eventKeyOf));
        } catch (_) { /* unknown: follow the edit chain as before */ }
        target = resolveEditKey(edits, original_key, stored);
        const prev = edits.find(e => e.original_key === target);
        if (prev) previousKey = eventKeyOf(prev.payload);
      } catch (_) { /* no earlier edit to follow */ }
      const row = await store.upsertEventEdit({
        original_key: target,
        payload: v.data
      });
      // A "Show anyway" (kept) key follows the event to its new name/date.
      try {
        await withPublishedLock(store, async () => {
          const published = await store.getPublished();
          const newKey = eventKeyOf(v.data);
          const old = new Set([original_key, target, previousKey].filter(k => k && k !== newKey));
          if (published && Array.isArray(published.kept) && published.kept.some(k => old.has(k))) {
            await store.setPublished({ ...published, kept: [...new Set(published.kept.map(k => (old.has(k) ? newKey : k)))] });
          }
        });
      } catch (err) {
        console.warn('[admin] kept key not moved:', err.message);
      }
      // The edit can rename a live event (new page URL); archive it now so
      // that URL keeps working after the week rotates out.
      store.getPublished().then(p => p && archiveEvents(p.events)).catch(() => {});
      res.json({
        ok: true,
        edit: row,
        new_key: eventKeyOf(v.data)
      });
    } catch (err) {
      console.error('[admin] event-edit upsert failed:', err.message);
      res.status(500).json({
        ok: false, error: 'event-edit-failed', message: err.message
      });
    }
  });

  // ─── Admin: publish events.json ───────────────────────────────────────
  // Body: { events: [...], message?: "..." [, extras: {...}] }
  //
  // Behavior:
  //   1. Always saves the payload to the local store (Postgres or JSON file)
  //      so the Railway app's public events at /events.json reflects the new
  //      picks immediately, without depending on GitHub.
  //   2. If GITHUB_TOKEN is configured, also commits docs/events.json on the
  //      configured branch via the Contents API. Failures here are surfaced
  //      but do NOT fail the request — the local save already succeeded and
  //      the public site is updated.
  //   3. Preserves top-level extras like `new_and_notable` and `sponsor`.
  //      The admin UI only edits the events list; if the request body does
  //      not include `extras`, we carry forward whatever was on the most
  //      recent published payload (Railway Postgres, then the bundled
  //      docs/events.json fallback). This stops events-only publishes from
  //      silently wiping out the New & Notable section and the sponsor
  //      block. Callers can also send `extras: { new_and_notable, sponsor }`
  //      explicitly to update them.
  app.post('/api/admin/publish-events', requireAdmin, async (req, res) => {
    const body = req.body || {};
    // score/overflow/keep are worked out on read (server/scoring.js; keep
    // comes from the `kept` list), never stored on an event: a stored copy
    // would go stale or outlive the admin's Undo.
    const events = Array.isArray(body.events)
      ? body.events.map(ev => {
        if (!ev || typeof ev !== 'object') return ev;
        const { score: _s, overflow: _o, keep: _k, editor_pick: pick, sponsor_order: _so, ...rest } = ev;
        // An editor's pick is `featured` only on read (pickDays); storing
        // it would pin it for good. sponsor_order is put on paid picks on
        // read too (applyPlacements).
        if (pick) delete rest.featured;
        return rest;
      })
      : null;
    if (!events) {
      return res.status(400).json({ ok: false, error: 'bad-payload', message: 'events[] required' });
    }
    // The editor sends the version of the live list it started from. If
    // something published since (an AI-approved submission, a collect run),
    // publishing this older picture would silently take those events down,
    // so refuse; the editor reloads the live list and keeps its changes.
    // A read that fails is not "nothing published": treating it so would
    // skip this check and take the extras (hidden, kept, auto_publish) from
    // the bundled file, wiping them if the write then succeeds. Refuse
    // instead; the editor keeps its changes and can retry.
    const storeDown = err => {
      console.warn('[admin] published lookup failed, not publishing:', err.message);
      return res.status(503).json({ ok: false, error: 'store-unavailable',
        message: "The database didn't answer, so nothing was published. Your changes are kept; try again in a minute." });
    };
    // From the version check to the write under the published-payload lock,
    // so an auto-publish or approval can't land between them and be undone.
    // Null when a response was already sent.
    const payload = await withPublishedLock(store, async () => {
      let current;
      try { current = await store.getPublished(); } catch (err) { storeDown(err); return null; }
      if (typeof body.based_on === 'string' && body.based_on) {
        if (current && current.last_updated && current.last_updated !== body.based_on) {
          res.status(409).json({ ok: false, error: 'stale',
            message: 'New events went live since you opened this page. The list has been reloaded with your changes kept; check it and publish again.' });
          return null;
        }
      }

      // Carry-forward top-level extras (new_and_notable, sponsor, …) so an
      // events-only Save & Publish doesn't drop them. Priority order:
      //   1. body.extras (caller explicitly provided them)
      //   2. last published payload from the store
      //   3. bundled docs/events.json on disk
      // partners is put on at read time (sponsors.js applyPlacements).
      const PROTECTED_KEYS = new Set(['last_updated', 'events', 'partners']);
      const extras = {};
      const explicit = (body.extras && typeof body.extras === 'object' && !Array.isArray(body.extras))
        ? body.extras : null;
      if (explicit) {
        for (const [k, v] of Object.entries(explicit)) {
          if (!PROTECTED_KEYS.has(k)) extras[k] = v;
        }
      } else {
        // Previously published first (read above).
        let prior = current;
        if (!prior) {
          // Fall back to the bundled snapshot.
          try { prior = await readJsonFile(EVENTS_FILE); }
          catch (_) { prior = null; }
        }
        if (prior && typeof prior === 'object') {
          for (const [k, v] of Object.entries(prior)) {
            if (!PROTECTED_KEYS.has(k)) extras[k] = v;
          }
        }
      }

      const payload = Object.assign({}, extras, {
        last_updated: new Date().toISOString(),
        events
      });

      // Step 1 — local persistence. This is what makes the Railway public site
      // reflect the new picks regardless of GitHub state.
      try {
        await store.setPublished(payload);
        archiveEvents(events);
      } catch (err) {
        console.error('[admin] local publish save failed:', err.message);
        res.status(500).json({
          ok: false, error: 'local-publish-failed', message: err.message
        });
        return null;
      }
      return payload;
    });
    if (!payload) return;


    const result = {
      ok: true,
      published: events.length,
      last_updated: payload.last_updated,
      destinations: { local: { ok: true } }
    };

    // Step 2 — best-effort GitHub commit. Only attempted when configured,
    // and never for a town whose jobs run on Railway: its events live in its
    // database only (docs/events.json stays as Victoria's frozen fallback).
    if (jobs.enabled) {
      result.destinations.github = { ok: false, error: 'github-not-configured', message: 'Events live in the database (jobs on Railway); nothing is committed to GitHub.' };
    } else if (github.isConfigured()) {
      let sha = null;
      try {
        const cur = await github.getJsonFile(PATHS.events);
        sha = cur.sha;
      } catch (err) {
        if (err.status !== 404) {
          console.warn('[admin] events.json sha fetch failed:', err.message);
        }
      }
      const message = (typeof body.message === 'string' && body.message.trim())
        ? body.message.trim().slice(0, 200)
        : `Publish events ${new Date().toISOString().slice(0, 10)} (${events.length} picks)`;
      try {
        const gh = await github.putJsonFile(PATHS.events, payload, message, sha);
        result.destinations.github = {
          ok: true,
          commit: gh && gh.commit ? {
            sha: gh.commit.sha,
            html_url: gh.commit.html_url
          } : null
        };
        result.commit = result.destinations.github.commit;
      } catch (err) {
        console.error('[admin] github publish failed (local save still succeeded):', err.message);
        result.destinations.github = {
          ok: false,
          error: 'publish-failed',
          message: err.detail || err.message
        };
        result.warning = 'github-publish-failed';
      }
    } else {
      result.destinations.github = {
        ok: false,
        error: 'github-not-configured',
        message: 'GITHUB_TOKEN is not set; events were saved to Railway but not committed to GitHub.'
      };
    }

    res.json(result);
  });

  const eventsFile = opts.eventsFile || EVENTS_FILE;
  // ─── Admin: currently-published events ───
  // Returns the events payload that is currently being served on /events.json
  // so the admin picker can pre-check rows that are already live. Source
  // priority:
  //   1. Local store (Railway/Postgres). This is what the public site is
  //      actually serving for any session that has hit Save & Publish since
  //      Railway took over publishing.
  //   2. Bundled docs/events.json on disk. This is the source of truth when
  //      the admin hasn't published since PR #47 deployed (so the local store
  //      is empty), but the public site still shows whatever the most recent
  //      GitHub publish committed to docs/events.json.
  // Without the file fallback, a fresh deploy with a non-empty docs/events.json
  // and an empty Railway store would show every published event as unchecked
  // in the admin — which is exactly what the user reported.
  app.get('/api/admin/published-events', requireAdmin, async (req, res) => {
    try {
      let published = null;
      let source = 'store';
      try {
        published = await store.getPublished();
      } catch (err) {
        console.warn('[admin] published-events store lookup failed:', err.message);
      }
      if (!published) {
        // Fall back to the bundled events.json snapshot. This is the file
        // GitHub Pages / Railway statically served before Railway took over
        // publishing, and it remains a faithful picture of "currently live"
        // until the admin hits Save & Publish under the new flow.
        try {
          const bundled = await readJsonFile(eventsFile);
          if (bundled && Array.isArray(bundled.events)) {
            published = bundled;
            source = 'docs-file';
          }
        } catch (err) {
          if (err.code !== 'ENOENT') {
            console.warn('[admin] published-events file fallback failed:', err.message);
          }
        }
      }
      if (!published) {
        return res.json({
          ok: true, events: [], last_updated: null, source: 'empty'
        });
      }
      let events = Array.isArray(published.events) ? published.events : [];
      // Apply the same admin edits overlay so a correction made in the editor
      // shows up immediately on the live site for every event whose published
      // identity still matches the overlay's original_key. New picks go
      // through publish-events and already store the edited shape there.
      try {
        const edits = await store.listEventEdits();
        events = applyEventEdits(events, edits);
      } catch (err) {
        console.warn('[admin] published-events overlay skipped:', err.message);
      }
      // Score and whether each event made its day's list (server/scoring.js),
      // as the public site sees it, for the admin's "Dropped" label.
      let scored = new Map();
      try {
        scored = new Map((await getPublicPayload()).events.map(e => [eventKeyOf(e), e]));
      } catch (err) {
        console.warn('[admin] published-events scoring skipped:', err.message);
      }
      events = events.map(ev => {
        const s = scored.get(eventKeyOf(ev));
        return s ? { ...ev, score: s.score, overflow: Boolean(s.overflow), keep: Boolean(s.keep), editor_pick: Boolean(s.editor_pick) } : ev;
      });
      res.json({
        ok: true,
        events,
        last_updated: published.last_updated || null,
        source
      });
    } catch (err) {
      console.error('[admin] published-events lookup failed:', err.message);
      res.status(500).json({
        ok: false,
        error: 'published-lookup-failed',
        message: err.message
      });
    }
  });

  // ─── Admin: show a dropped event anyway ──────────────────────────────
  // Body: { key: "date|name|venue", keep: true|false }. A day shows its best
  // 15 (Mon–Thu) or 20 (Fri–Sun) events by score; `keep` puts one back in
  // whatever its score. Stored in the published payload (`kept`), like the
  // event check's hidden list, so Save & Publish and auto-publish carry it
  // forward; keys start with the date, so past ones age out.
  app.post('/api/admin/keep-event', requireAdmin, async (req, res) => {
    const key = String(req.body && req.body.key || '').slice(0, 600);
    const keep = Boolean(req.body && req.body.keep);
    if (!parseEventKey(key)) {
      return res.status(400).json({ ok: false, error: 'bad-key' });
    }
    try {
      const done = await withPublishedLock(store, async () => {
        const published = await store.getPublished();
        if (!published) return false;
        const today = localDateStr(nowFn());
        const kept = new Set((Array.isArray(published.kept) ? published.kept : []).filter(k => String(k).slice(0, 10) >= today));
        if (keep) kept.add(key); else kept.delete(key);
        await store.setPublished({ ...published, kept: [...kept] });
        return true;
      });
      if (!done) return res.status(404).json({ ok: false, error: 'nothing-published' });
      res.json({ ok: true, key, keep });
    } catch (err) {
      console.error('[admin] keep-event failed:', err.message);
      res.status(500).json({ ok: false, error: 'keep-failed', message: err.message });
    }
  });

  // ─── Admin: per-source pull status ───────────────────────────────────
  // Returns a compact summary of what the weekly collector pulled this run,
  // which sources fed the candidate list, when each one was pulled, and
  // when the next auto-pull is due. The admin "Sources" tab consumes this.
  //
  // The data comes from `collection_metadata.json` (written next to
  // candidates.json by collect_events.py). If the file is missing — e.g.
  // before the first weekly run after this code ships — we still return a
  // useful payload with placeholder rows + the next scheduled run time.
  const metadataFile = opts.collectionMetadataFile || COLLECTION_METADATA_FILE;
  app.get(hqPaths('/api/admin/sources'), adminOrHq, async (req, res) => {
    try {
      let read = await readMetadataFile(metadataFile);
      // With jobs on Railway the last collect handed its metadata to the
      // site; it wins when it's newer than the bundled file.
      if (jobs.enabled) {
        const f = await store.getTownFile('collection_metadata').catch(() => null);
        const ran = m => Date.parse((m && m.last_run_at) || '') || 0;
        if (f && f.data && (!read || ran(f.data) >= ran(read.meta))) read = { meta: f.data, mtime: new Date(f.updated_at) };
      }
      const payload = buildSourcesPayload({
        metadata: read ? read.meta : null,
        mtime: read ? read.mtime : null,
        now: new Date(),
        // Pull Now queues a collect for the jobs worker.
        githubConfigured: jobs.enabled,
        actionsUrl: null,
      });
      res.json(payload);
    } catch (err) {
      console.error('[admin] sources lookup failed:', err.message);
      res.status(500).json({ ok: false, error: 'sources-failed', message: err.message });
    }
  });

  // ─── Admin: Pull Now (queue a collect) ────────────────────────────────
  // POST /api/admin/trigger-collect
  // Queues a collect for the town's jobs worker (JOBS_ON_RAILWAY.md). A
  // town without jobs on Railway can't collect from here: 409
  // 'jobs-not-on'. `save_publish_unaffected: true` on every failure, so the
  // UI never implies that Save & Publish failed.
  app.post('/api/admin/trigger-collect', requireAdmin, async (req, res) => {
    // Jobs on Railway: queue it for the town's jobs worker.
    if (jobs.enabled) {
      try {
        const q = await jobs.enqueue('collect', `manual-${nowFn().toISOString()}`);
        if (!q.queued) return res.json({ ok: true, queued: false, already: true, message: 'A collect is already queued or running; its events publish as soon as it finishes.' });
        return res.json({ ok: true, queued: true, message: 'Collect queued. It takes about half an hour; the new events publish as soon as it finishes.' });
      } catch (err) {
        return res.status(500).json({ ok: false, error: 'queue-failed', message: err.message, save_publish_unaffected: true });
      }
    }
    return res.status(409).json({
      ok: false,
      error: 'jobs-not-on',
      message: "This town's jobs don't run on Railway yet (JOBS_ON_RAILWAY=1, JOBS_SECRET and its jobs service), so Pull Now is off. Save & Publish is unaffected.",
      save_publish_unaffected: true
    });
  });

  // ─── Admin: approved -> candidate-shaped events ───
  // Returns approved submissions in the same shape as candidates.json events
  // so the existing admin picker/publish flow can ingest them by simply
  // appending them to the candidate list before publishing.
  app.get('/api/admin/approved-events', requireAdmin, wrap(async (req, res) => {
    const rows = await store.list({ status: 'approved', fromDate: localDateStr(nowFn()) });
    let events = rows.map(r => ({
      ...withoutSubmitter(r.payload),
      submitted: true, // the event score's community-submission bonus
      _source: r.source || 'submission',
      _source_id: r.id,
      _submitter_kind: r.submitter_kind || null
    }));
    try {
      const edits = await store.listEventEdits();
      events = applyEventEdits(events, edits);
    } catch (err) {
      console.warn('[admin] approved-events overlay skipped:', err.message);
    }
    res.json({ ok: true, events });
  }));

  // ─── Traffic (admin Traffic tab, see server/analytics.js) ───
  // Daily visitor hashes are salted with a server secret so they can't be
  // reversed to an IP. A random salt (when no secret is set) just means
  // visitor counts reset on restart.
  const analyticsSecret = opts.analyticsSecret ?? process.env.ADMIN_SESSION_SECRET ?? crypto.randomBytes(16).toString('hex');
  const trackLimiter = opts.trackLimiter || createRateLimiter({ windowMs: 60 * 1000, max: 120 });
  // Sponsor and Vic's Pick reports count impressions and clicks on an
  // order's ad (and taps on its link), and the order id is public
  // (data-ad), so a script could post beacons all day to pad a report. Each
  // client address (ipKey) counts at most this many of each per ad (or
  // link) per day; a real reader browsing page after page stays under it.
  const AD_BEACON_DAILY = { impression: 20, click: 5 };
  const adBeacons = { day: '', counts: new Map() };
  function adBeaconAllowed(row, req) {
    const target = row.ad || (row.kind === 'click' && /^(sponsor|event)_click$/.test(row.click_type) ? row.click_url : '');
    if (!target || !AD_BEACON_DAILY[row.kind]) return true;
    if (adBeacons.day !== row.day) { adBeacons.day = row.day; adBeacons.counts.clear(); }
    const key = `${clientKey(req)}|${target}|${row.kind}`;
    const n = adBeacons.counts.get(key) || 0;
    if (n >= AD_BEACON_DAILY[row.kind]) return false;
    // Bounded memory: a flood of made-up ad ids from many addresses stops
    // being counted for the rest of the day instead of growing the map.
    if (!n && adBeacons.counts.size >= 100000) return false;
    adBeacons.counts.set(key, n + 1);
    return true;
  }

  app.post('/api/track', async (req, res) => {
    // Always 204: the beacon never waits on or reacts to the answer.
    res.status(204).end();
    if (typeof store.recordTraffic !== 'function') return;
    const ip = req.ip || req.socket.remoteAddress || '';
    if (!trackLimiter.check(clientKey(req)).ok) return;
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return; } }
    const row = beaconRow(body, {
      ip, ua: req.get('user-agent') || '', secret: analyticsSecret,
      siteHost: new URL(siteUrl).host, now: nowFn()
    });
    if (!row || !adBeaconAllowed(row, req)) return;
    try { await store.recordTraffic(row); } catch (err) {
      console.warn('[traffic] record failed:', err.message);
    }
  });

  // Meta Pixel for ads (server/metaPixel.js). Short cache so setting or
  // changing META_PIXEL_ID takes effect within minutes of a redeploy.
  const metaPixelScript = metaPixelJs(pixelId(opts.metaPixelId ?? process.env.META_PIXEL_ID));
  // The "Did you mean ...@gmail.com?" note on every email field.
  app.get('/emailcheck.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(EMAIL_CHECK_JS);
  });

  app.get('/pixel.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300').send(metaPixelScript);
  });

  app.get(hqPaths('/api/admin/traffic'), adminOrHq, async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    if (typeof store.listTraffic !== 'function') return res.json({ ok: false, error: 'not-supported' });
    try {
      const now = nowFn();
      const since = new Date(now.getTime() - (days + 1) * 86400000).toISOString().slice(0, 10);
      const rows = await store.listTraffic(since);
      res.set('Cache-Control', 'no-store');
      res.json(summarize(rows, { now, days }));
    } catch (err) {
      console.error('[traffic] summary failed:', err.message);
      res.status(500).json({ ok: false, error: 'traffic-failed', message: err.message });
    }
  });

  // Every event's week, for pitching venues a Vic's Pick (admin Traffic →
  // Event stats). ?week=<Monday>; default last week. Live and archived
  // events listed that week, plus the week's newsletter reach.
  app.get(hqPaths('/api/admin/event-stats'), adminOrHq, async (req, res) => {
    if (typeof store.listTraffic !== 'function') return res.json({ ok: false, error: 'not-supported' });
    try {
      const thisMonday = currentWeek(localDateStr(nowFn()))[0];
      const asked = String(req.query.week || '');
      const start = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? currentWeek(asked)[0] : addDays(thisMonday, -7);
      const end = addDays(start, 6);
      const [rows, payload, archived] = await Promise.all([
        store.listTraffic(addDays(start, -LEAD_IN_DAYS)), getPublicPayload(), listArchived().catch(() => [])
      ]);
      const events = [...((payload && payload.events) || []), ...(archived || [])];
      // That week's two issues: Monday's (keyed by `start`) and Thursday's.
      let recipients = 0, opens = 0;
      const weekend = { recipients: 0, opens: 0 };
      try {
        const thu = addDays(start, 3);
        const [mon, wk] = typeof store.getNewsletterSend === 'function'
          ? await Promise.all([store.getNewsletterSend(start), store.getNewsletterSend(thu)]) : [null, null];
        recipients = mon ? Number(mon.recipients) || 0 : 0;
        weekend.recipients = wk ? Number(wk.recipients) || 0 : 0;
        if (typeof store.countEmailOpens === 'function') {
          const o = await store.countEmailOpens([start, thu]);
          opens = o[start] || 0;
          weekend.opens = o[thu] || 0;
        }
      } catch { /* the table still shows without the newsletter line */ }
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, week_start: start, week_end: end, this_week: start === thisMonday,
        newsletter: { recipients, opens, weekend }, events: eventWeekStats(rows, events, { start, end }) });
    } catch (err) {
      console.error('[traffic] event stats failed:', err.message);
      res.status(500).json({ ok: false, error: 'event-stats-failed', message: err.message });
    }
  });

  // The rounded reach (server/seo.js reachNumbers) for the static submit
  // page's thank-you. Counts only; null below each threshold.
  app.get('/api/reach', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({ ok: true, ...reachNumbers(reachNow() || {}) });
  });

  // What people did on the site (server/activity.js): views, clicks,
  // shares, calendar adds, ad views and the issues' opens, per day and per
  // event. For the owner's assistant through HQ; ?days=1..90, default 7.
  app.get(hqPaths('/api/admin/activity'), adminOrHq, async (req, res) => {
    if (typeof store.listTraffic !== 'function') return res.json({ ok: false, error: 'not-supported' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), ACTIVITY_MAX_DAYS);
    try {
      const now = nowFn();
      const [rows, payload, archived, sends] = await Promise.all([
        store.listTraffic(addDays(localDateStr(now), -days)), getPublicPayload(), listArchived().catch(() => []),
        typeof store.listNewsletterSends === 'function' ? store.listNewsletterSends(Math.ceil(days / 7) * 2 + 2).catch(() => []) : []
      ]);
      // A failed read leaves the opens off, not the report.
      const opens = sends.length && typeof store.countEmailOpens === 'function'
        ? await store.countEmailOpens(sends.map(s => s.week_key)).catch(() => ({})) : {};
      const events = [...((payload && payload.events) || []), ...(archived || [])];
      res.set('Cache-Control', 'no-store');
      res.json(activitySummary(rows, { now, days, events, sends, opens }));
    } catch (err) {
      console.error('[activity] summary failed:', err.message);
      res.status(500).json({ ok: false, error: 'activity-failed', message: err.message });
    }
  });

  // ─── Public events feed ───
  // The live payload is the published row in the store (with the admin
  // event-edits overlay applied). When nothing has been published yet we
  // fall back to the bundled docs/events.json from the deploy. Both the
  // JSON feed and the server-rendered pages below read through here so
  // they always agree.
  // Paid placements (sponsor of the week, featured events, venue partners)
  // are layered on at read time so every consumer sees the same thing.
  let venues = [];

  // Every public view reads this. capDays (server/scoring.js) scores each
  // event and marks the ones past their day's limit `overflow`: the day
  // lists below leave those out (shownPayload), while event pages, guides
  // and the sitemap keep them.
  // strict: paid placements must be read, or this throws (the newsletter).
  // now: whose week's sponsor to apply (the newsletter preview of next
  // Monday's issue shows next week's sponsor); defaults to the clock.
  async function getPublicPayload({ strict = false, now } = {}) {
    const payload = await sponsors.apply(await loadPublicPayload(), { strict, now });
    // `kept`: events the admin chose to show anyway (POST
    // /api/admin/keep-event), by key; they skip the daily limit.
    const kept = new Set(Array.isArray(payload.kept) ? payload.kept : []);
    const events = (payload.events || []).map(ev => kept.has(eventKeyOf(ev)) ? { ...ev, keep: true } : ev);
    return { ...payload, events: pickDays(capDays(events, { venues })) };
  }

  async function shownPayload(opts) {
    const payload = await getPublicPayload(opts);
    return { ...payload, events: shown(payload.events) };
  }

  // The last edits list read, for when the next read fails: dropping the
  // overlay would put every corrected name and time back to the raw one.
  let lastEdits = [];
  // The public events of a published payload, with the edits overlay
  // applied and hidden events left out, still carrying original keys.
  async function visibleFrom(published) {
    let edits = lastEdits;
    try {
      edits = lastEdits = await store.listEventEdits();
    } catch (err) {
      console.warn('[events] overlay read failed, using the last one:', err.message);
    }
    return visibleKeyed({ ...published, events: await reservePages(published.events) }, edits);
  }

  // Each stored event with the page it was last archived under (`_page`,
  // matched by original key), so withPages keeps a same-name, same-date
  // pair's -2/-3 suffixes where they were first handed out instead of
  // renumbering them when a newcomer sorts first. Without the archive
  // (unreadable, or a store without one) pages are numbered as before.
  async function reservePages(events) {
    const list = Array.isArray(events) ? events : [];
    let rows = [];
    try { rows = await listArchived(); } catch (_) { return list; }
    if (!rows.length) return list;
    const pageOf = new Map();
    for (const row of rows) {
      const k = row && (row._okey || eventKeyOf(row));
      if (k && row.page && !pageOf.has(k)) pageOf.set(k, row.page);
    }
    return list.map(ev => {
      const page = ev && pageOf.get(eventKeyOf(ev));
      return page ? { ...ev, _page: page } : ev;
    });
  }

  // The last payload read from the store. A failed read serves this copy
  // (at most minutes old) rather than the bundled docs/events.json, which
  // is months old and all past events: an empty week for every visitor,
  // cached by browsers and Googlebot. The bundle is only for a process
  // that has never read the store.
  let lastGood = null;
  async function loadPublicPayload() {
    try {
      const published = await store.getPublished();
      if (published) {
        // The published payload keeps original event identities; the
        // overlay maps original_key -> corrected shape so a correction made
        // between publishes shows up without another Save & Publish.
        // Events the event check hid stay published but off the site
        // (server/eventcheck.js matches them by original key).
        lastGood = { ...published, events: stripKeys(await visibleFrom(published)).map(withoutSubmitter), source: 'store' };
        return lastGood;
      }
    } catch (err) {
      console.warn('[events] published lookup failed:', err.message);
      if (lastGood) {
        slack.alert('db-read', 'Database unreachable: the site is serving its last good copy of the event list', err.message);
        return { ...lastGood, source: 'last-good' };
      }
      // The bundled copy is months old; visitors see past events until the
      // database is back, so this must not be quiet.
      slack.alert('db-read', 'Database unreachable: the site is serving the old bundled event list', err.message);
    }
    try {
      const raw = await readJsonFile(eventsFile);
      const bundled = previewSample ? { ...raw, events: shiftToWeek(raw.events, localDateStr(nowFn())) } : raw;
      // The bundled copy can carry a `hidden` list too (Save & Publish
      // commits the whole payload), so a database outage hides the same.
      return { ...bundled, events: stripKeys(visibleKeyed(bundled, [])).map(withoutSubmitter), source: 'bundled' };
    } catch (err) {
      console.warn('[events] bundled events.json unreadable:', err.message);
      return { events: [], source: 'empty' };
    }
  }

  // In-memory copy of the archive (see listArchived). Declared before the
  // boot backfill below, which clears it.
  const ARCHIVE_TTL_MS = 5 * 60 * 1000;
  let archiveCache = null;

  // Keep every published event's page alive after its week rotates out
  // (see archiveEvents in db.js). Best-effort: a failure here must never
  // block a publish or a page view.
  // Archive what the site actually shows: the edits overlay changes names
  // (and so page slugs), and those are the URLs people share.
  // Calls run one after another, so an older list can't settle pages
  // (below) against a newer publish.
  let archiveChain = Promise.resolve();
  function archiveEvents(events) {
    if (typeof store.archiveEvents !== 'function') return Promise.resolve();
    archiveCache = null;
    const run = async () => {
      let edits = [];
      let editsOk = true;
      try {
        if (typeof store.listEventEdits === 'function') edits = await store.listEventEdits();
      } catch (_) { editsOk = false; }
      // Original keys ride along (_okey), so a later rename can be traced.
      const pages = keyedEvents(await reservePages(events), edits);
      await store.archiveEvents(pages);
      // Without the overlay every edited event would look taken down.
      if (editsOk) await settleArchive(pages);
    };
    archiveChain = archiveChain.then(run)
      .then(() => { archiveCache = null; })
      .catch(err => console.warn('[events] archive skipped:', err.message));
    return archiveChain;
  }

  // The live event an archived page now lives as: same original key, the
  // same key under another page (renumbered), or the one live listing of
  // the same event (auto-publish completing a cut-off name renames it).
  function successorOf(old, live) {
    const oldKey = eventKeyOf(old);
    const byKey = live.find(e => (old._okey && e._okey === old._okey) || e._okey === oldKey || eventKeyOf(e) === oldKey);
    if (byKey) return byKey;
    const same = live.filter(e => sameEvent(e, old));
    return same.length === 1 ? same[0] : null;
  }

  // An upcoming page this publish no longer shows was renamed, re-dated
  // or taken down (an un-approved submission, removed in Save & Publish,
  // retired by auto-publish). Its archive row records which: _moved_to
  // (the page 301s there) or _removed (410, before and after its date, and
  // left out of venue and seasonal guides). Without this the old URL of a
  // renamed event answered 410 while the event was still on, and a
  // deliberately removed event came back as a normal page once its date
  // passed. Publishing the page again overwrites the row and clears both.
  async function settleArchive(pages) {
    if (typeof store.listArchivedEvents !== 'function') return;
    const today = localDateStr((opts.now || (() => new Date()))());
    const livePages = new Set(pages.map(e => e.page));
    const updates = [];
    for (const old of await store.listArchivedEvents()) {
      if (!old || !old.page || livePages.has(old.page) || old._moved_to || old._removed) continue;
      // Past pages rotated out of the week; they keep their archive page.
      if (!(old.date >= today)) continue;
      const next = successorOf(old, pages);
      updates.push(next ? { ...old, _moved_to: next.page } : { ...old, _removed: nowIso() });
    }
    if (updates.length) await store.archiveEvents(updates);
  }

  // Backfill the archive with whatever is live at boot, so pages published
  // before the archive existed are covered too.
  const archiveReady = store.getPublished()
    .then(p => p && archiveEvents(p.events))
    .catch(err => console.warn('[events] archive backfill skipped:', err.message));

  async function serveEventsJson(req, res, next) {
    try {
      // auto_publish and the hidden lists are bookkeeping, not public.
      // The homepage app and social kit read this: day lists. ?all=1 is
      // every public event, with `overflow` on the ones past their day's
      // limit (they're public anyway: own page, guides), for the event check
      // and submission review, which must see everything that's live.
      const all = req.query.all === '1';
      const { source, auto_publish: auto, hidden: _h, hidden_restored: _r, kept: _k, ...payload } =
        all ? await getPublicPayload() : await shownPayload();
      if (source === 'empty') return next();
      // The score and the admin's keep flag are internal (server/scoring.js).
      payload.events = payload.events.map(({ score: _s, keep: _kp, overflow, ...ev }) =>
        (all && overflow ? { ...ev, overflow: true } : ev));
      // editor_pick stays: it tells an editor's Vic's Pick from a paid one.
      // Store-backed payloads change on publish, and a fallback copy
      // (database down) must be replaced the moment the database is back.
      res.set('Cache-Control', 'no-store');
      // collected_at: the candidates.json (its last_updated) auto-publish
      // last put live. Unlike last_updated, an approved submission or an
      // admin edit doesn't move it, so the event check can wait for the
      // new collect and the uptime check can tell a stalled collector.
      if (auto && auto.from) payload.collected_at = auto.from;
      return res.json(payload);
    } catch (err) {
      next(err);
    }
  }
  app.get('/events.json', serveEventsJson);
  app.get('/docs/events.json', serveEventsJson);

  // Turnstile for the other public forms (contact, newsletter signup, sponsor
  // checkout). Off until TURNSTILE_SECRET_KEY is set, like /api/submissions.
  async function verifyHuman(req) {
    const b = req.body || {};
    const token = b['cf-turnstile-response'] || b.turnstile_token;
    const r = await verifyTurnstile(typeof token === 'string' ? token : '', {
      secret: turnstileSecret, remoteip: req.ip, fetch: opts.fetch, hostnames: turnstileHosts
    });
    // The visitor only sees "try again", so the reason is logged here: a
    // pattern of failures from the Facebook/Instagram in-app browser (where
    // ad taps land) is a form bug worth fixing, a lone one isn't.
    if (!r.ok) {
      const ua = String(req.get('user-agent') || '');
      const inApp = /FBAN|FBAV/.test(ua) ? 'facebook' : /Instagram/.test(ua) ? 'instagram' : 'no';
      console.warn('[turnstile] rejected:', req.path, r.error, (r.codes || []).join(',') || '-', 'in-app:', inApp);
    }
    return r.ok;
  }

  // Cron secrets, one per endpoint: NEWSLETTER_CRON_SECRET (newsletter
  // send), EVENT_CHECK_SECRET (hide events), SUBMISSION_REVIEW_SECRET
  // (approve and publish submissions). The fallbacks below (and the same
  // chain in the jobs worker's scripts) keep setups made before the later
  // two existed working, but then one leaked value grants
  // all three, so the setup checklist flags a shared secret.
  const eventCheckSecret = opts.eventCheckSecret ??
    (process.env.EVENT_CHECK_SECRET || process.env.NEWSLETTER_CRON_SECRET || '');
  const submissionReviewSecret = opts.submissionReviewSecret ??
    (process.env.SUBMISSION_REVIEW_SECRET || process.env.EVENT_CHECK_SECRET || process.env.NEWSLETTER_CRON_SECRET || '');

  // Growth (server/growth.js): Admin → Growth, and Meta's daily ad spend
  // from scripts/meta_ads.py. ADS_SPEND_SECRET, else the submission review
  // secret (the jobs worker sends the same fallback); it can only add numbers.
  const adsSpendSecret = opts.adsSpendSecret ?? (process.env.ADS_SPEND_SECRET || submissionReviewSecret);
  registerGrowth(app, {
    store, requireAdmin, adminOrHq, nowFn: () => (opts.now || (() => new Date()))(), secret: adsSpendSecret,
    getEvents: async () => [...(((await getPublicPayload()) || {}).events || []), ...(await listArchived().catch(() => []))],
    getOrders: async () => (typeof store.listSponsorOrders === 'function' ? store.listSponsorOrders() : [])
  });

  // The town's jobs worker (server/jobs.js): claim, finish, hand over files.
  jobs.register(app);

  // GitHub workflows' alerts into the owner inbox (server/opsReport.js).
  registerOpsReport(app, {
    secret: opts.opsReportSecret ?? (process.env.OPS_REPORT_SECRET || submissionReviewSecret),
    slack, json: smallJson, siteUrl, clientKey,
    limiter: opts.opsLimiter || createRateLimiter({ windowMs: 60 * 60 * 1000, max: 120 })
  });

  // ─── Newsletter (Resend; see server/newsletter.js) ───
  // Event check (server/eventcheck.js): hide what the weekly check is sure
  // about, restore from admin Home.
  registerEventCheck(app, {
    store, requireAdmin, adminOrHq, nowFn: () => (opts.now || (() => new Date()))(),
    secret: eventCheckSecret,
    loadVisibleKeyed: async () => visibleFrom((await store.getPublished()) || {}),
    placements: payload => sponsors.apply(payload, { strict: true })
  });

  // Pet photo, poll votes and results, the admin's sections list (server/sections.js).
  sections.register(app, { requireAdmin, sendHtml, signupHtml: () => signupFormHtml({ source: 'sections' }) });

  const newsletterApi = registerNewsletter(app, {
    store, requireAdmin, adminOrHq, siteUrl, nowFn: () => (opts.now || (() => new Date()))(),
    // The newsletter is a day-by-day list: only events that made their day.
    getPublicPayload: shownPayload, createRateLimiter, config: newsletter, resend: nlResend, slack, verifyHuman, tremendous,
    // No secret, no check: signups then confirm by email (newsletter.js).
    turnstileConfigured: Boolean(turnstileSecret),
    // The send itself must carry the paid placements (see sponsors.apply).
    getSendPayload: () => shownPayload({ strict: true }),
    getSections: (edition, now) => sections.forIssue(edition, now),
    // Monday's run also sends last week's sponsor reports (and any Vic's
    // Pick reports due). The submission review cron runs them too, every
    // 15 minutes; both are idempotent (each order records report_sent).
    onCron: now => Promise.all([sponsors.sendSponsorReports(now), sponsors.sendPickReports(now)])
      .then(([sponsorReports, pickReports]) => ({ ...sponsorReports, picks: pickReports })),
    withNav: async (html, path) => {
      const payload = await getPublicPayload();
      return fillSeasonalNav(html, activeSeasons(payload.events, await listArchived(), nowFn()), path);
    }
  });

  // ─── Server-rendered pages (SEO + AI crawlers) ───
  // See server/seo.js for why. Registered before express.static so "/"
  // gets the rendered homepage instead of the raw docs/index.html.
  const nowFn = opts.now || (() => new Date());
  let indexTemplate = null;

  // The site's own CSS and JS are cached for 10 minutes; a page from a new
  // deploy with the previous deploy's stylesheet looks broken. Pages link
  // them with ?v=<hash of their contents>, so each deploy loads fresh files.
  let assetVersion = null;
  function versionAssets(html) {
    if (assetVersion === null) {
      try {
        const h = crypto.createHash('sha1');
        for (const f of ['base.css', 'style.css', 'app.js']) h.update(readFileSync(path.join(DOCS_DIR, f)));
        // Another town's /style.css carries its palette (server/palette.js).
        h.update(townStyleCss(town));
        assetVersion = h.digest('hex').slice(0, 10);
      } catch (_) { assetVersion = ''; }
    }
    if (!assetVersion) return html;
    return html.replace(/(href|src)="(\/|\.\/)(base\.css|style\.css|app\.js)"/g, `$1="$2$3?v=${assetVersion}"`);
  }

  // The newsletter's reach under every page's signup (server/seo.js
  // reachHtml): active subscribers and the past week's readers (the Traffic
  // tab's 7-day visitors). Counted at most every 10 minutes, in the
  // background, so no page waits on the database for it; a failed count
  // keeps the last one.
  const REACH_MS = 10 * 60 * 1000;
  let reach = null, reachAt = 0, reachBusy = null;
  function refreshReach() {
    if (reachBusy) return reachBusy;
    reachBusy = (async () => {
      const now = nowFn();
      try {
        const [subscribers, rows] = await Promise.all([
          typeof store.countSubscribers === 'function' ? store.countSubscribers().then(c => (c && c.active) || 0) : 0,
          typeof store.listTraffic === 'function' ? store.listTraffic(addDays(localDateStr(now), -8)) : []
        ]);
        reach = { subscribers, readers: summarize(rows, { now, days: 7 }).totals.week.visitors };
        setReach(reach);
      } catch (err) {
        console.warn('[reach] count failed:', err.message);
      } finally {
        reachAt = now.getTime();
        reachBusy = null;
      }
    })();
    return reachBusy;
  }
  function reachNow() {
    if (nowFn().getTime() - reachAt > REACH_MS) refreshReach();
    return reach;
  }

  function sendHtml(res, html, status = 200, cacheControl = null) {
    reachNow();   // refreshes the footer's count when it's due
    html = fillReach(versionAssets(fillSeasonalNav(html, res.locals.seasons || [], res.req.path)));
    // Short public cache: a new publish shows up within minutes, and a
    // burst of crawler traffic doesn't hit Postgres on every request.
    // A page built from a fallback list (database down) isn't cached:
    // browsers and crawlers would keep it after the database is back.
    const fallback = res.locals.payloadSource && res.locals.payloadSource !== 'store';
    res.status(status).set('Cache-Control', cacheControl || (status === 200 && !fallback ? 'public, max-age=300' : 'no-store'));
    res.type('html').send(html);
  }

  // venues.json ships with the deploy; read once at boot (declared above,
  // with getPublicPayload, which scores events by venue).
  try {
    venues = buildVenues(await readJsonFile(opts.venuesFile || VENUES_FILE));
  } catch (err) {
    console.warn('[venues] venues.json unreadable:', err.message);
  }

  // The archive only changes on publish, so keep it in memory for a few
  // minutes instead of reading every archived event on every page view.
  async function listArchived() {
    if (typeof store.listArchivedEvents !== 'function') return [];
    if (archiveCache && Date.now() - archiveCache.at < ARCHIVE_TTL_MS) return archiveCache.events;
    try {
      // Moved and removed pages (settleArchive) aren't listed anywhere.
      const events = (await store.listArchivedEvents()).filter(ev => ev && !ev._moved_to && !ev._removed);
      archiveCache = { at: Date.now(), events };
      return events;
    } catch (err) {
      console.warn('[events] archive list failed:', err.message);
      return archiveCache ? archiveCache.events : [];
    }
  }

  const pageHandler = render => async (req, res, next) => {
    try {
      const payload = await getPublicPayload();
      res.locals.payloadSource = payload.source;
      // Hidden events keep their archive row; keep their pages off too.
      const archived = withoutHidden(await listArchived(), payload);
      const now = nowFn();
      res.locals.seasons = activeSeasons(payload.events, archived, now);
      // partners: live category partners and open categories (null in a
      // paused town: nothing about partners shows).
      await render(req, res, payload, { siteUrl, now, sponsor: payload.sponsor || null, partners: partnerState(payload), archived, venues });
    } catch (err) {
      next(err);
    }
  };

  app.get(['/', '/index.html'], pageHandler(async (req, res, payload, ctx) => {
    // Admin preview loads the homepage with ?preview / ?previewKey and
    // renders its own unpublished picks client-side; serve it untouched.
    if (req.query.preview || req.query.previewKey) {
      if (town.id === VICTORIA.id) return res.sendFile(path.join(DOCS_DIR, 'index.html'));
      return res.type('html').send(localizeHtml(await fsp.readFile(path.join(DOCS_DIR, 'index.html'), 'utf8')));
    }
    if (!indexTemplate || opts.reloadTemplates) {
      // Victoria's template as is; another town's with its own name, domain,
      // GA ID, place and prices (server/localize.js).
      indexTemplate = localizeHtml(await fsp.readFile(path.join(DOCS_DIR, 'index.html'), 'utf8'));
    }
    sendHtml(res, renderHome(indexTemplate, shown(payload.events), {
      ...ctx, signupHtml: signupFormHtml(), sectionsHtml: sections.enabled ? await sections.forHome().catch(() => '') : ''
    }));
  }));

  for (const page of HUB_PAGES) {
    app.get(page.path, pageHandler(async (req, res, payload, ctx) => {
      // Day pages (today, this weekend, next week) are day lists; the
      // category pages (free, kids, music...) are guides and keep everything.
      sendHtml(res, renderHubPage(page, page.range === 'upcoming' ? payload.events : shown(payload.events),
        { ...ctx, partnerBox: partnerBoxHtml(page.path, ctx.partners, siteUrl) }));
    }));
  }

  // Our local partners (server/partners.js): no prices here; a paused town
  // has no such page.
  app.get('/partners', pageHandler(async (req, res, payload, ctx, next) => {
    if (!ctx.partners) return sendHtml(res, renderNotFoundPage({ siteUrl, kind: 'page' }), 404);
    sendHtml(res, renderPartnersPage({ siteUrl, state: ctx.partners }));
  }));

  // { ev } for a page to show; { moved: page } for a renamed or re-dated
  // event (301 there); { gone: true } (410) for an event deliberately taken
  // off the site (settleArchive marked it _removed), whatever its date, and
  // for an upcoming event that's only in the archive, so an old copy can't
  // pass for a live listing. Other past events keep their archive pages.
  // { unavailable: true } when the archive couldn't be read: a database
  // outage answered a bare 500 (and a "Site error" alert on top of the
  // db-read one) for every past event link while live pages kept working.
  async function findEvent(payload, page, now) {
    try {
      return await findEventIn(payload, page, now);
    } catch (err) {
      console.warn('[events] archive read failed:', err.message);
      return { unavailable: true };
    }
  }
  function sendUnavailable(res, ctx, html = true) {
    res.set('Retry-After', '120');
    if (!html) return res.status(503).set('Cache-Control', 'no-store').type('text/plain').send('Temporarily unavailable');
    return sendHtml(res, renderNotFoundPage({ ...ctx, kind: 'unavailable' }), 503);
  }
  async function findEventIn(payload, page, now) {
    const isLive = p => payload.events.some(e => e.page === p);
    const live = payload.events.find(e => e.page === page);
    if (live) return { ev: live };
    if (typeof store.getArchivedEvent !== 'function') return {};
    let at = page;
    let ev = await store.getArchivedEvent(at);
    // A hidden event's archived copy stays hidden.
    if (!ev || !withoutHidden([{ ...ev, page }], payload).length) return {};
    // Follow a rename (renamed twice is two hops).
    for (let hops = 0; ev && ev._moved_to && hops < 5; hops++) {
      at = ev._moved_to;
      if (isLive(at)) return { moved: at };
      ev = await store.getArchivedEvent(at);
    }
    if (!ev || !withoutHidden([{ ...ev, page: at }], payload).length) return {};
    if (ev._removed || ev._moved_to) return { gone: true };
    if (ev.date >= localDateStr(now)) {
      // Not settled yet (archived before settleArchive existed): still
      // send a rename to its live page.
      const next = successorOf(ev, payload.events);
      return next ? { moved: next.page } : { gone: true };
    }
    return at === page ? { ev } : { moved: at };
  }

  // A moved event's target can change again (an admin moves a date and
  // then back, or the collector's name flips between runs), and a browser
  // keeps an uncached 301 forever, so a revert would loop. Stay 301 so
  // search engines move the page's standing, but make browsers ask again.
  // Keeps the query string (?s=sh from a share, utm tags from an ad), so
  // a link to an event that moved still counts where it came from.
  function movedRedirect(res, to) {
    res.set('Cache-Control', 'no-cache');
    const q = (res.req && res.req.originalUrl || '').match(/\?.*$/);
    return res.redirect(301, to + (q && !to.includes('?') ? q[0] : ''));
  }

  // Add-to-calendar file. Registered before /events/:slug, which would
  // otherwise treat "<slug>.ics" as a slug.
  app.get('/events/:slug.ics', pageHandler(async (req, res, payload, ctx) => {
    const { ev, gone, moved, unavailable } = await findEvent(payload, `/events/${req.params.slug}`, ctx.now);
    if (unavailable) return sendUnavailable(res, ctx, false);
    if (moved) return movedRedirect(res, `${moved}.ics`);
    if (!ev) return sendHtml(res, renderNotFoundPage({ ...ctx, kind: 'event' }), gone ? 410 : 404);
    res.set('Content-Disposition', `attachment; filename="${String(req.params.slug).replace(/[^a-z0-9-]/gi, '') || 'event'}.ics"`);
    res.type('text/calendar; charset=utf-8').send(renderIcs(ev, ctx));
  }));

  // Link-preview card (server/ogImage.js). The page links it with ?v=<hash
  // of what's drawn>, so the long cache is safe: an edited event gets a new
  // URL, and Facebook re-fetches it. Also registered before /events/:slug.
  app.get('/events/:slug.png', pageHandler(async (req, res, payload, ctx) => {
    const { ev, gone, moved, unavailable } = await findEvent(payload, `/events/${req.params.slug}`, ctx.now);
    if (unavailable) return sendUnavailable(res, ctx, false);
    if (moved) return movedRedirect(res, `${moved}.png`);
    if (!ev) return res.status(gone ? 410 : 404).type('text/plain').send('Not found');
    let png;
    try {
      png = renderEventCard({ ...ev, page: `/events/${req.params.slug}` });
    } catch (err) {
      // A broken card shouldn't break the share: show the site image instead.
      console.error('[og] event card render failed:', err.message);
      return res.redirect(302, '/og-image.png');
    }
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('image/png').send(png);
  }));

  app.get('/events/:slug', pageHandler(async (req, res, payload, ctx) => {
    const { ev, gone, moved, unavailable } = await findEvent(payload, `/events/${req.params.slug}`, ctx.now);
    if (unavailable) return sendUnavailable(res, ctx);
    if (moved) return movedRedirect(res, moved);
    if (!ev) return sendHtml(res, renderNotFoundPage({ ...ctx, kind: 'event' }), gone ? 410 : 404);
    const venue = venueFor(ev, venues);
    sendHtml(res, renderEventPage(ev, payload.events, {
      ...ctx, extras: eventActionsHtml(ev, siteUrl), venuePath: venue ? venue.path : null,
      image: `${ev.page}.png?v=${eventCardVersion(ev)}`
    }));
  }));

  app.get('/venues', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderVenueIndex(venues, payload.events, ctx.archived, ctx));
  }));

  app.get('/venues/:slug', pageHandler(async (req, res, payload, ctx) => {
    const venue = venues.find(v => v.slug === req.params.slug);
    if (!venue) return sendHtml(res, renderNotFoundPage({ ...ctx, kind: 'venue' }), 404);
    sendHtml(res, renderVenuePage(venue, payload.events, ctx.archived, ctx));
  }));

  for (const season of townSeasons()) {
    app.get(season.path, pageHandler(async (req, res, payload, ctx) => {
      sendHtml(res, renderSeasonPage(season, payload.events, ctx.archived, ctx));
    }));
    // People guess the short form (/halloween for /halloween-events).
    const short = season.path.replace(/-events$/, '');
    if (short !== season.path) {
      app.get(short, (req, res) => res.redirect(301, season.path + (req.originalUrl.match(/\?.*$/) || [''])[0]));
    }
  }

  app.get('/advertise', pageHandler(async (req, res, payload, ctx) => {
    let subscribers = 0;
    try { subscribers = typeof store.countSubscribers === 'function' ? (await store.countSubscribers()).active || 0 : 0; } catch (_) { /* numbers are a bonus */ }
    sendHtml(res, renderAdvertisePage({ ...ctx, checkout: stripeCfg.enabled, previews: samplePreviews(),
      emailPreviews: sampleEmailPreviews(''), stats: advertiseStats(payload.events, ctx.now, subscribers, (reachNow() || {}).readers || 0),
      partnerOpen: ctx.partners ? ctx.partners.open.map(id => (categoryOf(id) || { label: id }).label) : null }));
  }));

  // Contact form → Slack; replaces publishing an email address.
  registerContact(app, { siteUrl, slack, store, requireAdmin, adminOrHq, createRateLimiter, sendHtml, verifyHuman, formGuard,
    nowFn: () => (opts.now ? opts.now().getTime() : Date.now()) });
  // Personal data: delete one address on request, export subscribers (server/privacy.js).
  registerPrivacy(app, { store, requireAdmin, slack, nowFn: () => nowFn() });
  inbound.registerReply(app, { requireAdmin, resend: nlResend, from: newsletter.from, normalizeEmail });
  // Replies approved through HQ, sent as news@ (server/inbound.js). Off
  // unless HQ_REPLY_KEY is set, at least MIN_SSO_SECRET long and unlike
  // every other secret (the read-only HQ_API_KEY must never send).
  const hqReplyKey = String(opts.hqReplyKey ?? process.env.HQ_REPLY_KEY ?? '').trim();
  const replyClash = [['HQ_API_KEY', opts.hqApiKey ?? process.env.HQ_API_KEY], ['HQ_SSO_SECRET', ssoSecret], ['ADMIN_SESSION_SECRET', opts.adminSessionSecret ?? process.env.ADMIN_SESSION_SECRET],
    ['ADMIN_PASSWORD', opts.adminPassword ?? process.env.ADMIN_PASSWORD], ['ADMIN_TOKEN', adminToken]]
    .filter(([, v]) => hqReplyKey && v && String(v).trim() === hqReplyKey).map(([k]) => k);
  const hqReplyOn = hqReplyKey.length >= MIN_SSO_SECRET && !replyClash.length;
  if (hqReplyKey && !hqReplyOn) {
    console.warn(`[inbound] HQ replies are off: HQ_REPLY_KEY ${replyClash.length ? `is the same as ${replyClash.join(', ')}` : `is shorter than ${MIN_SSO_SECRET} characters`}; give it its own value`);
  }
  inbound.registerHqReply(app, { key: hqReplyOn ? hqReplyKey : '', resend: nlResend, from: newsletter.from, clientKey,
    limiter: opts.hqReplyLimiter || createRateLimiter({ windowMs: 60 * 1000, max: 10 }) });

  // Submissions through HQ, with the same key: the owner's assistant reads
  // them in full, edits them and decides them like the admin Submissions
  // tab (decideSubmission: approving publishes and emails the submitter).
  // Nothing else in the admin opens with this key. Off with HQ_REPLY_KEY.
  if (hqReplyOn) {
    const hqSubLimiter = opts.hqSubmissionsLimiter || createRateLimiter({ windowMs: 60 * 1000, max: 30 });
    const hqGate = (req, res, next) => {
      if (!hqSubLimiter.check(`hq-sub:${clientKey(req)}`).ok) return res.status(429).json({ ok: false, error: 'rate-limited' });
      if (!keyOk(req.get('authorization'), hqReplyKey)) return res.status(401).json({ ok: false, error: 'unauthorized' });
      res.set('Cache-Control', 'no-store');
      next();
    };
    // The row as the admin sees it, minus what only spam checks need.
    const forHq = r => {
      const { submitter_ip, user_agent, ...rest } = r;
      return rest;
    };
    app.get('/api/hq/submissions', hqGate, wrap(async (req, res) => {
      const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : 'pending';
      const rows = status === 'all' ? await store.list({}) : await store.list({ status });
      res.json({ ok: true, status, submissions: rows.slice(0, 100).map(forHq) });
    }));
    app.get('/api/hq/submissions/:id', hqGate, wrap(async (req, res) => {
      const row = await store.get(req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: 'not-found' });
      res.json({ ok: true, submission: forHq(row) });
    }));
    // A new event from the owner, e.g. one he found and handed his assistant:
    // { event: { name, date, time, end_time?, venue, address, description,
    // url?, icons?, free? }, submitter?, publish?, note? }. Saved as a submission
    // (source 'hq') so it has the same history and edits as any other, then
    // approved, which publishes it, unless publish is false. Already listed
    // (on the site or in the queue) answers 409 with what matched.
    app.post('/api/hq/submissions', hqGate, wrap(async (req, res) => {
      const body = req.body || {};
      const v = validateSubmission(body.event, { adminEdit: true });
      if (!v.ok) return res.status(400).json({ ok: false, errors: v.errors });
      const ev = normalizePayload(v.data.payload);
      if (ev.date < localDateStr(nowFn())) return res.status(400).json({ ok: false, errors: { date: 'That date has passed.' } });
      // Duplicates by the same loose match the Picks use (same day, same
      // place, a clearly matching name), not just an exact name: the
      // assistant finds events on other sites, worded their way.
      const dup = await store.findDuplicate({ date: ev.date, name: ev.name, venue: ev.venue }) ||
        (await store.list({ fromDate: ev.date })).find(r => r.status !== 'rejected' && sameEvent(r.payload || {}, ev));
      if (dup) return res.status(409).json({ ok: false, error: 'duplicate', submission: forHq(dup) });
      const listed = (((await getPublicPayload()) || {}).events || []).find(e => sameEvent(e, ev));
      if (listed) return res.status(409).json({ ok: false, error: 'already-listed', event: { name: listed.name, date: listed.date, time: listed.time || '', venue: listed.venue || '' } });
      const note = typeof body.note === 'string' ? body.note.slice(0, 500) : '';
      // submitter: { name?, email? }, the person who sent the event in some
      // other way (an email, say). Credited like a form submitter, so
      // approving it emails them that it's live. Optional; checked like the form.
      const sub = body.submitter && typeof body.submitter === 'object' ? body.submitter : {};
      const subEmail = String(sub.email || '').trim().toLowerCase().slice(0, 254);
      if (subEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subEmail)) return res.status(400).json({ ok: false, errors: { submitter: 'That email doesn\'t look right.' } });
      const subName = String(sub.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
      const now = nowIso();
      const row = {
        id: newId(), created_at: now, updated_at: now, status: 'pending', source: 'hq',
        submitter_kind: 'other', submitter_name: subName, submitter_email: subEmail, submitter_ip: null, user_agent: '',
        payload: ev, admin_notes: '',
        review_history: [{ at: now, action: 'submitted', note: note || 'Added by the owner through HQ', via: 'hq' }]
      };
      await store.insert(row);
      if (body.publish === false) {
        slack.notify({ channel: 'activity', title: `📋 ${ev.name} added through HQ`, text: 'Waiting in Submissions, not on the site yet.', link: `${siteUrl}/admin.html` });
        return res.status(201).json({ ok: true, submission: forHq(row), live: false });
      }
      const out = await decideSubmission(row.id, { status: 'approved', note: 'Approved by the owner through HQ' }, { via: 'hq' });
      if (out.json.submission) out.json.submission = forHq(out.json.submission);
      slack.notify({ channel: 'activity', title: `📋 ${ev.name} added through HQ`,
        text: out.json.live ? 'It is live on the site.' : 'It is approved but not on the site yet.', link: `${siteUrl}/admin.html` });
      res.status(out.code === 200 ? 201 : out.code).json(out.json);
    }));
    // Body: { status?, payload?, note? }, as in the admin route.
    app.post('/api/hq/submissions/:id', hqGate, wrap(async (req, res) => {
      const body = req.body || {};
      const out = await decideSubmission(req.params.id, { status: body.status, payload: body.payload, note: body.note }, { via: 'hq' });
      if (out.code === 200 && out.json.submission) {
        out.json.submission = forHq(out.json.submission);
        const name = (out.json.submission.payload || {}).name || 'a submission';
        slack.notify({ channel: 'activity', title: body.status ? `📋 ${name} marked ${body.status} through HQ` : `📋 ${name} edited through HQ`,
          ...(out.json.live === undefined ? {} : { text: out.json.live ? 'It is live on the site.' : 'It is not on the site yet.' }),
          link: `${siteUrl}/admin.html` });
      }
      res.status(out.code).json(out.json);
    }));
  }

  sponsors.registerRoutes(app, { requireAdmin, adminOrHq, createRateLimiter, sendHtml, verifyHuman, formGuard, analyticsSecret });

  app.get('/about', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderAboutPage(ctx));
  }));

  app.get('/privacy', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderPrivacyPage(ctx));
  }));

  // Terms of use, the advertising terms checkout links to (with the refund
  // and cancellation policy at #refunds) and the accessibility statement
  // (server/legal.js).
  app.get('/terms', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderTermsPage(ctx));
  }));
  app.get('/advertising-terms', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderAdvertisingTermsPage(ctx));
  }));
  app.get('/refunds', (req, res) => res.redirect(301, '/advertising-terms#refunds'));
  app.get('/accessibility', pageHandler(async (req, res, payload, ctx) => {
    sendHtml(res, renderAccessibilityPage(ctx));
  }));

  app.get('/sitemap.xml', pageHandler(async (req, res, payload, ctx) => {
    res.set('Cache-Control', 'public, max-age=300');
    const extraPaths = [
      '/venues', '/subscribe', '/privacy', '/terms', '/advertising-terms', '/accessibility', '/referral-rules',
      ...(ctx.partners ? ['/partners'] : []),
      ...(sections.enabled ? SECTION_PAGES.map(p => p.path) : []),
      ...activeSeasons(payload.events, ctx.archived, ctx.now).map(s => s.path),
      ...venuesWithEvents(venues, payload.events, ctx.archived, ctx.now).map(v => v.path)
    ];
    res.type('application/xml').send(renderSitemap(payload.events, { ...ctx, lastmod: payload.last_updated, extraPaths }));
  }));

  app.get('/llms.txt', pageHandler(async (req, res, payload, ctx) => {
    res.set('Cache-Control', 'public, max-age=300');
    const extraLinks = [
      [`Event venues in ${town.cityState}`, '/venues', 'every venue we track, with its upcoming events'],
      ...activeSeasons(payload.events, ctx.archived, ctx.now).map(s => [s.title, s.path, s.description])
    ];
    res.type('text/plain; charset=utf-8').send(renderLlmsTxt(shown(payload.events), { ...ctx, extraLinks, sponsor: payload.sponsor || null }));
  }));

  // The social kit lives at docs/social/latest/index.html; static serving
  // has directory indexes off, so send the bare folder there.
  app.get(['/social', '/social/', '/social/latest', '/social/latest/'], (req, res) => {
    res.redirect(302, '/social/latest/index.html');
  });

  // ─── Auto-publish (server/autopublish.js) ───
  // Each collector run commits candidates.json and redeploys; on boot the
  // new candidates go live without anyone opening the admin. Production
  // only, so PR environments and tests never publish on their own.
  const autoPublish = createAutoPublish({
    store, candidatesFile, readJsonFile: f => (f === candidatesFile ? readCandidates() : readJsonFile(f)), siteUrl, slack, archiveEvents,
    nowFn: () => (opts.now || (() => new Date()))()
  });
  app.post('/api/admin/auto-publish', requireAdmin, async (req, res, next) => {
    try { res.json(await autoPublish.run({ force: true })); } catch (err) { next(err); }
  });
  // ─── Approved submissions go live (AI review and manual approval) ───
  // True when the event is on the public site; then "You're live" goes out
  // with a link to its page. A paid Vic's Pick also counts when it matched
  // an event already listed (the pin finds that one).
  async function notifyLive(row) {
    const key = eventKeyOf(row.payload);
    const events = (await getPublicPayload()).events || [];
    const paid = isPaidPick(row);
    const live = events.find(e => eventKeyOf(e) === key) || (paid ? events.find(e => sameEvent(row.payload, e)) : null);
    if (!live) return false;
    if (row.submitter_email) {
      // Only called pinned while its order still pins it (a refunded or
      // hidden order no longer features the event); the newsletter line is
      // worded from when it was bought (the paid row is created at payment).
      const pinned = paid && Boolean(live.featured) && !live.editor_pick;
      const mail = renderSubmissionLive(paid ? { ...row.payload, name: live.name, featured: pinned } : row.payload, {
        siteUrl, address: newsletter.address, pick: pinned, at: row.created_at,
        pageUrl: live.page ? `${siteUrl}${live.page}` : ''
      });
      // mailer.deliver never throws. A throw here is what the review's retry
      // path already treats as "try again" (ai_review.live_pending, then
      // retryLive every review run with the same idempotency key until the
      // date passes), so a buyer promised this email isn't left without it
      // after a short Resend outage. With email off there's nothing to retry.
      const result = await mailer.deliver(row.submitter_email, mail, `${town.keyPrefix}-submission-live-${row.id}`);
      if (result === 'failed') {
        const err = new Error('live email failed');
        err.code = 'live-email-failed';
        throw err;
      }
      if (result === 'refused') await liveEmailRefused(row, live);
    }
    return true;
  }

  // Resend refuses the address for good ("bob@gmail.com."): retrying only
  // republished the site every 15 minutes until the event's date and never
  // told anyone. The event is live, so answer true (that clears
  // live_pending), note it on the submission, and tell Slack once.
  async function liveEmailRefused(row, live) {
    const history = Array.isArray(row.review_history) ? row.review_history : [];
    if (history.some(h => h && h.action === 'live-email-refused')) return;
    const at = nowFn().toISOString();
    try {
      await store.update(row.id, { review_history: [...history,
        { at, action: 'live-email-refused', note: 'Resend refused the "you’re live" email to the submitter’s address; not retried' }] });
    } catch (err) { console.warn('[submissions] live email refusal note failed:', err.message); }
    slack.notify({
      channel: 'alerts',
      title: `⚠️ “You’re live” email refused: ${row.payload && row.payload.name}`,
      text: `The submitter wasn't told it's live. Reach them another way if it matters.`,
      more: `${(row.payload && row.payload.name) || 'A submission'} is on the site${live.page ? ` (${siteUrl}${live.page})` : ''}, ` +
        `but Resend refused the address ${row.submitter_email}.`,
      link: `${siteUrl}/admin.html`
    });
  }

  // Publish approved submissions now (never the collector's candidates) and
  // say which of `rows` made it onto the site.
  async function publishApproved(rows) {
    let published;
    try {
      published = await autoPublish.run({ force: true, quiet: true, submissionsOnly: true });
    } catch (err) {
      console.error('[submissions] publish failed:', err.message);
      return { published: false, live: rows.map(() => false) };
    }
    const live = [];
    for (const row of rows) {
      try { live.push(published && published.ok ? await notifyLive(row) : false); } catch (err) {
        console.warn('[submissions] live check/email failed:', err.message);
        live.push(null);
        // Same as the AI review: the next review run (retryLive) checks
        // again and sends the "you're live" email.
        try {
          await store.update(row.id, { ai_review: { ...(row.ai_review || {}), live_pending: nowFn().toISOString() } });
        } catch (e) { console.warn('[submissions] live retry mark failed:', e.message); }
      }
    }
    return { published: Boolean(published && published.ok), live };
  }

  // ─── AI review of submissions (server/submissionReview.js) ───
  const submissionReview = registerSubmissionReview(app, {
    store, slack, siteUrl,
    nowFn: () => (opts.now || (() => new Date()))(),
    secret: submissionReviewSecret,
    // Free submissions wait for the owner unless SUBMISSION_AUTOAPPROVE=1.
    autoApprove: opts.submissionAutoApprove ?? process.env.SUBMISSION_AUTOAPPROVE === '1',
    publish: () => autoPublish.run({ force: true, quiet: true, submissionsOnly: true }),
    onApproved: notifyLive,
    // The review runs every 15 minutes, server-side and authenticated: the
    // only frequent scheduler there is, so it also sends Vic's Pick reports
    // (the day after the event) and catches up weekly sponsor reports the
    // Monday cron missed. Not awaited: the review shouldn't wait on email.
    onRun: () => {
      const now = (opts.now || (() => new Date()))();
      return Promise.all([sponsors.sendPickReports(now), sponsors.sendSponsorReports(now)])
        .catch(err => console.warn('[sponsors] reports failed:', err.message));
    }
  });

  // A paused town (TOWN_DORMANT=1) leaves its published list as it is: no
  // collect is coming, and a missing candidates file isn't news.
  const autoOnBoot = !town.dormant && (opts.autoPublish ??
    (process.env.AUTO_PUBLISH !== '0' && process.env.RAILWAY_ENVIRONMENT_NAME === 'production'));
  // One collector publish at a time: the hourly retry below must not race
  // a boot run that is still waiting on a slow database.
  let autoRun = null;
  let autoFailed = false;
  function runAutoPublish() {
    if (!autoRun) autoRun = autoPublish.run().finally(() => { autoRun = null; });
    return autoRun;
  }
  // A run that reads the candidates now: one already under way may have read
  // the old ones (the jobs worker's upload of new candidates).
  function publishFresh() {
    return (autoRun || Promise.resolve()).catch(() => {}).then(() => runAutoPublish());
  }
  // Jobs and workflows off: nothing collects for this town (Kearney and
  // Tupelo while paused). Victoria always has one or the other.
  const townPaused = () => !jobs.enabled && !townWorkflowsReady();
  if (autoOnBoot) {
    const t = setTimeout(() => {
      runAutoPublish().then(async r => {
        // A town that has never collected has no candidates.json: expected
        // until its first collect, not an alert (it fired on every deploy of
        // main). Victoria has always collected.
        if (r && !r.ok && r.error === 'no-candidates' && town.id !== VICTORIA.id && !(await hasCollected())) {
          console.log('[auto-publish] no candidates yet; this town has not collected');
          return;
        }
        // A paused town can't collect again, so a missing candidates.json is
        // expected, not news on every deploy.
        if (r && !r.ok && r.error === 'no-candidates' && townPaused()) {
          console.log('[auto-publish] no candidates; this town is paused (jobs and workflows off)');
          return;
        }
        // e.g. candidates.json unreadable: run() reports it rather than throwing.
        if (r && !r.ok) {
          autoFailed = true;
          slack.alert('auto-publish', 'Auto-publish could not run', r.message || r.error, `${siteUrl}/admin.html`);
        }
      }).catch(err => {
        autoFailed = true;
        console.error('[auto-publish] failed:', err.message);
        slack.alert('auto-publish', 'Auto-publish failed', err.message, `${siteUrl}/admin.html`);
      });
    }, opts.autoPublishDelayMs ?? 3000);
    if (t.unref) t.unref();
  }
  // The boot publish runs once, seconds after a deploy. A database blip at
  // that moment would leave the new collect unpublished until the next
  // deploy (and Monday's newsletter would go out from the old list), so the
  // hourly site check tries again. Not forced: once this collect is live it
  // answers "already-published" without writing, so it only does work when
  // a boot publish was missed. Failures here only log; the boot alert has
  // already said so, and the site check flags a stalled list.
  async function retryAutoPublish() {
    if (!autoOnBoot || townPaused()) return null;
    try {
      const r = await runAutoPublish();
      if (r && r.ok && !r.skipped && autoFailed) {
        autoFailed = false;
        slack.notify({ title: '✅ Auto-publish caught up', text: `Published ${r.published} events (${r.added} new) on the hourly retry.`, channel: 'alerts' });
      }
      if (r && !r.ok) console.warn('[auto-publish] hourly retry:', r.message || r.error);
      return r;
    } catch (err) {
      console.warn('[auto-publish] hourly retry failed:', err.message);
      return null;
    }
  }

  // ─── Scheduler (server/scheduler.js) ───
  // The server is the clock for the Monday newsletter and the daily
  // GitHub workflows, because GitHub's own cron runs hours late.
  const dropNotices = createDropNotices({ store, getPublicPayload, mailer, slack, siteUrl, address: newsletter.address,
    orders: () => sponsors.orders(), checkoutEnabled: stripeCfg.enabled });
  const eventRecaps = createEventRecaps({ store, siteUrl, mailer, slack, address: newsletter.address,
    getEvents: async () => [...(((await getPublicPayload()) || {}).events || []), ...(await listArchived().catch(() => []))],
    orders: () => sponsors.orders(), checkoutEnabled: stripeCfg.enabled });
  const scheduler = opts.scheduler || createScheduler({
    store, slack, siteUrl, nowFn: () => nowFn(),
    // Jobs on Railway: the town's worker jobs go to its jobs worker (every
    // town's, Victoria's included); without them they don't run.
    queueJob: jobs.enabled ? (job, slot) => jobs.enqueue(job.kind, slot) : null,
    canQueue: job => canRunOnWorker(job),
    handlers: {
      newsletter: () => newsletterApi.scheduledSend(),
      newsletterReady: () => newsletter.enabled && newsletter.autosend,
      newsletterWeekend: () => newsletterApi.scheduledSend('weekend'),
      newsletterWeekendReady: () => newsletter.enabled && newsletter.autosend && newsletter.weekend,
      // Weekly sponsor reports (server/sponsors.js), once that exists.
      sponsorReports: typeof sponsors.sendSponsorReports === 'function'
        ? now => sponsors.sendSponsorReports(now)
        : typeof sponsorsModule.sendSponsorReports === 'function'
          ? now => sponsorsModule.sendSponsorReports(now)
          : undefined,
      // Daily: personal-data retention (server/privacy.js).
      privacyPurge: now => purgePersonalData(store, now),
      // Daily: approved submissions that didn't make their day's list hear
      // so, two days out (server/dropNotices.js).
      dropNotices: now => dropNotices.run(now),
      // Daily: free submitters hear how their event did, the morning after
      // (server/eventRecaps.js).
      eventRecaps: now => eventRecaps.run(now),
      collected: () => hasCollected(),
      health: async now => {
        await retryAutoPublish();
        // Hourly: the one "tap to confirm" reminder to yesterday's
        // unconfirmed signups (server/newsletter.js). Not from a paused town.
        if (!town.dormant) {
          try { await newsletterApi.sendConfirmReminders(now); } catch (err) { console.warn('[newsletter] confirm reminders failed:', err.message); }
        }
        return healthCheck(now);
      }
    }
  });
  if (opts.startScheduler ?? schedulerEnabled()) scheduler.start();

  // Whether the town has ever collected: auto-publish records when the
  // candidates it published were collected. Victoria always has.
  function collectedPayload(pub) {
    return town.id === VICTORIA.id || Boolean(pub && pub.auto_publish && pub.auto_publish.from);
  }
  // Or candidates exist (a town that publishes by hand, AUTO_PUBLISH=0, or
  // whose published list was wiped).
  async function hasCollected(pub) {
    if (town.id === VICTORIA.id) return true;
    try {
      if (collectedPayload(pub === undefined ? await store.getPublished() : pub)) return true;
      return Boolean(((await readCandidates().catch(() => null)) || {}).last_updated);
    } catch { return true; }
  }

  // Hourly in-process check (the uptime workflow only runs every few
  // hours): database reachable, events coming up, collector not stalled.
  // Alerts when a problem appears, again daily while it lasts, and says
  // when it clears.
  const healthState = new Map(); // problem key → last alerted (ms)
  const bootedAt = nowFn().getTime();
  const JOBS_WORKER_SILENT_MS = 30 * 60 * 1000;
  async function healthCheck(now) {
    const problems = {};
    if (missingDatabase) problems.nodb = NO_DATABASE;
    // A dead webhook silences every later alert, so it is a problem of its
    // own (shown in the admin checklist too; see slackRefusedText).
    const slackDead = slackRefusedText();
    if (slackDead) problems.slack = slackDead;
    // Jobs on Railway: a run the worker never finished alerts (once, in
    // jobs.expire), and so does a worker that has stopped asking for work.
    // A paused town (TOWN_DORMANT=1) runs no jobs and sends no issues, so
    // only the database, Slack and subscriber checks apply to it.
    const dormant = town.dormant;
    if (jobs.enabled && !dormant) {
      try { await jobs.expire(now); } catch (err) { console.warn('[jobs] expire failed:', err.message); }
      const polled = jobs.state.lastPollAt ? Date.parse(jobs.state.lastPollAt) : bootedAt;
      // A worker running a job doesn't ask for work; it's alive until that
      // job's time limit (past it, jobs.expire above says so).
      const busy = await jobs.busy(now).catch(() => false);
      if (!busy && now.getTime() - polled > JOBS_WORKER_SILENT_MS) {
        problems.jobs_worker = `The jobs worker hasn't asked for work since ${jobs.state.lastPollAt || 'this deploy started'}, so collects and checks aren't running. Check the town's jobs service in Railway.`;
      }
    }
    let pub = null;
    try {
      pub = (await store.getPublished()) || {};
    } catch (err) {
      problems.db = `The database is unreachable (${err.message}); the site is serving the old bundled event list.`;
    }
    // A town that hasn't collected yet, or can't (its workflows are off), has
    // no events by design, so "only 0 upcoming", "stale" and "missed collect"
    // would alert every day until launch. The other checks (database, Slack,
    // subscribers) still run.
    if (pub && !dormant && (jobs.enabled || townWorkflowsReady()) && await hasCollected(pub)) {
      const today = localDateStr(now);
      const upcoming = visibleKeyed(pub, []).filter(e => e && e.date >= today).length;
      if (upcoming < MIN_UPCOMING) {
        problems.upcoming = `Only ${upcoming} upcoming events are on the site. Check the ${jobs.enabled ? 'last collect in the jobs service\'s Railway logs' : 'Weekly Collect run'} and the Sources tab.`;
      }
      const from = Date.parse((pub.auto_publish && pub.auto_publish.from) || '');
      const age = Number.isFinite(from) ? Math.floor((now.getTime() - from) / 86400000) : null;
      // Collect runs Sunday and Wednesday, so 4 days is the normal maximum.
      if (age != null && age >= STALE_COLLECT_DAYS) {
        problems.stale = `No new events collected in ${age} days. The collector or auto-publish may be broken: check ${jobs.enabled ? 'the town\'s jobs service in Railway (Pull Now runs a collect)' : 'the Weekly Collect workflow'}.`;
      }
      // A collect that should have landed hours ago (GitHub skipped or
      // queued it, the run failed, or the deploy didn't publish it).
      const missed = missedCollect(pub.auto_publish && pub.auto_publish.from, now, { hours: COLLECT_LATE_HOURS });
      if (missed) {
        const day = missed.job === 'weekly-collect' ? 'Sunday' : 'Wednesday';
        problems.collect = `${day}'s event collect (${startLabel(missed.job)}) hasn't come in after ${COLLECT_LATE_HOURS} hours, so the site still shows the last collect's events. ` +
          (jobs.enabled
            ? 'Start it by hand with Pull Now in admin (Sources); if it fails again, its jobs service\'s Railway logs say why.'
            : `Start it by hand: GitHub → Actions → Weekly Collect → Run workflow (town ${town.id}), or Pull Now in admin. If a run is there and red, open it to see why.`);
      }
    }
    // A list that sent to people last time and now has nobody active: the
    // database was replaced or wiped (Monday's issue would quietly go to 0
    // recipients). Mass unsubscribes don't get to 0 in a week.
    if (pub && typeof store.countSubscribers === 'function' && typeof store.listNewsletterSends === 'function') {
      try {
        const [counts, sends] = await Promise.all([store.countSubscribers(), store.listNewsletterSends(1)]);
        const last = sends && sends[0];
        if (!(Number(counts && counts.active) > 0) && last && Number(last.recipients) > 0) {
          problems.subscribers = `The newsletter has 0 active subscribers, but the last issue (${last.week_key}) went to ${last.recipients}. ` +
            'The database may have been replaced or wiped: restore the latest Railway backup (AGENTS.md, Backups).';
        }
      } catch (err) {
        console.warn('[health] subscriber check failed:', err.message);
      }
    }
    // An issue that hasn't gone out by its noon cutoff: the scheduler never
    // ran (the server was down), its retries ran out, or Resend isn't set
    // up. Only with readers waiting and automatic sending on.
    if (pub && !dormant && newsletter.autosend && typeof store.getNewsletterSend === 'function' && typeof store.countSubscribers === 'function') {
      try {
        const active = Number((await store.countSubscribers() || {}).active) || 0;
        const today = localDateStr(now);
        for (const [edition, job, day] of [['weekly', 'newsletter', 'Monday'], ['weekend', 'newsletter-weekend', 'Thursday']]) {
          if (!active || (edition === 'weekend' && !newsletter.weekend)) continue;
          const key = EDITIONS[edition].key(today);
          const j = JOBS.find(x => x.name === job);
          const cutoff = slotStart({ name: job, at: j.until }, key);
          // Said for three days after the cutoff; by then the next issue is the one that matters.
          if (key > today || now < cutoff || now - cutoff > 3 * 86400000) continue;
          if (await store.getNewsletterSend(key)) continue;
          problems[`issue-${edition}`] = `${day}'s newsletter (${key}) hasn't gone out, and its ${startLabel(job)} send is past its noon cutoff. ` +
            (newsletter.enabled ? 'Check #alerts for the send error, then send it from admin → Newsletter.'
              : 'RESEND_API_KEY isn\'t set in Railway, so nothing can send; set it, then send from admin → Newsletter.');
        }
      } catch (err) {
        console.warn('[health] newsletter check failed:', err.message);
      }
    }
    const t = now.getTime();
    for (const [key, text] of Object.entries(problems)) {
      const last = healthState.get(key);
      if (last == null || t - last >= 86400000) {
        healthState.set(key, t);
        // Once a day per problem across restarts too: every deploy used to
        // forget it and say it again (a town redeploys several times a day).
        let first = true;
        try {
          const day = localDateStr(now);
          first = (await store.claimJobRun(`alert:health-${key}`, day, now)).claimed;
          if (first) await store.finishJobRun(`alert:health-${key}`, day, { status: 'done' });
        } catch { /* alert anyway */ }
        if (first) slack.alert(`health-${key}-${t}`, 'Site check', text, `${siteUrl}/admin.html`);
      }
    }
    for (const key of [...healthState.keys()]) {
      if (!problems[key]) {
        healthState.delete(key);
        // Cleared: if it comes back today, it's said again.
        try { await store.finishJobRun(`alert:health-${key}`, localDateStr(now), { status: 'retry' }); } catch { /* best effort */ }
        slack.notify({ title: '✅ Site check: back to normal', text: `Cleared: ${key}`, channel: 'alerts' });
      }
    }
    return { ok: true, problems: Object.keys(problems) };
  }

  // Slack refused a post (archived channel, removed app): say which channel
  // and when, or '' when every channel is fine. Fakes in tests may not
  // track refusals.
  function slackRefusedText() {
    const list = typeof slack.refused === 'function' ? slack.refused() : [];
    if (!list.length) return '';
    return 'Slack refused alerts on ' + list.map(r => `${r.channel} (HTTP ${r.status}${r.error ? ` ${r.error}` : ''} at ${r.at})`).join(', ') +
      '. The channel may be archived or the Slack app removed: make a new incoming webhook and update the SLACK_*_WEBHOOK_URL variable in Railway (and its jobs service\'s reference).';
  }

  // ─── Admin home: setup checklist + at-a-glance numbers ───
  // Presence checks only; no secret value ever leaves the server. Things the
  // server can't see (GitHub Actions secrets) are listed as "check in GitHub".
  // The checklist and status the admin's Setup card shows (and HQ's summary
  // counts).
  async function setupReport() {
    const env = process.env;
    const cronSecrets = [newsletter.cronSecret, eventCheckSecret, submissionReviewSecret].filter(Boolean);
    const checks = [
      { key: 'database', label: 'Database', ok: storeBundle.kind === 'postgres', level: 'required',
        fix: 'Add a Postgres database in Railway so events and subscribers survive deploys.' },
      { key: 'login', label: 'Admin login', ok: auth.configured, level: 'required',
        fix: 'Set ADMIN_USERNAME, ADMIN_PASSWORD and ADMIN_SESSION_SECRET in Railway.' },
      { key: 'admin_secrets', label: 'Admin session secret and token are long enough', ok: !weakAdminSecrets.length, level: 'required',
        fix: weakAdminSecrets.length ? `${weakAdminSecrets.join('; ')}. ${WEAK_ADMIN_FIX}` : WEAK_ADMIN_FIX },
      { key: 'admin_password', label: 'Admin password is 12+ characters', ok: !shortPassword.length, level: 'recommended',
        fix: SHORT_PASSWORD_FIX },
      { key: 'auto_publish', label: 'Auto-publish events', ok: env.AUTO_PUBLISH !== '0', level: 'required',
        fix: 'Remove AUTO_PUBLISH=0 from Railway.' },
      { key: 'slack', label: 'Slack alerts', ok: slack.enabled && slack.alertsRouted !== false && !slackRefusedText(), level: 'recommended',
        fix: slackRefusedText() || 'Set SLACK_WEBHOOK_URL in Railway to get pings for breakage, sponsors and submissions. Optional: SLACK_SALES_WEBHOOK_URL, SLACK_ACTIVITY_WEBHOOK_URL, SLACK_ALERTS_WEBHOOK_URL, SLACK_HYPE_WEBHOOK_URL (new subscribers and sponsors) and SLACK_INBOX_WEBHOOK_URL (replies and contact messages) send each kind to its own channel.' },
      { key: 'newsletter', label: 'Email newsletter (Resend)', ok: newsletter.enabled && Boolean(newsletter.address), level: 'recommended',
        fix: newsletter.enabled ? 'Set NEWSLETTER_ADDRESS (a mailing address is required by law in every email).' : 'Set RESEND_API_KEY and NEWSLETTER_ADDRESS in Railway.' },
      { key: 'business_name', label: 'Legal pages name your business', ok: hasLegalName(), level: 'recommended',
        fix: `Set BUSINESS_LEGAL_NAME in Railway to the legal name of the company that runs the site (e.g. "Example Media LLC"). Until then the terms, privacy policy and referral rules name ${town.siteName} itself as the operator.` },
      { key: 'business_contact', label: 'Legal and privacy contact email', ok: hasContactEmail(), level: 'recommended',
        fix: 'Set BUSINESS_CONTACT_EMAIL in Railway to an inbox you read. The terms, privacy policy, refund policy and referral rules tell people to email it (refunds, deletion requests, free drawing entries). Until then they show NEWSLETTER_REPLY_TO or the news@ address.' },
      { key: 'business_address', label: 'Mailing address on the legal pages', ok: Boolean(mailingAddress()), level: 'recommended',
        fix: 'Set NEWSLETTER_ADDRESS in Railway (a PO box or a registered mailbox is fine). The legal pages print it as the business address, and every newsletter must carry it.' },
      { key: 'newsletter_auto', label: newsletter.weekend ? `Newsletter sends itself (Mondays ${startLabel('newsletter')}, Thursdays ${startLabel('newsletter-weekend')})` : `Newsletter sends itself (Mondays ${startLabel('newsletter')})`, ok: newsletter.enabled && newsletter.autosend, level: 'recommended',
        fix: !newsletter.enabled ? 'Set RESEND_API_KEY in Railway first.'
          : 'NEWSLETTER_AUTOSEND=0 is set in Railway; remove it to send automatically.' },
      { key: 'reply_to', label: 'Email replies reach you', ok: Boolean(newsletter.replyTo || newsletter.inbound), level: 'recommended',
        fix: `Replies to news@ go to Slack once Resend receives for ${town.domain}: in Resend, turn on receiving for the domain and add its MX record; add a webhook (event email.received) to ` + siteUrl +
          '/api/email/inbound and put its signing secret in Railway as RESEND_WEBHOOK_SECRET. (Or set NEWSLETTER_REPLY_TO to an inbox you read.)' },
      { key: 'scheduler', label: 'Event collect, social posts, event check, ads report and AI review start on time',
        // The town's jobs worker runs them (JOBS_ON_RAILWAY.md); nothing runs on GitHub.
        ok: jobs.enabled, level: 'recommended',
        fix: 'Set JOBS_ON_RAILWAY=1 and JOBS_SECRET (32+ characters) on this service and add its jobs service (RAILWAY.md "Jobs on Railway"). Until then the collect, event check, AI review, social posts and ads report don\'t run (the newsletter is sent on time either way).' },
      { key: 'submission_review', label: 'AI review publishes good free submissions',
        ok: Boolean(submissionReviewSecret), level: 'recommended',
        fix: 'Set SUBMISSION_REVIEW_SECRET in Railway (a long random string; the jobs service references it), plus OPENAI_API_KEY on the jobs service. Until then new submissions wait for you in the Submissions tab.' },
      { key: 'meta_pixel', label: 'Meta Pixel (ad tracking)', ok: Boolean(pixelId(opts.metaPixelId ?? env.META_PIXEL_ID)), level: 'recommended',
        fix: 'Set META_PIXEL_ID in Railway (the digits from Meta Events Manager) so ad visits and signups are counted.' },
      { key: 'meta_ads', label: 'Daily Meta ads report', ok: null, level: 'recommended',
        fix: 'On the jobs service in Railway: META_ADS_TOKEN (a system-user token with ads_read and ads_management, the ad account assigned), META_TOWN and META_AD_ACCOUNT_ID (the ad account its town.json pins). Without META_ADS_TOKEN the report uses the Page token, which works once the ad account is assigned to its system user.' },
      { key: 'instagram', label: 'Instagram posting', ok: null, level: 'recommended',
        fix: 'On the jobs service in Railway: IG_USER_ID (the Instagram business account linked to the Facebook Page), once it is pinned in the town\'s settings ("meta".ig_user_id). Without it only Facebook gets the daily post.' },
      { key: 'stripe', label: 'Sponsor payments (Stripe)', ok: stripeCfg.enabled, level: 'recommended',
        fix: 'In Stripe: create a restricted key (Checkout Sessions, Products and Prices: write) and a webhook to ' + siteUrl +
          '/api/stripe/webhook on API version 2026-09-30.endive. Put them in Railway as STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.' },
      // Production with Stripe's test keys: anyone can book with Stripe's
      // public test card. Fine for a new town's launch test, never after.
      ...(stripeCfg.production && stripeCfg.testKey ? [{ key: 'stripe_test_key', label: 'Stripe is in test mode', ok: false, level: 'recommended',
        fix: 'STRIPE_SECRET_KEY in Railway is a test key (sk_test_ or rk_test_), so sponsors can book with Stripe\'s test card and nothing is charged. ' +
          'Once the launch test checkout is done, switch to the live restricted key and the live webhook endpoint\'s STRIPE_WEBHOOK_SECRET.' }] : []),
      { key: 'event_check', label: 'Event check hides church events, non-events and duplicates',
        ok: Boolean(eventCheckSecret), level: 'recommended',
        fix: 'Set EVENT_CHECK_SECRET in Railway (any long random string; the jobs service references it). Until then the check only reports to Slack.' },
      { key: 'separate_secrets', label: 'Each automation has its own secret', ok: new Set(cronSecrets).size === cronSecrets.length, level: 'optional',
        fix: 'NEWSLETTER_CRON_SECRET, EVENT_CHECK_SECRET and SUBMISSION_REVIEW_SECRET share a value (or one is unset and borrows another), so one leak could send the newsletter, hide events and publish submissions. Give each its own long random string in Railway (the jobs service references them).' },
      // Required: without it every newsletter signup must confirm by email
      // (newsletter.js), and the forms have no bot check at all.
      { key: 'spam', label: 'Spam protection on forms (Turnstile)', ok: Boolean(turnstileSecret && turnstileSiteKey), level: 'required',
        fix: `In Cloudflare Turnstile, add a widget (or add www.${town.domain} to an existing one) in Managed mode, then set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY in Railway. Protects Submit, Contact, newsletter signup and sponsor checkout; until then every newsletter signup has to confirm by email.` },
      { key: 'social', label: 'Auto-post to Facebook + Instagram', ok: null, level: 'recommended',
        fix: 'On the jobs service in Railway: META_TOWN, META_PAGE_ID (the page the town\'s settings pin), META_PAGE_TOKEN and SOCIAL_AUTOPOST = 1.' },
      { key: 'collector_keys', label: 'Event collector keys (OpenAI, Apify, Gemini)', ok: null, level: 'recommended',
        fix: 'On the jobs service in Railway (project-shared variables): OPENAI_API_KEY (cleanup + junk filter), APIFY_TOKEN (Facebook, Instagram, Eventbrite) and GEMINI_API_KEY (Google Search discovery; free key at aistudio.google.com).' }
    ];

    const status = {};
    try {
      const pub = (await store.getPublished()) || {};
      const today = localDateStr(nowFn());
      // What visitors see: less anything the event check hid.
      const events = visibleKeyed(pub, []);
      status.live_events = events.length;
      status.upcoming_events = events.filter(e => e && e.date >= today).length;
      status.hidden_events = (pub.hidden || []).filter(h => h.date >= today).length;
      status.auto_published_at = (pub.auto_publish && pub.auto_publish.at) || null;
      status.published_at = pub.last_updated || null;
    } catch { /* leave blank */ }
    try { status.collected_at = (await readCandidates()).last_updated || null; } catch { /* none */ }
    try { status.pending_submissions = (await store.list({ status: 'pending' })).length; } catch { /* none */ }
    try {
      if (typeof store.countSubscribers === 'function') status.subscribers = (await store.countSubscribers()).active || 0;
    } catch { /* none */ }
    return { checks, status };
  }

  app.get(hqPaths('/api/admin/setup'), adminOrHq, async (req, res) => {
    const { checks, status } = await setupReport();
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, checks, status, site_url: siteUrl });
  });

  // The admin Inbox page: every owner ping (server/inbox.js), newest first,
  // so an email reply or an alert is readable here and not only in Slack or HQ.
  // ?before=<id> pages back.
  app.get('/api/admin/inbox', requireAdmin, async (req, res, next) => {
    try {
      const before = /^\d{1,15}$/.test(String(req.query.before || '')) ? Number(req.query.before) : 0;
      const limit = 50;
      const events = typeof store.listRecentInboxEvents === 'function' ? await store.listRecentInboxEvents(before, limit + 1) : [];
      res.set('Cache-Control', 'no-store').json({ ok: true, events: events.slice(0, limit), more: events.length > limit });
    } catch (err) { next(err); }
  });

  // HQ dashboard feed (server/hq.js): off (404) unless HQ_API_KEY is set.
  registerHq(app, {
    key: opts.hqApiKey ?? (process.env.HQ_API_KEY || '').trim(),
    limiter: opts.hqLimiter || createRateLimiter({ windowMs: 60 * 1000, max: 30 }),
    nowFn: () => (opts.now || (() => new Date()))(),
    clientKey,
    inbox: (since, limit) => (typeof store.listInboxEvents === 'function' ? store.listInboxEvents(since, limit) : []),
    latestInbox: () => (typeof store.latestInboxId === 'function' ? store.latestInboxId() : null),
    subscribers: async (after) => ({ name: town.siteName, total: (await store.countSubscribers()).active, ...(await store.listConfirmedSince(after, 500)) }),
    // Straight to the #hype webhook: no [town] tag (it's every town's news)
    // and not this town's owner inbox.
    hype: (msg) => { const { title, blocks } = hypeBlocks(msg, slackEscape); return slack.post(title, blocks, 'hype'); },
    // HQ's one morning ads message for every town, to the activity channel
    // (no [town] tag: it's every town's).
    morning: (msg) => { const { title, blocks } = morningBlocks(msg, slackEscape); return slack.post(title, blocks, 'activity'); },
    // HQ's own alerts (a town down, a town's Slack refusing, HQ's sync stuck)
    // to the alerts channel: HQ has no webhook of its own. Not this town's
    // inbox (HQ keeps its own item) and no [town] tag.
    alert: (msg) => { const text = hqAlertText(msg, slackEscape); return slack.post(text, null, 'alerts'); },
    build: () => buildSummary({
      store, town, siteUrl, nowFn: () => (opts.now || (() => new Date()))(),
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7),
      getEvents: async () => [...(((await getPublicPayload()) || {}).events || []), ...(await listArchived().catch(() => []))],
      getOrders: async () => (typeof store.listSponsorOrders === 'function' ? store.listSponsorOrders() : []),
      setup: setupReport,
      getJobs: jobs.enabled ? async () => jobsSummary(await jobs.stats()) : null,
      getNewsletterRuns: async () => ({ weekly: await scheduler.ran('newsletter'), weekend: await scheduler.ran('newsletter-weekend') }),
      getAdCampaigns: typeof store.getTownFile === 'function' ? async () => {
        const f = await store.getTownFile('ad_campaigns');
        return f ? { campaigns: (f.data && f.data.campaigns) || [], updated_at: f.updated_at } : null;
      } : null,
      getAdsReport: typeof store.getTownFile === 'function' ? async () => {
        const f = await store.getTownFile('ads_report');
        return f && f.data ? { ...(f.data.data || {}), link: f.data.link || null, updated_at: f.updated_at } : null;
      } : null,
      dormant: Boolean(town.dormant),
      // database: Postgres configured and answering a ping now (3 s), not
      // just configured: a town whose database is down must not read healthy.
      health: async () => {
        const configured = storeBundle.kind === 'postgres';
        const database = configured && storeBundle.pool ? await pingDatabase(3000).then(() => true, () => false) : configured;
        return { database, database_configured: configured, scheduler_blocked: !jobs.enabled && schedulerEnabled(),
          slack_refused: Boolean(slackRefusedText()) };
      }
    })
  });

  // ─── Static site ───
  // Images and icons rarely change: a day's cache saves a mobile visitor
  // ~10 revalidations per page. CSS/JS have no cache-busting ?v=, so keep
  // theirs short enough that a deploy shows up quickly. Social-kit files
  // are rebuilt daily under the same names. HTML and JSON stay revalidated.
  // docs/submit.html is Victoria's form, served as a static file. Another
  // town gets it rewritten for it (server/localize.js), ahead of the static
  // handler; Victoria's keeps the static path untouched.
  if (town.id !== VICTORIA.id) {
    // robots.txt names the town's own sitemap (its overlay copy as is).
    app.get('/robots.txt', wrap(async (req, res) => {
      const file = townAssetPath('robots.txt');
      let text = await fsp.readFile(file, 'utf8');
      if (file === path.join(DOCS_DIR, 'robots.txt')) text = text.split('https://www.thevic361.com').join(siteUrl);
      res.type('text/plain').send(text);
    }));
    // The shared stylesheets with the town's own colors appended
    // (server/palette.js); without a palette they're served as they are.
    for (const [file, extra] of [['style.css', townStyleCss], ['submit.css', townSubmitCss]]) {
      const css = extra(town);
      if (!css) continue;
      let text = null;
      app.get('/' + file, wrap(async (req, res) => {
        if (text === null || opts.reloadTemplates) text = await fsp.readFile(path.join(DOCS_DIR, file), 'utf8') + css;
        res.set('Cache-Control', 'public, max-age=600').type('text/css').send(text);
      }));
    }
    let submitPage = null;
    app.get(['/submit', '/submit.html'], wrap(async (req, res) => {
      if (!submitPage || opts.reloadTemplates) submitPage = localizeHtml(await fsp.readFile(path.join(DOCS_DIR, 'submit.html'), 'utf8'));
      sendHtml(res, submitPage);
    }));
  }

  // Another town's own static files (towns/<slug>/public/: logo, share
  // image, email skyline, robots.txt…) come first; anything it doesn't have
  // falls through to docs/. Victoria has none.
  const staticOptions = base => ({
    extensions: ['html'],
    index: false,
    setHeaders(res, file) {
      const rel = path.relative(base, file).split(path.sep).join('/');
      let cc = 'public, max-age=0';
      if (rel.startsWith('social/')) cc = 'public, max-age=300';
      else if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(rel)) cc = 'public, max-age=86400';
      else if (/\.(css|js)$/i.test(rel)) cc = 'public, max-age=600';
      res.setHeader('Cache-Control', cc);
      // Whatever URL spelling reached it, the admin page gets the admin CSP.
      if (rel === 'admin.html') res.setHeader('Content-Security-Policy', adminCsp);
    }
  });
  if (town.publicDir && existsSync(town.publicDir)) app.use(express.static(town.publicDir, staticOptions(town.publicDir)));
  // The town's social kit, built and posted by its jobs worker and kept in
  // its database (server/jobs.js); Facebook and Instagram fetch the slides
  // from here. → 'sent', 'none' (no such file) or 'error'.
  const SOCIAL_FILE = /^\/social\/latest\/([a-z0-9][a-z0-9_-]{0,63}\.(?:png|jpg|mp4|json|html|txt))$/;
  async function sendSocialFile(name, req, res) {
    if (!(req.method === 'GET' || req.method === 'HEAD') || typeof store.getSocialFile !== 'function') return 'none';
    let f = null;
    try { f = await store.getSocialFile(name); } catch (err) {
      console.warn('[social] read failed:', err.message);
      return 'error';
    }
    if (!f) return 'none';
    res.set({ 'Content-Type': f.type, 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff', 'Last-Modified': new Date(f.updated_at).toUTCString() });
    res.send(f.body);
    return 'sent';
  }
  // Victoria's kit moved from git (docs/social/latest/, committed by GitHub)
  // to her database with her jobs (JOBS_ON_RAILWAY.md phase 5). Until her
  // worker publishes its first kit, and whenever the database can't answer,
  // the git copy is served, so links and posts already out keep working.
  // Without jobs on (staging, a PR copy) only git's, and her database isn't
  // asked (its social table is made on first use).
  if (town.id === VICTORIA.id && jobs.enabled) {
    app.use(async (req, res, next) => {
      let p = req.path;
      try { p = path.posix.normalize(decodeURIComponent(p)); } catch (_) { return next(); }
      const m = SOCIAL_FILE.exec(p);
      if (!m) return next();
      const got = await sendSocialFile(m[1], req, res);
      if (got === 'sent') return;
      if (got === 'none' && typeof store.getSocialFile === 'function') {
        // A kit in the database is the whole kit: a name it doesn't have is
        // gone, not one to find in git's older kit.
        let hasKit = false;
        try { hasKit = Boolean(await store.getSocialFile('kit.json')); } catch (_) { hasKit = false; }
        if (hasKit) return res.status(404).type('text/plain').send('Not found');
      }
      next();
    });
  }
  // docs/ holds Victoria's own data next to the shared site files: its
  // bundled events.json and its social kit. Another town without its own
  // copy gets an empty list and a 404, never Victoria's events or posts.
  // Decide on the path express.static will use (it decodes %-escapes and
  // normalizes), so /%65vents.json, /index or /%73ubmit can't reach
  // Victoria's raw docs/ copies: her events, social kit, homepage (with her
  // GA tag) and submit form. Those pages are routed above by exact spelling.
  if (town.id !== VICTORIA.id) {
    app.use(async (req, res, next) => {
      let p = req.path;
      try { p = path.posix.normalize(decodeURIComponent(p)); } catch (_) { return next(); }
      if (/^\/events\.json$/i.test(p)) {
        res.set('Cache-Control', 'no-store');
        return res.json({ last_updated: null, events: [] });
      }
      // The town's own social kit (sendSocialFile). Nothing else under
      // /social: never Victoria's.
      if (/^\/social(\/|$)/i.test(p)) {
        const m = SOCIAL_FILE.exec(p);
        const got = m ? await sendSocialFile(m[1], req, res) : 'none';
        if (got === 'sent') return;
        if (got === 'error') return res.status(503).set('Retry-After', '60').type('text/plain').send('Try again shortly');
        return res.status(404).type('text/plain').send('Not found');
      }
      if (/^\/index(\.html)?$/i.test(p)) return res.redirect(301, '/');
      if (/^\/submit(\.html)?$/i.test(p)) return res.redirect(301, '/submit');
      next();
    });
  }
  app.use(express.static(DOCS_DIR, staticOptions(DOCS_DIR)));

  // ─── 404 + error handlers ───
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }
    // A person following a mistyped or old link gets the site, not a dead
    // end; images, scripts and other files keep the short text answer.
    const wantsPage = /text\/html/.test(req.get('accept') || '') ||
      (!/\.[a-z0-9]+$/i.test(req.path) && req.accepts(['html', 'text']) === 'html');
    if ((req.method === 'GET' || req.method === 'HEAD') && wantsPage) {
      return sendHtml(res, renderNotFoundPage({ siteUrl, kind: req.path.startsWith('/venues/') ? 'venue' : req.path.startsWith('/events/') ? 'event' : 'page' }), 404);
    }
    res.status(404).type('text/plain').send('Not found');
  });

  app.use((err, req, res, next) => {
    // Too late to answer (a handler failed after sending): let Express close it.
    if (res.headersSent) return next(err);
    // A garbled tracking beacon (bad JSON from a browser extension, a bot)
    // isn't worth a 500 or an error log line.
    if (req.path === '/api/track') return res.status(204).end();
    // A body over its size limit (body-parser 413) is the sender's problem,
    // not a site error: no 500, no Slack alert. On the sponsor checkout it
    // means the logo was too big, so say that.
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      if (req.path === '/advertise/checkout') return sendHtml(res, renderLogoTooLargePage({ siteUrl }), 413, 'no-store');
      if (req.path.startsWith('/api/')) return res.status(413).json({ ok: false, error: 'too-large' });
      return res.status(413).type('text/plain').send('Too large');
    }
    // Other client errors Express flags (malformed JSON, a bad %-escape in
    // a URL) are the sender's too: answer with their status, no alert.
    const status = Number(err && (err.status || err.statusCode));
    if (status >= 400 && status < 500) {
      if (req.path.startsWith('/api/')) {
        return res.status(status).json({ ok: false, error: err.type === 'entity.parse.failed' ? 'bad-json' : 'bad-request' });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && /text\/html/.test(req.get('accept') || '')) {
        return sendHtml(res, renderNotFoundPage({ siteUrl, kind: req.path.startsWith('/venues/') ? 'venue' : req.path.startsWith('/events/') ? 'event' : 'page' }), status);
      }
      return res.status(status).type('text/plain').send('Bad request');
    }
    console.error('[server] error:', err);
    // Keyed on the message, not the path, so one fault hit on many URLs
    // alerts once.
    slack.alert(`500:${err && err.message}`, 'Site error (500)',
      `${req.method} ${req.path}\n${(err && err.message) || err}`);
    if (req.path.startsWith('/api/')) {
      return res.status(500).json({ ok: false, error: 'server-error' });
    }
    res.status(500).type('text/plain').send('Server error');
  });

  await archiveReady;
  await refreshReach();
  return { app, store, storeBundle, slack: rawSlack, alerts: slack, scheduler, submissionReview, healthCheck, newsletter: newsletterApi, sponsors };
}

// Start the server when invoked directly. Importing this module (e.g. from
// tests) does not auto-listen.
const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch (_) { return false; }
})();

export function shutdown(server, { exit = code => process.exit(code), graceMs = 8000, log = console.log } = {}) {
  log(`[${town.domain}] SIGTERM: finishing requests, then exiting`);
  const timer = setTimeout(() => exit(0), graceMs);
  if (timer.unref) timer.unref();
  server.close(() => { clearTimeout(timer); exit(0); });
  if (server.closeIdleConnections) server.closeIdleConnections();
}

if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const cfg = slackConfig();
  const bootSlack = createSlack(cfg);
  // Once the app is up, its notifier (the owner inbox too) says it.
  let live = null;
  const alerts = () => live || bootSlack;
  // A crash takes the site down until Railway restarts it; say so first.
  process.on('uncaughtException', err => {
    console.error(`[${town.domain}] uncaught:`, err);
    // A hung database or Slack mustn't keep a crashed process alive.
    Promise.race([alerts().alert('crash', 'Server crashed and is restarting', err && err.stack ? err.stack.slice(0, 1500) : String(err)),
      new Promise(r => { setTimeout(r, 9000).unref(); })])
      .finally(() => process.exit(1));
  });
  process.on('unhandledRejection', err => {
    console.error(`[${town.domain}] unhandled rejection:`, err);
    alerts().alert(`rejection:${err && err.message}`, 'Unhandled error in the server', (err && err.message) || String(err));
  });
  createApp().then(({ app, storeBundle, alerts: appAlerts }) => {
    live = appAlerts;
    // No "deployed" ping: every merge redeploys, so it was noise. A failed
    // boot or a crash still alerts (below and above).
    const server = app.listen(port, () => {
      console.log(`[${town.domain}] listening on :${port} (storage=${storeBundle.kind})`);
    });
    // Railway stops the old copy with SIGTERM on every deploy. Finish the
    // requests in flight and exit 0, so npm doesn't log the stop as an
    // error ("npm error signal SIGTERM"). Cut off after 8s either way.
    process.once('SIGTERM', () => shutdown(server));
  }).catch(err => {
    console.error(`[${town.domain}] failed to start:`, err);
    bootSlack.alert('boot', 'Server failed to start', (err && err.message) || String(err))
      .finally(() => process.exit(1));
  });
}
