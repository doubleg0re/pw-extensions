// protocol-loader.ts — Parse protocol JSON, load handlers, validate schemas
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
// --- Protocol resolution ---
const BUILT_IN_DIR = join(import.meta.dirname || __dirname, '..', 'protocols');
export function resolveProtocolPath(nameOrPath) {
    // File path
    if (existsSync(nameOrPath))
        return resolve(nameOrPath);
    // Built-in name
    const builtIn = join(BUILT_IN_DIR, `${nameOrPath}.json`);
    if (existsSync(builtIn))
        return builtIn;
    throw new Error(`Protocol not found: "${nameOrPath}" (checked file path and built-in protocols)`);
}
// --- Protocol loading ---
export async function loadProtocol(protocolPath) {
    const raw = JSON.parse(readFileSync(protocolPath, 'utf-8'));
    const def = raw;
    const baseDir = dirname(protocolPath);
    if (!def.name)
        throw new Error('Protocol must have a "name" field');
    // Load inbound handlers
    const handlers = new Map();
    if (def.inbound) {
        for (const [msgType, inDef] of Object.entries(def.inbound)) {
            const handlerPath = resolve(baseDir, inDef.handler);
            if (!existsSync(handlerPath)) {
                throw new Error(`Handler not found for "${msgType}": ${handlerPath}`);
            }
            const mod = await import(pathToFileURL(handlerPath).href);
            const fn = mod.default || mod.handler;
            if (typeof fn !== 'function') {
                throw new Error(`Handler for "${msgType}" must export a default function`);
            }
            handlers.set(msgType, { fn, schema: inDef.schema });
        }
    }
    // Load lifecycle hooks
    const hooks = {};
    if (def.hooks?.onConnect) {
        const hookPath = resolve(baseDir, def.hooks.onConnect);
        if (existsSync(hookPath)) {
            const mod = await import(pathToFileURL(hookPath).href);
            hooks.onConnect = mod.default || mod.onConnect;
        }
    }
    if (def.hooks?.onDisconnect) {
        const hookPath = resolve(baseDir, def.hooks.onDisconnect);
        if (existsSync(hookPath)) {
            const mod = await import(pathToFileURL(hookPath).href);
            hooks.onDisconnect = mod.default || mod.onDisconnect;
        }
    }
    return { def, handlers, hooks, baseDir };
}
// --- Schema validation (lightweight JSON Schema subset) ---
export function validateSchema(schema, data) {
    const errors = [];
    if (schema.type === 'object' && (typeof data !== 'object' || data === null || Array.isArray(data))) {
        errors.push(`Expected object, got ${Array.isArray(data) ? 'array' : typeof data}`);
        return { valid: false, errors };
    }
    // Check required fields
    if (schema.required && Array.isArray(schema.required)) {
        for (const field of schema.required) {
            if (data[field] === undefined || data[field] === null) {
                errors.push(`Missing required field: "${field}"`);
            }
        }
    }
    // Check property types
    if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties)) {
            if (data[key] === undefined)
                continue;
            const val = data[key];
            const allowedTypes = Array.isArray(prop.type) ? prop.type : [prop.type];
            const actualType = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
            if (!allowedTypes.includes(actualType)) {
                errors.push(`Field "${key}": expected ${allowedTypes.join('|')}, got ${actualType}`);
            }
        }
    }
    return { valid: errors.length === 0, errors };
}
