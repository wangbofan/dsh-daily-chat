/**
 * Host half of the daily-chat plugin.
 *
 * Four jobs, all of which the browser cannot do reliably:
 *
 * 1. Own the `daily` agent preset for an install that predates this bundle's
 *    patch. The preset is DECLARED, not installed: this bundle ships
 *    `preset/daily.patch.yml` as one of its patch layers (`dsh.bundle.patch` in
 *    package.json), and that file carries the `@deepseek-ai/dsh-agent-preset`
 *    declaration DSH 0.1.7 and later read presets from. Older versions took
 *    them from a directory under the harness home's user preset root
 *    (`<dshHome>/.agent-presets/<id>/`) instead, and 0.1.7 reads that root
 *    never — "Nothing reads that directory any more" — so an install that ran a
 *    previous version of this plugin still has a copy sitting there that does
 *    nothing except look like a working preset. This half says so on the
 *    console, once per start, and leaves the directory alone: it may well have
 *    been edited by hand, and it costs nothing to keep.
 *
 * 2. Make the `daily-chat` workspace real before anything tries to adopt it.
 *    The client half identifies that workspace by its directory basename, so as
 *    long as this half guarantees `<harness home>/daily-chat` exists and is
 *    registered, the browser never has to guess a path or ask the operator to
 *    pick one.
 *
 * 3. Keep a daily chat on its own preset. A session that lives in the daily
 *    workspace may not be recomposed on another preset, and only the Host can
 *    promise that: the client half hides the new-chat row's 「Agent 模式」 chip
 *    and the client-side navigation refusals cover the project chip, but a
 *    preset switch is also reachable from surfaces this plugin does not own —
 *    the settings section's "make default" writes the new default through to
 *    the current blank session — and the preset decides which tools the model
 *    holds at all.
 *
 * 4. Erase a daily chat the operator asked to delete. Nothing in DSH deletes a
 *    session — the browser cannot unlink a file, and the persistence seam has no
 *    delete interface, only a documented note that logs accumulate "until
 *    removed externally". External removal is therefore this half's job, and it
 *    is the one job here that is not best-effort: a delete that silently did
 *    nothing would be worse than one that failed.
 *
 * The harness home is read from `DSH_HOME` with the same default the rest of the
 * deployment uses. Every job is best-effort: a failure costs a warning and
 * nothing else, because the client half already handles a missing preset (it
 * falls back to the deployment default) and a missing workspace (it falls back
 * to the directory picker). The third job is silent when the services it needs
 * are absent, and simply does not lock anything.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** The durable workspace registry this row registers the daily directory in. */
export const inject = ['workspaceRegistry'];

/** The directory name the client half matches a workspace by. */
export const DAILY_DIRECTORY = 'daily-chat';

/** The preset id this bundle declares and the client half asks a daily session to run on. */
export const DAILY_PRESET = 'daily';

/** The path the client half posts a chat it wants erased to. */
export const DELETE_ROUTE = '/dsh-daily-chat/delete';

/**
 * The only session-id shape this half will name a directory after.
 *
 * Nothing else reaches a path: the id arrives from the page, and a length of
 * page that no longer matches this pattern is a bug or an attack, not a
 * deletion. Restricting the alphabet also rules out the separators and `..`
 * that would let the id name a directory outside the sessions root at all.
 */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How much of a request body this half reads before giving up on it.
 *
 * Sized for a full batch: {@link MAX_DELETE_BATCH} ids of the {@link SESSION_ID}
 * shape plus the JSON punctuation around them is about 15 KB, so the cap leaves
 * room to spare while still refusing a body nobody meant to send.
 */
const MAX_BODY_BYTES = 65536;

/**
 * How many sessions one request may erase.
 *
 * A batch is a bulk erase of durable logs, and this is the number that decides
 * how much a single mistyped confirmation can destroy. It is also the length the
 * body cap above was sized for, so the two move together.
 */
const MAX_DELETE_BATCH = 256;

/**
 * What a blocked preset switch says. The client half already reads this field
 * class back out as the reason under DSH's own 「无法切换」 toast, so the wording
 * is the operator-facing message, not a log line.
 */
const LOCKED_PRESET_REASON =
  `日常聊天固定使用 ${DAILY_PRESET} 预设；要获得完整能力，请点侧边栏的「开始工作」。`;

/** The harness home `DSH_HOME` names, or the deployment's own default. */
function harnessHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

/**
 * Report a preset directory left over from a pre-0.1.7 install.
 *
 * DSH 0.1.7 stopped reading `<harness home>/.agent-presets/` entirely: the
 * `daily` preset now arrives with this bundle's patch, so a directory an older
 * version of this plugin copied there is inert — and, because it looks exactly
 * like an installed preset, it is the first thing worth ruling out when the
 * roster comes up without 「日常聊天」.
 *
 * This one notice goes to the console rather than to `ctx.logger`: the
 * harness's logger transport is not wired to the server's output in the
 * deployments this plugin was checked against, and a migration notice nobody
 * can see is worth nothing. The message carries its own `[daily-chat]` prefix
 * for the same reason the surrounding rows print theirs.
 *
 * @param home - the harness home.
 */
function warnAboutLegacyPreset(home) {
  const legacy = join(home, '.agent-presets', DAILY_PRESET);
  if (!existsSync(legacy)) return;
  console.warn(
    `[daily-chat] ${legacy} is no longer read (DSH 0.1.7+ takes the "${DAILY_PRESET}" preset from this bundle's patch); the directory is inert and safe to delete.`,
  );
}

/**
 * Create the daily-chat directory and register it as a workspace.
 * @param ctx - the Host context this row was mounted with.
 * @param home - the harness home.
 */
async function registerDailyWorkspace(ctx, home) {
  const directory = join(home, DAILY_DIRECTORY);

  try {
    mkdirSync(directory, { recursive: true });
  } catch (reason) {
    ctx.logger?.warn?.(`[daily-chat] creating ${directory} failed: ${String(reason)}`);
    return;
  }

  try {
    if ((await ctx.workspaceRegistry.resolveByPath(directory)) !== undefined) return;
    const workspace = await ctx.workspaceRegistry.create(directory, '日常聊天');
    ctx.logger?.info?.(`[daily-chat] daily workspace ready at ${workspace.path}`);
  } catch (reason) {
    ctx.logger?.warn?.(`[daily-chat] registering ${directory} as a workspace failed: ${String(reason)}`);
  }
}

/**
 * The project directory a session was created in, when the Host knows it.
 * @param agent - the agent handle the gateway resolved for a preset switch.
 * @returns the absolute `cwd`, or undefined for anything unexpected.
 */
function sessionDirectory(agent) {
  try {
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === 'string' ? cwd : undefined;
  } catch (reason) {
    return undefined;
  }
}

/**
 * Refuse to move a daily session onto another agent preset.
 *
 * The patch sits on the service PROTOTYPE, where the shipped method is: the
 * gateway resolves a fresh traceable proxy of the one `agentPresets` instance
 * per invocation and reads the method off the prototype at call time, so one
 * patch covers every caller — the new-chat chip, the settings section, and any
 * surface added later. The disposer puts the original back when this row
 * unloads.
 *
 * The rule is scoped to the daily workspace rather than to the preset id: the
 * `daily` preset is a normal, pickable row in the roster, and an operator who
 * deliberately runs a work session on it must still be able to switch back.
 * A session the Daily half put in `<harness home>/daily-chat` has no such
 * business.
 *
 * @param ctx - the Host context this row was mounted with.
 * @param home - the harness home.
 */
function lockDailyPreset(ctx, home) {
  const workspaceDirectory = join(home, DAILY_DIRECTORY);

  ctx.inject(['agentPresets'], (presetCtx) => {
    presetCtx.effect(() => {
      const proto = Object.getPrototypeOf(presetCtx.agentPresets);
      const original = proto === null ? undefined : proto.select;
      if (typeof original !== 'function') return undefined;

      proto.select = function select(agent, agentPreset) {
        if (agentPreset !== DAILY_PRESET && sessionDirectory(agent) === workspaceDirectory) {
          throw new Error(LOCKED_PRESET_REASON);
        }
        return original.call(this, agent, agentPreset);
      };

      return () => {
        proto.select = original;
      };
    }, 'daily-chat: daily preset lock');
  });
}

/* ── erasing a chat ───────────────────────────────────────────────────────── */

/** Where one session's projection checkpoint lives. */
function checkpointPath(home, sessionId) {
  return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
}

/**
 * Whether one session is a daily chat, and so one this route may erase.
 *
 * The workspace registry is asked first, because its `sessionIds` is exactly
 * what the client half renders rows from: an id there is an id the operator
 * saw in 日常聊天. A chat created seconds ago may not have reached the registry
 * yet, so the projection checkpoint is the second opinion — it records the
 * directory the session was created in, which is the property that actually
 * makes the session a daily one. Neither answer means no.
 *
 * @param home - the harness home.
 * @param sessionId - the validated session id.
 * @returns whether the session belongs to the daily workspace.
 */
async function isDailyChat(home, sessionId) {
  const daily = join(home, DAILY_DIRECTORY).toLowerCase();

  try {
    const registry = JSON.parse(await readFile(join(home, 'storages', 'workspace.json'), 'utf8'));
    const workspaces = registry?.tables?.workspaces;
    if (workspaces !== null && typeof workspaces === 'object') {
      for (const workspace of Object.values(workspaces)) {
        if (typeof workspace?.path !== 'string' || workspace.path.toLowerCase() !== daily) continue;
        if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return true;
      }
    }
  } catch (reason) {
    if (reason?.code !== 'ENOENT') {
      console.warn(`[daily-chat] reading the workspace registry failed: ${String(reason)}`);
    }
  }

  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath(home, sessionId), 'utf8'));
    const cwd = checkpoint?.identity?.cwd;
    return typeof cwd === 'string' && cwd.toLowerCase() === daily;
  } catch (reason) {
    return false;
  }
}

/**
 * Erase one session's log directory and its projection checkpoint.
 *
 * The sessions root holds one directory per project, named after the project
 * path by an encoding this half deliberately does not reimplement — a second
 * copy of a rule the harness owns is a second copy that can go stale. Scanning
 * one level of the root finds the session from whatever project it was created
 * in, and only ever removes a child whose name is exactly the id that was
 * asked for.
 *
 * The checkpoint goes with it. The cache is documented as the follower — "the
 * log leads, the cache follows" — and a record whose log is gone reads as
 * absent either way, but leaving one behind per deleted chat would be a leak
 * that outlives every one of them.
 *
 * @param home - the harness home.
 * @param sessionId - the validated session id.
 * @returns the log directories that were removed.
 */
async function eraseSession(home, sessionId) {
  const root = resolve(join(home, 'sessions'));
  const removed = [];

  let projects = [];
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch (reason) {
    if (reason?.code !== 'ENOENT') throw reason;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const parent = resolve(root, project.name);
    if (parent !== root && !parent.startsWith(root + sep)) continue;
    const target = join(parent, sessionId);
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }

  await rm(checkpointPath(home, sessionId), { force: true });
  return removed;
}

/** Read a request body, bounded so a page cannot make the host buffer forever. */
function readBody(req) {
  return new Promise((settle, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/** Answer one request with JSON, and never let anything cache the answer. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Mount the route the client half erases a chat through.
 *
 * A page cannot unlink a file, and this is the only half that can, so the one
 * destructive operation in the plugin crosses the HTTP boundary. The route is
 * an `exact` one: the webserver's prefix table is shared with every other
 * plugin's routes, and a prefix would claim a whole subtree to add a single
 * endpoint.
 *
 * The webserver carries no authentication of its own — route owners enforce
 * their own policy — so this handler is its own policy: the browser session's
 * fence first, then POST only, then a session id, then proof that the session
 * belongs to the daily workspace, and only then any removal. The server binds
 * loopback by default, which is the last line rather than the only one.
 *
 * @param ctx - the Host context this row was mounted with.
 * @param home - the harness home.
 */
function mountDeleteRoute(ctx, home) {
  // `connection` is declared here rather than in this plugin's own `inject`, for
  // two reasons. Cordis refuses to resolve a service the asking fiber never
  // declared — the property read itself throws `cannot get property
  // "connection" without inject` — so a fence reached through an undeclared
  // service turns every request into a failure instead of guarding it. And
  // scoping the dependency to the one job that needs it means an absent
  // `connection` would cost this route, not the plugin's other three jobs.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    // Read per request rather than captured once here: the gateway can take its
    // seat after this route mounts, and a captured `undefined` would leave the
    // route unfenced for the rest of the process's life with nothing on screen
    // to say so.
    const fence = () => webCtx.connection;
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: DELETE_ROUTE,
      handler: makeDeleteHandler(ctx, home, fence),
    }), 'daily-chat: session delete route');
  });
}

/**
 * Build the handler {@link mountDeleteRoute} registers.
 *
 * The webserver answers a throwing handler with a bare `400` and no body — the
 * one response an operator can neither read nor act on — so the whole body is
 * wrapped and every exit goes through {@link sendJson}.
 *
 * @param ctx - the Host context, for the logger.
 * @param home - the harness home.
 * @param fence - resolves the `connection` service, which owns the request
 *   policy this route has to borrow.
 * @returns the request handler.
 */
function makeDeleteHandler(ctx, home, fence) {
  return async function handleDelete(req, res) {
    try {
      // The webserver authenticates nothing, so the browser session's own fence
      // is applied by hand: the same `requestRejection` the shipped plugin
      // routes call answers 403 for an untrusted Host/Origin and 401 for a
      // request with no session cookie, and undefined for this page. Without it
      // any local page could erase chats through this route, and the loopback
      // bind would be the only thing standing in the way.
      const connection = fence();
      if (typeof connection?.requestRejection === 'function') {
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) {
          res.statusCode = rejection;
          res.end();
          return;
        }
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }

      let ids;
      try {
        const body = JSON.parse(await readBody(req));
        // One id or many: the single-row button and the batch both come through
        // here, and a batch of one is the same request either way.
        ids = typeof body?.sessionId === 'string' ? [body.sessionId] : body?.sessionIds;
      } catch (reason) {
        sendJson(res, 400, { ok: false, error: 'malformed request' });
        return;
      }

      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_DELETE_BATCH) {
        sendJson(res, 400, { ok: false, error: 'not a session id list' });
        return;
      }

      const malformed = ids.filter((id) => typeof id !== 'string' || !SESSION_ID.test(id));
      if (malformed.length > 0) {
        // Naming what arrived is the difference between a report that can be
        // acted on and one that only says the delete failed. A page built
        // against a different version of this route is the likely author.
        sendJson(res, 400, {
          ok: false,
          error: `not a session id: ${malformed.map((id) => JSON.stringify(id) ?? 'undefined').join(', ')}`,
        });
        return;
      }

      // One id per request may name a chat twice; erasing it once is the whole
      // job, and a duplicate would only report a second, confusing nothing.
      const erased = [];
      const failed = [];
      for (const sessionId of new Set(ids)) {
        try {
          if (!(await isDailyChat(home, sessionId))) {
            failed.push({ sessionId, error: 'not a daily chat' });
            continue;
          }

          const removed = await eraseSession(home, sessionId);
          erased.push(sessionId);
          ctx.logger?.info?.(
            `[daily-chat] erased ${sessionId} (${removed.length} ${removed.length === 1 ? 'entry' : 'entries'})`,
          );
          // `sessionKnown` re-indexes from disk before answering, so this is a real
          // check on what was just removed rather than a read of a stale map. It is
          // only a log line: the erase itself already succeeded, and a lingering
          // entry is the Host's to reconcile, not the operator's.
          try {
            if ((await ctx.workspaceRegistry.sessionKnown(sessionId)) === true) {
              ctx.logger?.warn?.(
                `[daily-chat] ${sessionId} is still known to the workspace registry after the erase`,
              );
            }
          } catch (reason) {
            ctx.logger?.warn?.(`[daily-chat] verifying the erase of ${sessionId} failed: ${String(reason)}`);
          }
        } catch (reason) {
          // One refusal does not abandon the rest of the batch: the operator
          // asked for several chats gone and gets told exactly which ones are
          // still there, rather than being sent to retry the whole set.
          failed.push({ sessionId, error: String(reason?.message ?? reason) });
          ctx.logger?.warn?.(`[daily-chat] erasing ${sessionId} failed: ${String(reason)}`);
        }
      }

      if (erased.length === 0) {
        sendJson(res, 403, { ok: false, error: failed[0]?.error ?? 'nothing to erase', failed });
        return;
      }

      sendJson(res, 200, { ok: true, erased, failed });
    } catch (reason) {
      ctx.logger?.warn?.(`[daily-chat] the delete route failed: ${String(reason)}`);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { ok: false, error: String(reason?.message ?? reason) });
    }
  };
}

/**
 * Prepare everything a daily chat needs before the client half asks for it.
 * @param ctx - the Host context this row was mounted with.
 */
export async function apply(ctx) {
  const home = harnessHome();
  warnAboutLegacyPreset(home);
  lockDailyPreset(ctx, home);
  mountDeleteRoute(ctx, home);
  await registerDailyWorkspace(ctx, home);
}
