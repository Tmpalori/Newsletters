/* server/github.js — Server-side GitHub Contents API publisher.
 *
 * Replaces the browser-side GitHub PAT flow. The server holds a single token
 * (GITHUB_TOKEN / GITHUB_PAT) with `contents:write` access to the configured
 * repo and exposes two operations to the admin via authenticated routes:
 *
 *   - getJsonFile(path)       Read + parse a JSON file at HEAD on BRANCH.
 *   - putJsonFile(path,...)   Write an updated JSON file via PUT /contents.
 *
 * Configured by env (defaults match the existing Tmpalori/thevic361 setup):
 *
 *   GITHUB_TOKEN | GITHUB_PAT   Token with contents:write on the repo.
 *   GITHUB_OWNER                Default: the repo Railway deployed from
 *                               (RAILWAY_GIT_REPO_OWNER), else "Tmpalori"
 *   GITHUB_REPO                 Default: the repo Railway deployed from
 *                               (RAILWAY_GIT_REPO_NAME), else "thevic361",
 *                               so renaming the repo needs no variable
 *   GITHUB_BRANCH               Default: "main"
 *
 * If no token is configured, isConfigured() returns false and route handlers
 * surface a 503 with a clear message.
 */

const DEFAULT_OWNER = 'Tmpalori';
const DEFAULT_REPO = 'thevic361';
const DEFAULT_BRANCH = 'main';
// Every GitHub call gives up after this. A GitHub API that accepts the
// connection and then hangs would otherwise hold the admin's Events tab and
// Save & Publish for undici's 5-minute default, and the callers' local-file
// fallbacks only run once a call fails.
export const GITHUB_TIMEOUT_MS = 15000;

export function createGithub(opts = {}) {
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? null;
  const owner = opts.owner ?? process.env.GITHUB_OWNER ?? (process.env.RAILWAY_GIT_REPO_OWNER || DEFAULT_OWNER);
  const repo = opts.repo ?? process.env.GITHUB_REPO ?? (process.env.RAILWAY_GIT_REPO_NAME || DEFAULT_REPO);
  const branch = opts.branch ?? process.env.GITHUB_BRANCH ?? DEFAULT_BRANCH;
  const rawFetch = opts.fetch || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? GITHUB_TIMEOUT_MS;

  // The signal also covers reading the body. A timeout becomes a plain
  // Error (code 'timeout', no .status: there was no HTTP answer).
  async function fetchImpl(url, init = {}) {
    try {
      return await rawFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        const e = new Error(`github-timeout after ${timeoutMs} ms`);
        e.code = 'timeout';
        throw e;
      }
      throw err;
    }
  }

  function isConfigured() { return Boolean(token); }

  function contentsUrl(filePath, ref) {
    let u = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(filePath)}`;
    if (ref) u += `?ref=${encodeURIComponent(ref)}`;
    return u;
  }

  function ghHeaders() {
    return {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'thevic361-admin-server'
    };
  }

  async function getJsonFile(filePath) {
    if (!isConfigured()) throw new Error('github-not-configured');
    const res = await fetchImpl(contentsUrl(filePath, branch), {
      headers: ghHeaders()
    });
    if (res.status === 404) {
      const err = new Error('not-found');
      err.code = 'not-found';
      err.status = 404;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`github-fetch-failed-${res.status}`);
      err.status = res.status;
      throw err;
    }
    const meta = await res.json();
    let text;
    if (meta.encoding === 'base64' && typeof meta.content === 'string') {
      text = Buffer.from(meta.content.replace(/\n/g, ''), 'base64').toString('utf8');
    } else if (meta.download_url) {
      const r2 = await fetchImpl(meta.download_url);
      text = await r2.text();
    } else {
      throw new Error('github-unsupported-response');
    }
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('github-invalid-json'); }
    return { sha: meta.sha, data };
  }

  async function putJsonFile(filePath, dataObj, message, sha) {
    if (!isConfigured()) throw new Error('github-not-configured');
    const body = {
      message: message,
      content: Buffer.from(JSON.stringify(dataObj, null, 2) + '\n', 'utf8').toString('base64'),
      branch
    };
    if (sha) body.sha = sha;
    const res = await fetchImpl(contentsUrl(filePath), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (_) {}
      const err = new Error(`github-put-failed-${res.status}: ${detail}`);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return res.json();
  }

  // ─── Workflow dispatch ────────────────────────────────────────────────
  // POST /repos/{owner}/{repo}/actions/workflows/{file}/dispatches
  // Triggers a workflow_dispatch event on `branch`. Used by the admin
  // "Sources" tab to kick the Weekly Collect job between scheduled runs,
  // and by the site scheduler to start the daily workflows on time.
  // Returns true on success. Throws an Error with .status on failure.
  // The token must have `actions:write` on the repo (a fine-grained PAT or
  // a classic PAT with `workflow` scope works); plain `contents:write` is
  // not enough. Callers surface the error to the UI.
  // `inputs` (strings) go to the workflow's workflow_dispatch inputs; the
  // site scheduler (server/scheduler.js) passes scheduled=true.
  async function dispatchWorkflow(workflowFile, ref, inputs) {
    if (!isConfigured()) throw new Error('github-not-configured');
    const url = `https://api.github.com/repos/${owner}/${repo}` +
      `/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
    const body = JSON.stringify(inputs ? { ref: ref || branch, inputs } : { ref: ref || branch });
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()),
      body
    });
    // 204 No Content is the success response.
    if (res.status === 204) return true;
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (_) {}
    const err = new Error(`github-dispatch-failed-${res.status}: ${detail}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  // ─── Workflow runs ────────────────────────────────────────────────────
  // GET /repos/{owner}/{repo}/actions/workflows/{file}/runs?per_page=N
  // Returns the parsed JSON body. Used by the admin "Sources" tab to show
  // when the last Weekly Collect run completed.
  async function listWorkflowRuns(workflowFile, perPage) {
    if (!isConfigured()) throw new Error('github-not-configured');
    const n = Math.max(1, Math.min(50, Number(perPage) || 5));
    const url = `https://api.github.com/repos/${owner}/${repo}` +
      `/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${n}`;
    const res = await fetchImpl(url, { headers: ghHeaders() });
    if (!res.ok) {
      const err = new Error(`github-runs-failed-${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    isConfigured,
    owner, repo, branch,
    getJsonFile,
    putJsonFile,
    dispatchWorkflow,
    listWorkflowRuns
  };
}
