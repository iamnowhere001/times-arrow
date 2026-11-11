import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readdirSync } from 'node:fs';

/**
 * D15 设计令牌单一来源 + D14 字号下限。
 *
 * 这两条都不是「好看」问题，而是会漂移的护栏：色值在 @theme 与 :root 各写一份时，
 * 改色漏改一处就是深浅主题不一致；10px 的 EXIF 数字则直接关系到长时间使用是否疲劳。
 * 用静态断言把「改色只需一处」「可读信息 ≥ 12px」钉住，比靠 code review 可靠。
 */

const css = readFileSync(resolve(process.cwd(), 'src/styles/styles.css'), 'utf8');
const themeBlock = css.slice(css.indexOf('@theme {'), css.indexOf('\n}', css.indexOf('@theme {')));
const rootBlock = css.slice(css.indexOf(':root,'), css.indexOf('\n.light-theme {'));

const tokenValue = (block: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}:\\s*([^;]+);`).exec(block);
  return match ? match[1].trim() : null;
};

const hexToRgb = (hex: string): string | null => {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
};

describe('设计令牌单一来源（D15）', () => {
  it('@theme 的 hex 与 rgb 通道值一致', () => {
    const pairs: [string, string, string][] = [
      ['--color-safelight', '--safelight-rgb', '琥珀主色'],
      ['--color-signal-danger', '--signal-danger-rgb', '危险色'],
      ['--color-signal-success', '--signal-success-rgb', '成功色'],
      ['--color-signal-warning', '--signal-warning-rgb', '警告色'],
    ];
    for (const [hexToken, rgbToken, label] of pairs) {
      const hex = tokenValue(themeBlock, hexToken);
      const rgb = tokenValue(themeBlock, rgbToken);
      expect(hex, `${label} 的 hex 应在 @theme 定义`).not.toBeNull();
      expect(rgb, `${label} 的通道值应在 @theme 定义`).not.toBeNull();
      expect(hexToRgb(hex ?? ''), `${label} 的 hex 与通道值不一致`).toBe(rgb);
    }
  });

  it(':root 引用 @theme 的 token，不再手写同一份暗色值', () => {
    expect(rootBlock).toContain('--bg-primary: var(--color-ink-900);');
    expect(rootBlock).toContain('--accent-blue: var(--color-safelight);');
    expect(rootBlock).toContain('--accent-blue-rgb: var(--safelight-rgb);');
    expect(rootBlock).toContain('--accent-pink: var(--color-signal-danger);');
    expect(rootBlock).not.toContain('--bg-primary: #0c0b0a;');
    expect(rootBlock).not.toContain('--accent-blue: #e8a33d;');
    expect(rootBlock).not.toContain('--accent-pink-rgb: 233, 88, 94;');
  });

  it('注释不再宣称「改色时两处同步」', () => {
    expect(css).not.toContain('改色时两处同步');
    expect(css).toContain('唯一来源');
  });
});

describe('字号下限（D14）', () => {
  const tsxFiles: { name: string; source: string }[] = [];
  const collect = (dir: string) => {
    for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) collect(rel);
      else if (entry.name.endsWith('.tsx')) {
        tsxFiles.push({ name: rel, source: readFileSync(resolve(process.cwd(), rel), 'utf8') });
      }
    }
  };
  collect('src/components');

  it('不再有 10px 文本', () => {
    const offenders = tsxFiles.filter((f) => f.source.includes('text-[10px]')).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('EXIF / 计数 / 时间（等宽数字）不再用 11px', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles) {
      for (const line of file.source.split('\n')) {
        if (
          line.includes('text-[11px]') &&
          (line.includes('tabular-nums') ||
            line.includes('font-mono') ||
            line.includes('font-numeric'))
        ) {
          offenders.push(`${file.name}: ${line.trim().slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('弹层基座统一（D17）', () => {
  it('9 个 Modal 全部接入 useModalA11y 并保留 role=dialog / aria-modal', () => {
    const dir = resolve(process.cwd(), 'src/components/modal');
    const files = readdirSync(dir).filter((name) => name.endsWith('.tsx'));
    expect(files).toHaveLength(9);
    for (const name of files) {
      const source = readFileSync(resolve(dir, name), 'utf8');
      expect(source, `${name} 未接入基座`).toContain('useModalA11y(');
      expect(source, `${name} 缺 dialogRef`).toContain('dialogRef');
      expect(source, `${name} 缺 role=dialog`).toContain('role="dialog"');
      expect(source, `${name} 缺 aria-modal`).toContain('aria-modal');
    }
  });
});
