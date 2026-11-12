// @sigil implements design/claude-mcp-server.sigil ClaudeMcpServer
//
// The plugin's MCP server: four tools backed by DelegationService. Claude Code
// names them mcp__plugin_subzero_subzero__<tool>.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { configuredTierNames, LoadError, MissingAgentFileError, routableTiers, TierError, UnknownAgentError, UnresolvedRootError } from '../config/agent-config.js';
import { mapRequest } from '../config/tier-words.js';
import { isTaskId } from '../core/ids.js';
import { UnsupportedHostError } from '../kernel/kernel.js';
import { EmptyBriefError, type DelegationService } from '../service/delegation-service.js';
import { describeReply, formatAwait, formatListing, REPLY_BUDGET_CHARS } from './format.js';
import { ProgressReporter, type ProgressOptions } from './progress.js';

export const SERVER_INSTRUCTIONS = [
  'Use the delegate tool to hand a task to a child on another model, naming an agent, a model tier, both or neither.',
  'Write a self-contained brief: the goal, the relevant file paths, the constraints and the output you expect.',
  'The child cannot see this conversation; it sees only the brief.',
].join(' ');

export const MAX_AWAIT_SECONDS = 600;

const DELEGATE_DESCRIPTION =
  'Delegate a task to a subzero agent running on another model. With no agent it runs the general agent. A tier picks the model the agent runs on. Returns the result with the task id first, or the task id at once when wait is false.';

const TOOLS = [
  {
    name: 'delegate',
    description: DELEGATE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name of an agent in .agents/subzero.yaml; none runs the general agent' },
        tier: { type: 'string', description: 'A model tier, medium or tier:medium; the tiers this server can run are listed in the description of this tool' },
        brief: { type: 'string', description: 'A self-contained brief; the child cannot see this conversation' },
        files: { type: 'array', items: { type: 'string' }, description: 'Paths the child should read' },
        expected_output: { type: 'string', description: 'What the result should contain' },
        wait: { type: 'boolean', description: 'Wait for the result (default true)' },
      },
      required: ['brief'],
    },
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'tasks',
    description: 'List the tasks of this conversation (at most 50), or show one task by its task id.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'await',
    description: 'Collect the results of tasks started with wait: false, waiting up to timeout_s seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: { type: 'array', items: { type: 'string' } },
        timeout_s: { type: 'number', description: `Seconds to wait, at most ${MAX_AWAIT_SECONDS}` },
      },
      required: ['tasks'],
    },
    annotations: { readOnlyHint: true },
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'cancel',
    description: 'Cancel one task, or all tasks of this session when no task is given.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
  },
];

export interface SubzeroServerOptions {
  service: DelegationService;
  /** The parent session id of the current conversation, when the hook recorded it. */
  parentSessionId: () => string | undefined;
  progress?: ProgressOptions;
  version?: string;
}

/** A tool reply, never cut: Claude Code saves a reply over its inline limit to a file. */
function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

/** What a caller does when delegate made no task because the tier or its host cannot run. */
const PASS_BACK =
  "delegate made no task. Dispatch that subagent through Claude's own Agent tool instead, as a pass-back: call Agent with the same prompt and a short description that begins with passback.";

function toolError(err: unknown): CallToolResult {
  if (err instanceof UnresolvedRootError) {
    return text(
      `${err.message} This is a configuration problem the user must fix; do not retry this call.`,
      true,
    );
  }
  if (err instanceof TierError || err instanceof UnsupportedHostError || err instanceof MissingAgentFileError) return text(`${err.message}. ${PASS_BACK}`, true);
  if (err instanceof UnknownAgentError || err instanceof LoadError || err instanceof EmptyBriefError) {
    return text(err.message, true);
  }
  return text(`subzero failed: ${(err as Error)?.message ?? String(err)}`, true);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === 'string' ? (args[key] as string) : undefined;
}

export function createSubzeroServer(options: SubzeroServerOptions): Server {
  const { service } = options;
  const server = new Server(
    { name: 'subzero', version: options.version ?? '0.0.0-dev' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  let lastSession: string | undefined;
  let watcher: NodeJS.Timeout | undefined;
  const syncSession = async (): Promise<string | undefined> => {
    await service.start();
    const current = options.parentSessionId();
    const previous = lastSession;
    if (current !== undefined) lastSession = current;
    if (current !== undefined && previous !== undefined && current !== previous) await service.cancelSession(previous);
    return current;
  };
  const stopWatchingIfIdle = () => {
    if (watcher && !service.hasLiveSessionTasks()) { clearInterval(watcher); watcher = undefined; }
  };
  const watchSessions = () => {
    if (watcher || !service.hasLiveSessionTasks()) return;
    watcher = setInterval(() => void syncSession().catch(() => undefined).finally(stopWatchingIfIdle), 5000);
    watcher.unref();
  };
  server.onclose = () => { if (watcher) clearInterval(watcher); watcher = undefined; };

  // The delegate description names the tiers the agent file holds now, read at each listing.
  async function delegateDescription(): Promise<string> {
    try {
      await service.start();
      const root = service.projectRoot;
      if (root === undefined) return DELEGATE_DESCRIPTION;
      const tiers = routableTiers(root, service.supportedHosts());
      if (tiers.length === 0) return DELEGATE_DESCRIPTION;
      const list = tiers.map((t) => `${t.tier} → ${t.model} (host ${t.host})`).join('; ');
      return `${DELEGATE_DESCRIPTION} Tiers you can pass as tier: ${list}.`;
    } catch {
      return DELEGATE_DESCRIPTION;
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { await syncSession(); } catch { /* A later call reports the root error. */ }
    const description = await delegateDescription();
    return { tools: TOOLS.map((tool) => (tool.name === 'delegate' ? { ...tool, description } : tool)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const currentSession = await syncSession();
      switch (request.params.name) {
        case 'delegate': {
          const agent = stringArg(args, 'agent');
          const brief = stringArg(args, 'brief');
          if (brief === undefined) return text('delegate needs a brief', true);
          const tier = stringArg(args, 'tier');
          const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : undefined;
          const expectedOutput = stringArg(args, 'expected_output');
          const wait = args.wait !== false;
          // Connect first, so the parent session id is read for the resolved root.
          await service.start();
          const parentSessionId = currentSession;
          const tiers = configuredTierNames(service.projectRoot!);
          const mapped = mapRequest(agent, tier, tiers);
          if (mapped.tier.kind === 'unmatched') throw new TierError(mapped.tier.value, tiers);

          const progressToken = request.params._meta?.progressToken;
          const reporter =
            wait && progressToken !== undefined
              ? new ProgressReporter(
                  agent ?? 'general',
                  (progress, message) =>
                    void extra
                      .sendNotification({ method: 'notifications/progress', params: { progressToken, progress, message } })
                      .catch(() => undefined),
                  options.progress,
                )
              : null;
          try {
            const reply = await service.delegate(
              {
                ...(mapped.agent !== undefined ? { agent: mapped.agent } : {}),
                ...(mapped.tier.kind === 'tier' ? { tier: mapped.tier.name } : {}),
                briefText: brief,
                ...(files !== undefined ? { files } : {}),
                ...(expectedOutput !== undefined ? { expectedOutput } : {}),
                // The child's result comes back whole; this keeps it within Claude Code's inline limit.
                replyBudgetChars: REPLY_BUDGET_CHARS,
                ...(parentSessionId !== undefined ? { parentSessionId } : {}),
              },
              {
                wait,
                ...(reporter ? { onEvent: (e) => reporter.onEvent(e) } : {}),
                onState: (state) => {
                  reporter?.onState(state);
                  if (parentSessionId !== undefined && lastSession !== undefined && parentSessionId !== lastSession) {
                    void service.cancelSession(parentSessionId);
                  }
                  watchSessions();
                  if (state === 'Settled' || state === 'Failed' || state === 'Cancelled') setImmediate(stopWatchingIfIdle);
                },
                // notifications/cancelled for a waited call cancels its task.
                ...(wait ? { signal: extra.signal } : {}),
              },
            );
            return text(describeReply(reply));
          } finally {
            reporter?.stop();
          }
        }

        case 'tasks': {
          const task = stringArg(args, 'task');
          if (task !== undefined) {
            if (!isTaskId(task)) return text(`"${task}" is not a task id`, true);
            const views = await service.list();
            const view = views.find((v) => v.taskId === task);
            if (view === undefined) return text(`task: ${task} · no such task`);
            return text(describeReply(await service.collect(task), view));
          }
          await service.start();
          const parentSessionId = currentSession;
          const views = await service.list(parentSessionId);
          return text(formatListing(views, parentSessionId !== undefined));
        }

        case 'await': {
          const ids = Array.isArray(args.tasks) ? args.tasks.filter((t): t is string => typeof t === 'string') : [];
          if (ids.length === 0) return text('await needs at least one task id', true);
          const seconds = typeof args.timeout_s === 'number' && args.timeout_s >= 0 ? Math.min(args.timeout_s, MAX_AWAIT_SECONDS) : 30;
          const replies = await Promise.all(ids.map((id) => service.waitFor(id, seconds * 1000)));
          // Whole results while they fit, the first always; a later one that does not fit is deferred, never cut.
          return text(formatAwait(replies));
        }

        case 'cancel': {
          const task = stringArg(args, 'task');
          if (task === undefined) {
            await service.start();
            const cancelled = await service.cancelSession(currentSession);
            return cancelled.kind === 'unknown_session'
              ? text('session is unknown; no tasks were cancelled', true)
              : text(`${cancelled.count} tasks cancelled${cancelled.count ? `: ${cancelled.taskIds.join(', ')}` : ''}`);
          }
          return text(describeReply(await service.cancel(task)));
        }

        default:
          return text(`unknown tool ${request.params.name}`, true);
      }
    } catch (err) {
      return toolError(err);
    }
  });

  return server;
}
