import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import installAcceleratorPlugin, {
  buildPiHost,
  governNative,
  type PiExtensionAPI,
  type PiToolCallEvent,
  type PiToolCallEventResult,
  type PiToolDefinition,
  type PiExtensionContext,
} from '../src/pi.js';
import { TOOL_CLASSES } from '../src/permissions.js';

type ToolCallHandler = (
  event: PiToolCallEvent,
  ctx: PiExtensionContext
) => PiToolCallEventResult | void | Promise<PiToolCallEventResult | void>;

/** A mock pi ExtensionAPI that records registered tools and the tool_call
 * handler, so the plugin's wiring can be asserted without a real pi. */
function mockPi(): {
  pi: PiExtensionAPI;
  tools: PiToolDefinition[];
  getHandler: () => ToolCallHandler | undefined;
} {
  const tools: PiToolDefinition[] = [];
  let handler: ToolCallHandler | undefined;
  const pi: PiExtensionAPI = {
    registerTool(tool) {
      tools.push(tool);
    },
    on(_event, h) {
      handler = h;
    },
  };
  return { pi, tools, getHandler: () => handler };
}

const readToolNames = Object.entries(TOOL_CLASSES)
  .filter(([, cls]) => cls === 'read')
  .map(([name]) => name);

describe('buildPiHost', () => {
  it('maps an MCP tool registration onto a pi ToolDefinition', () => {
    const { pi, tools } = mockPi();
    const host = buildPiHost(pi);
    host.registerTool(
      'demo',
      { description: 'A demo tool that echoes its input.', inputSchema: { a: z.string() } },
      async () => ({ content: [{ type: 'text', text: 'ignored' }] })
    );

    expect(tools).toHaveLength(1);
    const def = tools[0];
    expect(def.name).toBe('demo');
    expect(def.label).toBe('demo');
    expect(def.description).toBe('A demo tool that echoes its input.');
    const params = def.parameters as { type?: string; properties?: Record<string, unknown> };
    expect(params.type).toBe('object');
    expect(params.properties).toHaveProperty('a');
  });

  it('runs the underlying handler and maps its content back through execute', async () => {
    const { pi, tools } = mockPi();
    const host = buildPiHost(pi);
    host.registerTool(
      'echo',
      { description: 'echo', inputSchema: { a: z.string() } },
      async (args) => ({ content: [{ type: 'text', text: `hi ${args.a}` }] })
    );

    const result = await tools[0].execute('call-1', { a: 'world' });
    expect(result.content).toEqual([{ type: 'text', text: 'hi world' }]);
  });

  it('gives a schemaless tool an open object parameter schema', () => {
    const { pi, tools } = mockPi();
    buildPiHost(pi).registerTool('noargs', { description: 'no args' }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
    expect((tools[0].parameters as { type?: string }).type).toBe('object');
  });
});

describe('governNative', () => {
  it('is off by default and for falsy values', () => {
    expect(governNative({})).toBe(false);
    expect(governNative({ ACCELERATOR_GOVERN_NATIVE: '0' })).toBe(false);
    expect(governNative({ ACCELERATOR_GOVERN_NATIVE: 'false' })).toBe(false);
  });

  it('is on for truthy values', () => {
    for (const value of ['1', 'true', 'on', 'yes', 'TRUE']) {
      expect(governNative({ ACCELERATOR_GOVERN_NATIVE: value })).toBe(true);
    }
  });
});

describe('installAcceleratorPlugin', () => {
  let saved: { tools?: string; govern?: string };

  beforeEach(() => {
    saved = {
      tools: process.env.ACCELERATOR_TOOLS,
      govern: process.env.ACCELERATOR_GOVERN_NATIVE,
    };
    delete process.env.ACCELERATOR_TOOLS;
    delete process.env.ACCELERATOR_GOVERN_NATIVE;
  });

  afterEach(() => {
    if (saved.tools === undefined) delete process.env.ACCELERATOR_TOOLS;
    else process.env.ACCELERATOR_TOOLS = saved.tools;
    if (saved.govern === undefined) delete process.env.ACCELERATOR_GOVERN_NATIVE;
    else process.env.ACCELERATOR_GOVERN_NATIVE = saved.govern;
  });

  it('registers only the read tools under the default scope', () => {
    const { pi, tools, getHandler } = mockPi();
    installAcceleratorPlugin(pi);
    expect(tools.map((t) => t.name).sort()).toEqual([...readToolNames].sort());
    expect(getHandler()).toBeUndefined();
  });

  it('registers the write-local tools when scoped to that class', () => {
    process.env.ACCELERATOR_TOOLS = 'write-local';
    const { pi, tools } = mockPi();
    installAcceleratorPlugin(pi);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'delete_block',
      'edit_file',
      'insert',
      'multi_edit',
      'write_file',
    ]);
  });

  it('installs no native gate when governance is off', () => {
    process.env.ACCELERATOR_GOVERN_NATIVE = '0';
    const { pi, getHandler } = mockPi();
    installAcceleratorPlugin(pi);
    expect(getHandler()).toBeUndefined();
  });

  it('installs a native gate that blocks out-of-scope calls and allows reads when governance is on', async () => {
    process.env.ACCELERATOR_TOOLS = 'read';
    process.env.ACCELERATOR_GOVERN_NATIVE = '1';
    const { pi, getHandler } = mockPi();
    installAcceleratorPlugin(pi);

    const handler = getHandler();
    expect(handler).toBeDefined();
    const ctx: PiExtensionContext = { hasUI: false };
    expect(
      await handler!({ type: 'tool_call', toolCallId: '1', toolName: 'bash', input: {} }, ctx)
    ).toMatchObject({
      block: true,
    });
    expect(
      await handler!({ type: 'tool_call', toolCallId: '2', toolName: 'write', input: {} }, ctx)
    ).toMatchObject({
      block: true,
    });
    expect(
      await handler!({ type: 'tool_call', toolCallId: '3', toolName: 'read', input: {} }, ctx)
    ).toBeUndefined();
  });
});
