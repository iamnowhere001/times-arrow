import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 侧栏信息架构护栏（P2 · 2026-11-20）。
 *
 * ROADMAP §1.1 点名批评旧侧栏按「实现模块」组织（视图 / 应用 / 图库与媒体类型 /
 * 个人整理与来源），新用户难以建立心智模型。重组为按用户任务命名的四组，
 * 并按使用频率排序。这里静态锁住分组名与顺序，防止日后又滑回模块命名。
 */
const source = readFileSync(resolve(process.cwd(), 'src/components/layout/Sidebar.tsx'), 'utf8');

describe('侧栏信息架构（静态断言）', () => {
  const groups = [...source.matchAll(/<section aria-label="([^"]+)"/g)].map((m) => m[1]);

  it('四组按用户任务命名，且按使用频率排序', () => {
    expect(groups).toEqual(['浏览', '回顾', '整理', '帮助']);
  });

  it('不再使用按实现模块命名的旧组名', () => {
    for (const stale of ['视图', '应用', '图库与媒体类型', '个人整理与来源']) {
      expect(source).not.toContain(`aria-label="${stale}"`);
    }
  });

  it('每个分段标题都有 tooltip 说明其作用', () => {
    expect(source).toContain('title="按全部 / 收藏 / 隐藏浏览照片"');
    expect(source).toContain('title="按时间线、地图、人物或相似度重新查看照片"');
    expect(source).toContain('title="按自己的规则把照片归组"');
    expect(source).toContain('title="快捷键、功能介绍与版本更新"');
  });

  it('「帮助」组收拢快捷键与关于入口（2026-11-21 从底栏上收）', () => {
    const help = source.slice(source.indexOf('aria-label="帮助"'));
    expect(help).toContain('键盘快捷键');
    expect(help).toContain('onOpenShortcuts');
    expect(help).toContain('onOpenAbout');
  });

  it('「清空列表」是带文字的入口，落在「整理」组而不是底栏图标', () => {
    const organize = source.slice(
      source.indexOf('aria-label="整理"'),
      source.indexOf('aria-label="帮助"')
    );
    expect(organize).toContain('onRequestReset');
    expect(organize).toContain('清空列表');
    // 底栏（</nav> 之后）只剩外观切换：这两个能力不应再出现在那里
    const footer = source.slice(source.lastIndexOf('</nav>'));
    expect(footer).not.toContain('onRequestReset');
    expect(footer).not.toContain('onOpenShortcuts');
  });

  it('重组不删入口：整页视图、筛选分类与标签仍然可达', () => {
    for (const prop of [
      'onSelectTimeline',
      'onSelectMap',
      'onCheckDuplicates',
      'onOpenAbout',
      'onSelectNav',
      'onSelectTag',
    ]) {
      expect(source).toContain(prop);
    }
  });
});
