// @sigil implements design/pi-extension.sigil PiExtension
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { configuredTierNames } from '../config/agent-config.js';
import { TIER_WORDS } from '../config/tier-words.js';
import type { DelegationService } from '../service/delegation-service.js';
import { describeTaskReply, listingStatus, withNotice } from '../service/status-text.js';
import { mapPiRequest } from './request.js';

const names = { collect: 'subzero_await', cancel: 'subzero_cancel' };
const result = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) });
const describe = (reply: Parameters<typeof describeTaskReply>[0]) =>
  withNotice(describeTaskReply(reply, undefined, names), 'notice' in reply ? reply.notice : undefined);

/** The entry point supplies a session core; the adapter never receives a driver. */
export function registerPiExtension(pi: ExtensionAPI, createService: (ctx: ExtensionContext) => DelegationService): void {
  let service: DelegationService | undefined;
  let sessionId = '';
  let projectRoot = '';
  let description = 'Delegate an isolated task. Await background tasks before using their results.';
  const getService = () => {
    if (!service) throw new Error('subzero session has not started');
    return service;
  };
  const respond = async (fn: () => Promise<string>) => {
    try { return result(await fn()); }
    catch (err) { return result((err as Error).message, true); }
  };
  pi.on('session_start', async (_event, ctx) => {
    service = createService(ctx);
    sessionId = ctx.sessionManager.getSessionId();
    projectRoot = ctx.cwd;
    description = 'Delegate an isolated task. Await background tasks before using their results.';
    await service.start();
    try {
      const tiers = configuredTierNames(ctx.cwd);
      description = ['Delegate an isolated task. Await background tasks with subzero_await before using their results.',
        ...TIER_WORDS.map(({ tier, phrase }) => tiers.includes(tier)
          ? `${phrase} (${tier}): pass model: "${tier}".`
          : `${phrase} (${tier}): not configured, omit model.`),
      ].join('\n');
    } catch { /* The request returns the load error. */ }
    pi.setActiveTools(pi.getActiveTools());
  });
  pi.registerTool({
    name: 'subagent', label: 'Subagent', description,
    executionMode: 'parallel',
    prepareLoadout: () => ({ descriptions: { subagent: description } }),
    parameters: Type.Object({
      task: Type.String(), agent: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      async: Type.Optional(Type.Boolean()), files: Type.Optional(Type.Array(Type.String())),
      expected_output: Type.Optional(Type.String()), worktree: Type.Optional(Type.Boolean()),
      isolation: Type.Optional(Type.String()), context: Type.Optional(Type.String()),
      action: Type.Optional(Type.String()), workflow: Type.Optional(Type.Unknown()),
    }),
    async execute(_id, args, signal, _update, ctx) {
      return respond(async () => {
        const svc = getService();
        const preflight = mapPiRequest(args, [], sessionId);
        if ('error' in preflight) throw new Error(preflight.error);
        const mapped = mapPiRequest(args, configuredTierNames(projectRoot), sessionId);
        if ('error' in mapped) throw new Error(mapped.error);
        const forced = ctx.mode === 'print' || ctx.mode === 'json';
        const wait = forced || args.async === false;
        const reply = await svc.delegate(mapped.delegation, { wait, ...(wait && signal ? { signal } : {}) });
        let text = describe(reply);
        if (mapped.notice) text = withNotice(text, mapped.notice);
        if (forced && args.async === true) text += '\nnotice: this mode waits for the result.';
        return text;
      });
    },
  });
  pi.registerTool({
    name: 'subzero_await', label: 'Await subzero tasks', description: 'Collect task results, waiting up to 600 seconds.',
    parameters: Type.Object({ tasks: Type.Array(Type.String()), timeout_s: Type.Optional(Type.Number()) }),
    async execute(_id, args) {
      return respond(async () => {
        if (args.tasks.length === 0) throw new Error('await needs at least one task id');
        const seconds = args.timeout_s !== undefined && args.timeout_s >= 0 ? Math.min(args.timeout_s, 600) : 30;
        return (await Promise.all(args.tasks.map((id) => getService().waitFor(id, seconds * 1000)))).map(describe).join('\n\n');
      });
    },
  });
  pi.registerTool({
    name: 'subzero_tasks', label: 'Subzero tasks', description: 'List session tasks or inspect a task.',
    parameters: Type.Object({ task: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      return respond(async () => {
        if (args.task) return describe(await getService().collect(args.task));
        const tasks = await getService().list(sessionId);
        return tasks.length ? tasks.map((task) => `${task.taskId} · ${task.agent} · ${listingStatus(task)}`).join('\n') : 'no tasks';
      });
    },
  });
  pi.registerTool({
    name: 'subzero_cancel', label: 'Cancel subzero tasks', description: 'Cancel one task or all tasks in this session.',
    parameters: Type.Object({ task: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      return respond(async () => args.task ? describe(await getService().cancel(args.task)) : `${(await getService().cancelSession(sessionId)).count} tasks cancelled`);
    },
  });
  pi.registerCommand('subzero', {
    description: 'List subzero tasks for this session.',
    async handler(_args, ctx) {
      const tasks = await getService().list(sessionId);
      ctx.ui.notify(tasks.length ? tasks.map((task) => `${task.taskId} · ${task.agent} · ${listingStatus(task)}`).join('\n') : 'no tasks');
    },
  });
}
