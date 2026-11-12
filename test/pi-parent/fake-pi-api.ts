import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';

/** The extension-facing surface needed to exercise a session without pi's UI. */
export function fakePi(root: string, mode: 'tui' | 'rpc' | 'json' | 'print' = 'tui') {
  const tools = new Map<string, ToolDefinition<any, any>>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, unknown>();
  const messages: unknown[] = [];
  const context = {
    cwd: root, mode, hasUI: mode === 'tui', sessionManager: { getSessionId: () => 'pi-session' },
    ui: { notify: () => {}, setWidget: () => {} },
  } as unknown as ExtensionContext;
  const api = {
    registerTool: (tool: ToolDefinition<any, any>) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => { handlers.set(event, handler); return () => handlers.delete(event); },
    sendMessage: (...args: unknown[]) => messages.push(args),
    getAllTools: () => [], getCommands: () => [], getActiveTools: () => [...tools.keys()], setActiveTools: () => {},
  } as unknown as ExtensionAPI;
  return { api, context, tools, commands, messages, emit: async (event: string, data: unknown = {}) => handlers.get(event)?.(data, context) };
}
