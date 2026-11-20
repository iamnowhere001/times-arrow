import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * dev server 监听面守卫。
 *
 * 为什么需要它：`server.host` 曾被设成 `0.0.0.0` + `allowedHosts: true`，
 * 而 CODE_REVIEW §0.1 与完成存档都声称「已改回 127.0.0.1」—— 文档与代码分裂了
 * 整整一个版本周期，没有任何测试发现。这类偏差不是写错代码，而是**承诺失效**：
 * 产品的「纯本地」定位依赖它。
 *
 * 顺带钉住第二条同类口头约定：`electron:dev` 的启动 URL 端口必须与
 * `vite.config.mts` 的 `server.port` 一致（改一处会白屏，文档反复强调但无守卫）。
 */

const ROOT = resolve(import.meta.dirname, '../..');
const config = readFileSync(resolve(ROOT, 'vite.config.mts'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function serverBlock(): string {
  const start = config.indexOf('server: {');
  expect(start, 'vite.config.mts 缺少 server 配置块').toBeGreaterThan(-1);
  const end = config.indexOf('\n  },', start);
  expect(end, 'vite.config.mts 的 server 块结构变化，守卫需要更新').toBeGreaterThan(start);
  // 去掉行注释：注释里解释「曾被设成 0.0.0.0」的文字不应该被当成真实配置
  return config.slice(start, end).replace(/\/\/[^\n]*/g, '');
}

describe('dev server 只监听回环地址', () => {
  it('host 是 127.0.0.1，不是 0.0.0.0 / ::', () => {
    const host = /host:\s*'([^']+)'/.exec(serverBlock())?.[1];
    expect(host, 'server.host 未显式设置回环地址').toBe('127.0.0.1');
    // 反向断言：任何「监听所有网卡」的写法都失败，避免换个写法绕过
    expect(serverBlock()).not.toMatch(/host:\s*'(0\.0\.0\.0|::|::0)'/);
    expect(serverBlock()).not.toMatch(/host:\s*true/);
  });

  it('未关闭 Host 头校验', () => {
    // allowedHosts: true 会让 dev server 接受任意 Host，配合 DNS rebinding 可被跨站读取
    expect(serverBlock()).not.toMatch(/allowedHosts:\s*true/);
  });
});

describe('端口两处必须一致', () => {
  it('vite server.port 与 electron:dev 的 ELECTRON_START_URL 端口相同', () => {
    const port = /port:\s*(\d+)/.exec(serverBlock())?.[1];
    expect(port, 'server.port 缺失').toBeTruthy();

    const devScript = pkg.scripts['electron:dev'] ?? '';
    const startUrl = /ELECTRON_START_URL=(\S+)/.exec(devScript)?.[1];
    expect(startUrl, 'electron:dev 未设置 ELECTRON_START_URL').toBeTruthy();

    const urlPort = new URL(startUrl as string).port;
    expect(urlPort, '端口不一致会导致 Electron 窗口白屏').toBe(port);
  });
});
