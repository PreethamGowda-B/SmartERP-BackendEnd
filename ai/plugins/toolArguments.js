'use strict';

const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_STRING_LENGTH = 8000;
const MAX_ARRAY_LENGTH = 100;
const MAX_DEPTH = 8;
const MAX_NODES = 256;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(path, reason) {
  const error = new Error(`Invalid AI tool arguments at ${path}: ${reason}`);
  error.code = 'AI_TOOL_ARGUMENTS_INVALID';
  error.statusCode = 400;
  return error;
}

function assertBoundedJson(value, { path = 'arguments', depth = 0, counter = { nodes: 0 } } = {}) {
  counter.nodes += 1;
  if (counter.nodes > MAX_NODES) throw invalid(path, 'too many values');
  if (depth > MAX_DEPTH) throw invalid(path, 'nesting is too deep');
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw invalid(path, 'string is too long');
    return;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw invalid(path, 'number must be finite');
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw invalid(path, 'array is too large');
    value.forEach((item, index) => assertBoundedJson(item, { path: `${path}[${index}]`, depth: depth + 1, counter }));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) throw invalid(`${path}.${key}`, 'property name is not allowed');
      assertBoundedJson(child, { path: `${path}.${key}`, depth: depth + 1, counter });
    }
  }
}

function matchesType(value, type) {
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function validateSchema(value, schema, path = 'arguments') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !matchesType(value, schema.type)) throw invalid(path, `expected ${schema.type}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) throw invalid(path, 'value is not an allowed option');

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) throw invalid(path, 'value is too short');
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) throw invalid(path, 'value is too long');
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) throw invalid(path, 'value is below the minimum');
    if (Number.isFinite(schema.maximum) && value > schema.maximum) throw invalid(path, 'value exceeds the maximum');
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw invalid(path, 'array is too large');
    if (schema.items) value.forEach((entry, index) => validateSchema(entry, schema.items, `${path}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) throw invalid(path, `missing required field '${key}'`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) throw invalid(`${path}.${key}`, 'unknown field');
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateSchema(value[key], childSchema, `${path}.${key}`);
    }
  }
}

function validateToolArguments(value, schema) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('arguments', 'expected an object');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw invalid('arguments', 'could not be serialized'); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_BYTES) throw invalid('arguments', 'payload exceeds the supported size');
  assertBoundedJson(value);
  validateSchema(value, schema || { type: 'object' });
  return value;
}

module.exports = { MAX_ARGUMENT_BYTES, MAX_STRING_LENGTH, MAX_ARRAY_LENGTH, MAX_DEPTH, MAX_NODES, validateToolArguments };
