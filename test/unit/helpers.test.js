const assert = require('assert');
const { fmt12, canonicalLocal } = require('../../src/views/helpers');

console.log('Running helpers unit tests...');

// canonicalLocal should round-trip a canonical string
assert.strictEqual(canonicalLocal('2025-10-06 09:05'), '2025-10-06 09:05', 'canonicalLocal should return same canonical string');

// canonicalLocal should pad numbers correctly
assert.strictEqual(canonicalLocal('2025-01-05 03:02'), '2025-01-05 03:02', 'canonicalLocal should preserve padded input');

// canonicalLocal with falsy input returns empty string
assert.strictEqual(canonicalLocal(null), '', 'canonicalLocal(null) should be empty string');
assert.strictEqual(canonicalLocal(''), '', 'canonicalLocal("") should be empty string');

// fmt12 should return an empty string for null/empty
assert.strictEqual(fmt12(null), '', 'fmt12(null) should be empty string');
assert.strictEqual(fmt12(''), '', 'fmt12("") should be empty string');

// fmt12 should produce a human-friendly string for a valid canonical input
const human = fmt12('2025-10-06 09:05');
assert.strictEqual(typeof human, 'string');
assert.ok(human.length > 0, 'fmt12 should return non-empty string for valid date');

console.log('All helpers tests passed.');
