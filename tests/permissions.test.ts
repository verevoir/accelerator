import { describe, it, expect } from 'vitest';
import { registerSourceTools } from '../src/tools/source.js';
import { registerWorkflowTools } from '../src/tools/workflow.js';
import { createServer } from '../src/index.js';
import {
  TOOL_CLASSES,
  TOOL_CLASS_NAMES,
  resolveScope,
  scopeFromEnv,
  withScope,
  gateNativeToolCall,
  toolClass,
  type ToolHost,
} from '../src/permissions.js';

/** Drive both registration functions through a mock host, capturing each tool's
 * name and declared config — the same seam the MCP server and pi plugin use. */
function registeredConfigs(
  host?: ToolHost
): Record<string, { annotations?: Record<string, boolean> }> {
  const captured: Record<string, { annotations?: Record<string, boolean> }> = {};
  const recorder = {
    registerTool: (name: string, config: { annotations?: Record<string, boolean> }) => {
      captured[name] = config;
      return {} as unknown;
    },
  } as unknown as ToolHost;
  const target = host ?? recorder;
  registerSourceTools(target);
  registerWorkflowTools(target);
  return captured;
}

/** Record only the names a host registers. */
function recordingHost(): { host: ToolHost; names: string[] } {
  const names: string[] = [];
  const host = {
    registerTool: (name: string) => {
      names.push(name);
      return {} as unknown;
    },
  } as unknown as ToolHost;
  return { host, names };
}

describe('tool class taxonomy', () => {
  const tools = registeredConfigs();

  it('maps every registered tool to exactly one class — the taxonomy is total', () => {
    expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_CLASSES).sort());
  });

  it('classifies the read class as exactly the readOnlyHint tools', () => {
    for (const [name, config] of Object.entries(tools)) {
      const isReadOnly = config.annotations?.readOnlyHint === true;
      expect(toolClass(name) === 'read').toBe(isReadOnly);
    }
  });

  it('assigns every class a name in TOOL_CLASS_NAMES', () => {
    for (const cls of Object.values(TOOL_CLASSES)) {
      expect(TOOL_CLASS_NAMES).toContain(cls);
    }
  });
});

describe('resolveScope', () => {
  it('defaults to the read class when unset', () => {
    const scope = resolveScope(undefined);
    expect([...scope.classes]).toEqual(['read']);
    expect(scope.tools.has('read_file')).toBe(true);
    expect(scope.tools.has('write_file')).toBe(false);
    expect(scope.warnings).toEqual([]);
  });

  it('defaults to the read class when empty or whitespace', () => {
    expect([...resolveScope('').classes]).toEqual(['read']);
    expect([...resolveScope('   ,  ').classes]).toEqual(['read']);
  });

  it('expands a named class to all its tools and grants the class', () => {
    const scope = resolveScope('write-github');
    expect([...scope.classes]).toEqual(['write-github']);
    expect(scope.tools).toEqual(
      new Set(['commit_files', 'ensure_fork', 'ensure_branch', 'open_pull_request'])
    );
  });

  it('accepts several comma-separated classes', () => {
    const scope = resolveScope('read, cards-write');
    expect(scope.classes).toEqual(new Set(['read', 'cards-write']));
    expect(scope.tools.has('read_file')).toBe(true);
    expect(scope.tools.has('create_card')).toBe(true);
    expect(scope.tools.has('write_file')).toBe(false);
  });

  it('grants an explicit tool name without widening the native class', () => {
    const scope = resolveScope('write_file');
    expect(scope.tools).toEqual(new Set(['write_file']));
    expect(scope.classes.size).toBe(0);
  });

  it('ignores an unknown entry with a warning', () => {
    const scope = resolveScope('read, nope, write-sideways');
    expect([...scope.classes]).toEqual(['read']);
    expect(scope.warnings).toHaveLength(2);
    expect(scope.warnings[0]).toContain('nope');
  });

  it('reads ACCELERATOR_TOOLS from the environment', () => {
    expect([...scopeFromEnv({ ACCELERATOR_TOOLS: 'cards-write' }).classes]).toEqual([
      'cards-write',
    ]);
    expect([...scopeFromEnv({}).classes]).toEqual(['read']);
  });
});

describe('withScope registration gating', () => {
  it('registers only the read tools under the default scope', () => {
    const { host, names } = recordingHost();
    registeredConfigs(withScope(host, resolveScope(undefined)));
    const readTools = Object.entries(TOOL_CLASSES)
      .filter(([, cls]) => cls === 'read')
      .map(([name]) => name);
    expect(names.sort()).toEqual(readTools.sort());
  });

  it('registers exactly a named class', () => {
    const { host, names } = recordingHost();
    registeredConfigs(withScope(host, resolveScope('cards-write')));
    expect(names.sort()).toEqual(['add_comment', 'create_card', 'move_card', 'update_card']);
  });

  it('registers exactly the explicitly named tools', () => {
    const { host, names } = recordingHost();
    registeredConfigs(withScope(host, resolveScope('read_file, open_pull_request')));
    expect(names.sort()).toEqual(['open_pull_request', 'read_file']);
  });

  it('registers nothing for a scope of only unknown names (fail-closed)', () => {
    const { host, names } = recordingHost();
    // An all-unknown spec still defaults to nothing granted except the warning —
    // resolve('bogus') yields an empty tool set, so no tool is registered.
    registeredConfigs(withScope(host, resolveScope('bogus-only')));
    expect(names).toEqual([]);
  });
});

describe('gateNativeToolCall', () => {
  const read = resolveScope('read');
  const local = resolveScope('write-local');

  it('allows an in-scope native read', () => {
    expect(gateNativeToolCall('read', read)).toBeUndefined();
    expect(gateNativeToolCall('grep', read)).toBeUndefined();
  });

  it('blocks an out-of-scope native write or bash under a read scope', () => {
    expect(gateNativeToolCall('write', read)).toMatchObject({ block: true });
    expect(gateNativeToolCall('bash', read)).toMatchObject({ block: true });
    expect(gateNativeToolCall('edit', read)?.reason).toContain('write-local');
  });

  it('allows native write and bash once write-local is granted', () => {
    expect(gateNativeToolCall('write', local)).toBeUndefined();
    expect(gateNativeToolCall('bash', local)).toBeUndefined();
    // A read under write-local is still blocked — the scope grants only write-local.
    expect(gateNativeToolCall('read', local)).toMatchObject({ block: true });
  });

  it('blocks an unclassified native tool (fail-closed)', () => {
    const decision = gateNativeToolCall('exfiltrate', resolveScope('write-local'));
    expect(decision).toMatchObject({ block: true });
    expect(decision?.reason).toContain('exfiltrate');
  });

  it('lets an in-scope accelerator tool through the gate (pi fires tool_call for every tool)', () => {
    // These are accelerator tools, not pi natives — the gate must not re-block
    // what `withScope` already admitted, else native governance breaks the plugin.
    expect(gateNativeToolCall('read_file', read)).toBeUndefined();
    expect(gateNativeToolCall('list_cards', read)).toBeUndefined();
    expect(gateNativeToolCall('write_file', local)).toBeUndefined();
  });

  it('blocks an accelerator tool the scope did NOT admit', () => {
    // write_file is out of scope under read-only, so it is never registered and
    // must not slip through the native gate either.
    expect(gateNativeToolCall('write_file', read)).toMatchObject({ block: true });
  });
});

describe('MCP path unchanged', () => {
  it('createServer still registers every tool', async () => {
    const server = await createServer();
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registered).sort()).toEqual(Object.keys(TOOL_CLASSES).sort());
  });
});
