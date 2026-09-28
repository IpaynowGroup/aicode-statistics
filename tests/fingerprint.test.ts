import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint, fingerprintText, multisetDiff, normalizeLine } from '../src/fingerprint.js';

describe('normalizeLine', () => {
  it('去掉首尾空白', () => expect(normalizeLine('  foo();  ')).toBe('foo();'));
  it('空行返回 null', () => expect(normalizeLine('   \t')).toBeNull());
  it('只含括号分号逗号的行返回 null', () => {
    expect(normalizeLine('  });')).toBeNull();
    expect(normalizeLine('} )')).toBeNull();
    expect(normalizeLine('],')).toBeNull();
  });
});

describe('fingerprint', () => {
  it('是归一化内容 sha1 的前 12 位', () => {
    expect(fingerprint(' a ')).toBe(createHash('sha1').update('a').digest('hex').slice(0, 12));
  });
  it('无效行返回 null', () => expect(fingerprint('')).toBeNull());
});

describe('fingerprintText', () => {
  it('按行切分（兼容 CRLF）并跳过无效行', () => {
    expect(fingerprintText('a\n\n}\nb\r\n')).toEqual([fingerprint('a'), fingerprint('b')]);
  });
});

describe('multisetDiff', () => {
  it('按出现次数做差', () => {
    expect(multisetDiff(['x', 'x', 'y'], ['x'])).toEqual(['x', 'y']);
    expect(multisetDiff(['x'], ['x', 'x'])).toEqual([]);
  });
});
