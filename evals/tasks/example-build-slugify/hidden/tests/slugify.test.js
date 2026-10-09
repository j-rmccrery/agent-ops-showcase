const { slugify } = require('../src/utils/slugify');

test('lowercases and hyphenates', () => {
  expect(slugify('Hello, World!')).toBe('hello-world');
});

test('collapses runs and trims edges', () => {
  expect(slugify('  --A   b__c--  ')).toBe('a-b-c');
});

test('empty string', () => {
  expect(slugify('')).toBe('');
});
