import { describe, it, expect } from 'vitest';
import { joinPath, sanitizeFilename, validateFilename, isReservedName } from '@/lib/fs/pathUtils';

/**
 * P1-9 / P1-10 的验收测试。
 *
 * 这里有一条贯穿全篇的核心不变式：
 *   validateFilename(name).ok === true  ⟹  sanitizeFilename(name) === name
 * 也就是「校验通过的名字，规范化后原样不变」。它保证了 UI 预览与磁盘结果不会漂移 ——
 * 改造前 sanitizeFilename 静默剔除非法字符、RenameModal 却自带一份正则报错拒绝，
 * 同一份名字在预览里合法、落盘时却被改掉。
 */

/** 跨平台/跨文件系统都不会接受的字符 */
const ILLEGAL = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

describe('sanitizeFilename', () => {
  it('替换所有非法字符而不是删除（删除会让 a:b 和 ab 撞名）', () => {
    expect(sanitizeFilename('a:b')).toBe('a-b');
    expect(sanitizeFilename('a<b>c')).toBe('a-b-c');
  });

  it('折叠连续连字符，不留首尾连字符', () => {
    expect(sanitizeFilename('a::b')).toBe('a-b');
    expect(sanitizeFilename(':abc:')).toBe('abc');
  });

  it('剔除控制字符', () => {
    expect(sanitizeFilename('a\u0000b\u001fc')).toBe('a-b-c');
    expect(sanitizeFilename('a\u007fb')).toBe('a-b');
  });

  it('Windows 不允许以点或空格结尾', () => {
    expect(sanitizeFilename('report.')).toBe('report');
    expect(sanitizeFilename('report ')).toBe('report');
    expect(sanitizeFilename('report... ')).toBe('report');
  });

  it('保留设备名被破掉（含带扩展名的情况）', () => {
    expect(isReservedName('con')).toBe(true);
    expect(isReservedName('CON')).toBe(true);
    expect(isReservedName('con.txt')).toBe(true);
    expect(isReservedName('com1')).toBe(true);
    expect(isReservedName('console')).toBe(false);
    expect(sanitizeFilename('con')).toBe('con_');
    expect(sanitizeFilename('con.txt')).toBe('con_.txt');
  });

  it('过长时截断主名但保留扩展名', () => {
    const long = 'a'.repeat(400) + '.jpg';
    const out = sanitizeFilename(long);
    expect(out.endsWith('.jpg')).toBe(true);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(255);
  });

  it('中文长名按字节截断（一个字 3 字节，不能按字符数切）', () => {
    const long = '照'.repeat(200) + '.jpg';
    const out = sanitizeFilename(long);
    expect(out.endsWith('.jpg')).toBe(true);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(255);
  });

  it('全部被剔掉时兜底为确定的名字，绝不返回空串', () => {
    expect(sanitizeFilename('')).toBe('untitled');
    expect(sanitizeFilename('...')).toBe('untitled');
    expect(sanitizeFilename('???')).toBe('untitled');
    expect(sanitizeFilename('/')).toBe('untitled');
  });

  it('合法名字原样返回（不误伤中文、空格、括号、表情）', () => {
    for (const name of ['照片 001.jpg', 'IMG_2639.HEIC', 'a (1) - 副本.png', '🎉party.mp4']) {
      expect(sanitizeFilename(name)).toBe(name);
    }
  });
});

describe('validateFilename', () => {
  it('拒绝空名与点目录', () => {
    expect(validateFilename('').ok).toBe(false);
    expect(validateFilename('.').ok).toBe(false);
    expect(validateFilename('..').ok).toBe(false);
  });

  it('拒绝每一个非法字符', () => {
    for (const ch of ILLEGAL) {
      const verdict = validateFilename(`a${ch}b`);
      expect(verdict.ok, `字符 ${ch} 应当被拒绝`).toBe(false);
    }
  });

  it('拒绝保留设备名', () => {
    expect(validateFilename('CON').ok).toBe(false);
    expect(validateFilename('lpt3.jpg').ok).toBe(false);
  });

  it('拒绝以点或空格结尾', () => {
    expect(validateFilename('report.').ok).toBe(false);
    expect(validateFilename('report ').ok).toBe(false);
  });

  it('拒绝超长名字', () => {
    expect(validateFilename('a'.repeat(300)).ok).toBe(false);
  });

  it('失败时一定给出可展示的理由', () => {
    for (const bad of ['', '.', 'a/b', 'CON', 'x.', 'a'.repeat(300)]) {
      const verdict = validateFilename(bad);
      if (!verdict.ok) {
        expect(typeof verdict.reason).toBe('string');
        expect(verdict.reason.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('核心不变式：校验通过 ⟹ 规范化后不变', () => {
  const cases = [
    '照片 001.jpg',
    'IMG_2639.HEIC',
    'a (1) - 副本.png',
    '🎉party.mp4',
    'report',
    'a-b',
    '中文名',
    'mixed 中英文 name.jpeg',
    'x'.repeat(200) + '.jpg',
  ];

  it.each(cases)('「%s」通过校验时 sanitize 是恒等变换', (name) => {
    if (validateFilename(name).ok) {
      expect(sanitizeFilename(name)).toBe(name);
    }
  });

  it('反向也成立：被 sanitize 改动的名字，validate 必定不通过', () => {
    const dirty = ['a:b', 'a/b', 'CON', 'report.', 'a\u0000b', '???', ''];
    for (const name of dirty) {
      const sanitized = sanitizeFilename(name);
      if (sanitized !== name) {
        expect(validateFilename(name).ok, `「${name}」被改动了却没被校验拦下`).toBe(false);
      }
    }
  });
});

describe('joinPath（对齐 node:path.join 语义）', () => {
  it('基本拼接', () => {
    expect(joinPath('/a/b', 'c.jpg')).toBe('/a/b/c.jpg');
    expect(joinPath('/a/b/', 'c.jpg')).toBe('/a/b/c.jpg');
    expect(joinPath('/a/b///', 'c.jpg')).toBe('/a/b/c.jpg');
  });

  it('目录为空时不再产出以分隔符开头的错误路径', () => {
    // 旧实现是 `${dirPath}/${filename}`，空目录会得到 '/c.jpg'
    expect(joinPath('', 'c.jpg')).toBe('c.jpg');
  });

  it('文件名以分隔符开头时折叠多余的斜杠', () => {
    expect(joinPath('/a', '/c.jpg')).toBe('/a/c.jpg');
  });

  it('折叠 . 与 .. 段', () => {
    expect(joinPath('/a/./b', 'c')).toBe('/a/b/c');
    expect(joinPath('/a/x/../b', 'c')).toBe('/a/b/c');
    expect(joinPath('/a', '../c')).toBe('/c');
  });

  it('保留根目录语义', () => {
    expect(joinPath('/', 'c.jpg')).toBe('/c.jpg');
    expect(joinPath('/', '')).toBe('/');
  });

  it('空输入返回 . （与 node:path.join 一致）', () => {
    expect(joinPath('', '')).toBe('.');
  });

  it('Windows 路径保持反斜杠', () => {
    expect(joinPath('C:\\Users\\me', 'c.jpg')).toBe('C:\\Users\\me\\c.jpg');
    expect(joinPath('C:\\', 'c.jpg')).toBe('C:\\c.jpg');
    expect(joinPath('C:\\a', '..\\b')).toBe('C:\\b');
  });

  it('POSIX 下反斜杠是合法文件名字符，不能被当成 Windows 路径', () => {
    // 旧实现用 dirPath.includes('\\') 猜平台，会把这个目录误判成 Windows
    expect(joinPath('/Users/me/a\\b', 'c.jpg')).toBe('/Users/me/a\\b/c.jpg');
  });
});
