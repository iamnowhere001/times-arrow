import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, resolve } from 'node:path';

/**
 * 文档一致性守卫。
 *
 * agent coding 最容易出的问题不是代码写错，而是「文档说的和代码不一样」：
 * 版本号四处漂移、链接指向已移动的文件、新增模块没进架构图。
 * 这组用例只做机器能可靠判断的事，不评价文风：
 *   1. `package.json` 的版本号与 README / AGENTS / ROADMAP / CHANGELOG 一致；
 *   2. 所有本地 Markdown 链接都能解析到真实文件；
 *   3. 架构文档覆盖 `electron/main` 与 `electron/lib` 的全部模块；
 *   4. 验证入口（`npm run verify`）真实存在。
 *
 * 不检查锚点：中文标题的 slug 规则随渲染器变化，强行校验会制造假失败。
 */
const ROOT = resolve(import.meta.dirname, '../..');
const read = (relative: string) => readFileSync(resolve(ROOT, relative), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  version: string;
  scripts: Record<string, string>;
};

const ROOT_DOCS = [
  'README.md',
  'AGENTS.md',
  'ROADMAP.md',
  'TODO.md',
  'CHANGELOG.md',
  'CODE_REVIEW.md',
];

function walkMarkdown(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, acc);
    else if (extname(entry.name) === '.md') acc.push(full);
  }
  return acc;
}

/** 去掉围栏代码块，避免把示例里的链接当成真链接 */
function stripCodeFences(source: string): string {
  return source.replace(/```[\s\S]*?```/g, '');
}

function localLinks(markdown: string): string[] {
  const links = [...markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim());
  return links.filter((href) => {
    if (!href || href.startsWith('#')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
    return true;
  });
}

describe('文档一致性', () => {
  it('版本号在 README / AGENTS / ROADMAP / CHANGELOG 中一致', () => {
    const currentVersion = pkg.version;
    for (const doc of ['README.md', 'AGENTS.md', 'ROADMAP.md']) {
      const line = read(doc)
        .split('\n')
        .find((text) => text.includes('当前版本') && /\d+\.\d+\.\d+/.test(text));
      expect(line, `${doc} 缺少带版本号的「当前版本」`).toBeTruthy();
      expect(line, `${doc} 的当前版本与 package.json 不一致`).toContain(currentVersion);
    }

    const changelogVersion = read('CHANGELOG.md').match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
    expect(changelogVersion, 'CHANGELOG 缺少首个数字版本节').toBeTruthy();
    expect(changelogVersion, 'CHANGELOG 首个版本节与 package.json 不一致').toBe(currentVersion);
  });

  it('所有本地 Markdown 链接都指向存在的文件', () => {
    const docs = [...ROOT_DOCS, ...walkMarkdown(resolve(ROOT, 'docs'))];
    const broken: string[] = [];

    for (const doc of docs) {
      const relativeDoc = isAbsolute(doc) ? doc.slice(ROOT.length + 1) : doc;
      const source = stripCodeFences(read(relativeDoc));
      for (const href of localLinks(source)) {
        const clean = href.split('#')[0].split('?')[0];
        if (!clean) continue;
        const target = resolve(dirname(doc), decodeURI(clean));
        if (!existsSync(target)) broken.push(`${relativeDoc} → ${href}`);
      }
    }

    expect(broken, `断链：\n${broken.join('\n')}`).toEqual([]);
  });

  it('架构文档覆盖 electron/main 与 electron/lib 的全部模块', () => {
    const architecture = read('docs/architecture.md');
    const modules = [
      ...readdirSync(resolve(ROOT, 'electron/main')).filter((name) => name.endsWith('.cjs')),
      ...readdirSync(resolve(ROOT, 'electron/lib')).filter((name) => name.endsWith('.cjs')),
    ];

    const missing = modules.filter((name) => !architecture.includes(name));
    expect(missing, `docs/architecture.md 未覆盖：${missing.join(', ')}`).toEqual([]);
  });

  it('文档地图覆盖关键文档，且验证入口真实存在', () => {
    const map = read('docs/README.md');
    for (const doc of [
      'architecture.md',
      'quality.md',
      'decisions.md',
      'data-model.md',
      'ipc.md',
      'external.md',
      'archive/todo-completed.md',
    ]) {
      expect(map, `docs/README.md 未引用 ${doc}`).toContain(doc);
    }

    expect(pkg.scripts.verify, 'package.json 缺少 verify 脚本').toBeTruthy();
    expect(pkg.scripts['test:main'], 'package.json 缺少 test:main 脚本').toContain(
      'tests/main-process/run.cjs'
    );
    expect(existsSync(resolve(ROOT, 'tests/main-process/run.cjs'))).toBe(true);
    expect(statSync(resolve(ROOT, 'docs/archive/todo-completed.md')).isFile()).toBe(true);
  });

  /**
   * 分层文档必须自报「最后更新 / 适用版本」。
   * 没有这一行，读者无法判断手上这份文档是描述现在的代码，还是半年前的。
   */
  it('docs/ 每篇分层文档都标注了最后更新与适用版本', () => {
    const layered = [
      'docs/README.md',
      'docs/architecture.md',
      'docs/data-model.md',
      'docs/ipc.md',
      'docs/external.md',
      'docs/quality.md',
      'docs/decisions.md',
    ];
    const missing = layered.filter((doc) => {
      const head = read(doc).slice(0, 600);
      return (
        !/最后更新\*\*：\d{4}-\d{2}-\d{2}/.test(head) || !/适用版本\*\*：\d+\.\d+\.\d+/.test(head)
      );
    });
    expect(missing, `缺少「最后更新 / 适用版本」头：${missing.join(', ')}`).toEqual([]);
  });

  /**
   * 反引号里的仓库内路径必须存在。
   *
   * agent 的导航几乎全靠这类内联路径（`src/lib/fs/pathUtils.ts` 之类），
   * 而原来的守卫只校验 Markdown 链接——文件被移动 / 拆分后此处会静默失效，
   * 表现为「文档指向一个不存在的文件」，比断链更隐蔽。
   *
   * 只检查相对仓库根的写法（白名单首段），跳过通配、目录、命令与别名。
   */
  it('文档中反引号引用的仓库路径都存在', () => {
    const PREFIXES = ['src', 'electron', 'tests', 'docs', 'build'];
    const docs = [...ROOT_DOCS, ...walkMarkdown(resolve(ROOT, 'docs'))];
    const broken: string[] = [];

    for (const doc of docs) {
      const relativeDoc = isAbsolute(doc) ? doc.slice(ROOT.length + 1) : doc;
      const source = stripCodeFences(read(relativeDoc));
      for (const match of source.matchAll(/`([^`\n]+)`/g)) {
        const span = match[1].trim();
        if (!span.includes('/')) continue;
        // 通配、占位符、目录、命令、含空格的说明性文字一律跳过
        if (/[*(){}$<>|?=:,#\s]/.test(span) || span.endsWith('/')) continue;
        if (!PREFIXES.includes(span.split('/')[0])) continue;
        if (!existsSync(resolve(ROOT, span))) broken.push(`${relativeDoc} → ${span}`);
      }
    }

    expect([...new Set(broken)], `反引号路径不存在：\n${[...new Set(broken)].join('\n')}`).toEqual(
      []
    );
  });

  /** 新增 `src/lib/<domain>` 目录却没进架构文档，是 agent 最容易踩的导航空洞。 */
  it('架构文档覆盖 src/lib 的领域目录', () => {
    const architecture = read('docs/architecture.md');
    const domains = readdirSync(resolve(ROOT, 'src/lib'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const missing = domains.filter((name) => !architecture.includes(`${name}/`));
    expect(missing, `docs/architecture.md 未覆盖 src/lib 领域目录：${missing.join(', ')}`).toEqual(
      []
    );
  });
});
