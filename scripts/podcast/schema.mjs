import { readFileSync } from 'node:fs';

// The schemas deliberately use this small, dependency-free JSON Schema subset.
// Unknown keywords fail closed so schema changes cannot silently weaken checks.
export function validateSchema(value, schema, root = schema, path = '$') {
  const known = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'enum']);
  for (const key of Object.keys(schema)) if (!known.has(key)) throw new Error(`Unsupported schema keyword ${key}`);
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/$defs/')) throw new Error('Only local $defs references supported');
    const target = root.$defs[schema.$ref.slice(8)];
    if (!target) throw new Error(`Unknown schema reference ${schema.$ref}`);
    return validateSchema(value, target, root, path);
  }
  const fail = message => { throw new Error(`${path}: ${message}`); };
  const matches = t => t === 'array' ? Array.isArray(value) : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : t === 'integer' ? Number.isInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === t;
  if (schema.type && !matches(schema.type)) fail(`expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) fail('not an allowed value');
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('too long');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail('invalid format');
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('below minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('above maximum');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('too few items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('too many items');
    if (schema.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) fail('duplicate items');
    if (schema.items) value.forEach((x, i) => validateSchema(x, schema.items, root, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) if (!(key in value)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateSchema(item, schema.properties[key], root, `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`unexpected property ${key}`);
    }
  }
}

export function check(value, name) {
  const schema = JSON.parse(readFileSync(new URL(`../../podcast/schemas/${name}.schema.json`, import.meta.url)));
  validateSchema(value, schema);
}
