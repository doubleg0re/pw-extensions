// protocol-loader.test.ts — Tests for protocol loading and schema validation
import { describe, it, expect } from 'vitest';
import {
  resolveProtocolPath,
  loadProtocol,
  validateSchema,
  type MessageSchema,
} from '../src/protocol-loader.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// --- resolveProtocolPath ---

describe('resolveProtocolPath', () => {
  it('resolves built-in "monitor" protocol', () => {
    const path = resolveProtocolPath('monitor');
    expect(path).toContain('monitor.json');
  });

  it('throws for unknown protocol name', () => {
    expect(() => resolveProtocolPath('nonexistent-proto')).toThrow('Protocol not found');
  });
});

// --- loadProtocol ---

describe('loadProtocol', () => {
  const tmpDir = join(tmpdir(), `pw-proto-test-${Date.now()}`);

  it('loads built-in monitor protocol', async () => {
    const path = resolveProtocolPath('monitor');
    const proto = await loadProtocol(path);
    expect(proto.def.name).toBe('monitor');
    expect(proto.handlers.has('ping')).toBe(true);
    expect(proto.hooks.onConnect).toBeDefined();
  });

  it('throws on missing name field', async () => {
    mkdirSync(tmpDir, { recursive: true });
    const protoPath = join(tmpDir, 'bad.json');
    writeFileSync(protoPath, '{"inbound":{}}');
    await expect(loadProtocol(protoPath)).rejects.toThrow('must have a "name"');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws on missing handler file', async () => {
    mkdirSync(tmpDir, { recursive: true });
    const protoPath = join(tmpDir, 'missing-handler.json');
    writeFileSync(protoPath, JSON.stringify({
      name: 'test',
      inbound: { foo: { handler: 'does-not-exist.ts' } },
    }));
    await expect(loadProtocol(protoPath)).rejects.toThrow('Handler not found');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// --- validateSchema ---

describe('validateSchema', () => {
  it('passes valid object', () => {
    const schema: MessageSchema = {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
      },
    };
    const { valid, errors } = validateSchema(schema, { text: 'hello' });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('rejects non-object when type is object', () => {
    const schema: MessageSchema = { type: 'object' };
    const { valid, errors } = validateSchema(schema, 'not an object');
    expect(valid).toBe(false);
    expect(errors[0]).toContain('Expected object');
  });

  it('rejects array when type is object', () => {
    const schema: MessageSchema = { type: 'object' };
    const { valid, errors } = validateSchema(schema, [1, 2, 3]);
    expect(valid).toBe(false);
    expect(errors[0]).toContain('Expected object');
  });

  it('rejects missing required field', () => {
    const schema: MessageSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    const { valid, errors } = validateSchema(schema, {});
    expect(valid).toBe(false);
    expect(errors[0]).toContain('Missing required field: "name"');
  });

  it('rejects wrong type', () => {
    const schema: MessageSchema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    };
    const { valid, errors } = validateSchema(schema, { count: 'not a number' });
    expect(valid).toBe(false);
    expect(errors[0]).toContain('expected number');
  });

  it('allows null when type includes null', () => {
    const schema: MessageSchema = {
      type: 'object',
      properties: { value: { type: ['number', 'null'] as any } },
    };
    const { valid } = validateSchema(schema, { value: null });
    expect(valid).toBe(true);
  });

  it('skips undefined fields', () => {
    const schema: MessageSchema = {
      type: 'object',
      properties: { optional: { type: 'string' } },
    };
    const { valid } = validateSchema(schema, {});
    expect(valid).toBe(true);
  });

  it('reports multiple errors', () => {
    const schema: MessageSchema = {
      type: 'object',
      required: ['a', 'b'],
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    };
    const { valid, errors } = validateSchema(schema, {});
    expect(valid).toBe(false);
    expect(errors).toHaveLength(2);
  });
});
