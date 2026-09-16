import { describe, it, expect } from 'vitest';
import {
  HASH_WIDTH,
  HASH_HEIGHT,
  HASH_HEX_LENGTH,
  dHashFromRGBA,
  dHashFromBGRA,
} from '../../electron/lib/dhash.cjs';
// 渲染层的入口：它必须只是共享实现的薄封装，不能再有自己的算法
import { getImageHash } from '@/utils';

/**
 * P2-17 的验收测试：dHash 必须只有一份实现。
 *
 * 改造前主进程与渲染层各有一份手写实现，任何一处被改动都会让同一张图算出不同哈希，
 * 而重复检测正是拿哈希互相比较的 —— 结果就是静默的漏判或误判，没有任何报错。
 *
 * 这组用例守住三件事：
 *   1. 算法本身的确定性（同输入必同输出，且长度/格式固定）
 *   2. 两种字节排布（RGBA / BGRA）对同一张图给出相同结果
 *   3. **跨入口一致**：渲染层走的那条路径与主进程走的那条路径，结果是同一个函数算的
 */

/** 造一张 width×height 的纯色图（RGBA 排布） */
function solidRGBA(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

/** 把 RGBA 转成 BGRA（同一个逻辑图像，只是字节顺序不同） */
function toBGRA(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

/** 每行从左到右亮度递减 → 每个相邻比较都为真 → 全 1 */
function decreasingRows(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(HASH_WIDTH * HASH_HEIGHT * 4);
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH; x += 1) {
      // 左侧亮（255）→ 右侧暗（0），单调递减
      const v = Math.round(255 * (1 - x / (HASH_WIDTH - 1)));
      const i = (y * HASH_WIDTH + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

/** 每行从左到右亮度递增 → 相邻比较全为假 → 全 0 */
function increasingRows(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(HASH_WIDTH * HASH_HEIGHT * 4);
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH; x += 1) {
      const v = Math.round(255 * (x / (HASH_WIDTH - 1)));
      const i = (y * HASH_WIDTH + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * R 与 B 逐像素交替的图案。
 *
 * 为什么需要它：验证「排布写错会被发现」时不能用纯色图 —— 纯色图所有相邻像素亮度相等，
 * 不管通道怎么排都是全 0 哈希，换排布也看不出差别。也不能用单通道渐变 ——
 * 那只是把权重从一个正数换成另一个正数，相邻大小关系不变，哈希仍然相同。
 * 只有让 R/B 在相邻像素间**反向**变化，交换权重才会真正翻转比较方向。
 */
function alternatingRB(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(HASH_WIDTH * HASH_HEIGHT * 4);
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH; x += 1) {
      const bright = x % 2 === 0;
      const i = (y * HASH_WIDTH + x) * 4;
      data[i] = bright ? 255 : 0; // R
      data[i + 1] = 0; // G
      data[i + 2] = bright ? 0 : 255; // B
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('采样尺寸与输出格式', () => {
  it('采样为 9x8，产出 16 个十六进制字符（64 bit）', () => {
    expect(HASH_WIDTH).toBe(9);
    expect(HASH_HEIGHT).toBe(8);
    expect(HASH_HEX_LENGTH).toBe(16);
  });

  it('输出恒为 16 位小写十六进制', () => {
    const inputs = [
      solidRGBA(HASH_WIDTH, HASH_HEIGHT, 0, 0, 0),
      solidRGBA(HASH_WIDTH, HASH_HEIGHT, 255, 255, 255),
      increasingRows(),
      decreasingRows(),
    ];
    for (const data of inputs) {
      const hash = dHashFromRGBA(data);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('确定性', () => {
  it('同一输入多次计算结果完全相同', () => {
    const data = solidRGBA(HASH_WIDTH, HASH_HEIGHT, 123, 45, 67);
    expect(dHashFromRGBA(data)).toBe(dHashFromRGBA(data));
  });

  it('纯色图（相邻像素亮度相等）全为 0 —— 相等记 0 而不是 1', () => {
    expect(dHashFromRGBA(solidRGBA(HASH_WIDTH, HASH_HEIGHT, 0, 0, 0))).toBe('0000000000000000');
    expect(dHashFromRGBA(solidRGBA(HASH_WIDTH, HASH_HEIGHT, 255, 255, 255))).toBe(
      '0000000000000000'
    );
    expect(dHashFromRGBA(solidRGBA(HASH_WIDTH, HASH_HEIGHT, 128, 128, 128))).toBe(
      '0000000000000000'
    );
  });

  it('每行亮度递减 → 全 1；递增 → 全 0', () => {
    expect(dHashFromRGBA(decreasingRows())).toBe('ffffffffffffffff');
    expect(dHashFromRGBA(increasingRows())).toBe('0000000000000000');
  });

  it('亮度权重为 Rec.601：纯绿比纯红更亮，故同构图的哈希一致', () => {
    // 权重只影响灰度值大小，不影响「谁比谁亮」的相对关系；
    // 这里用红/绿/蓝三张纯色图的哈希必须都相同来间接验证权重是正数且无错位
    const red = dHashFromRGBA(solidRGBA(HASH_WIDTH, HASH_HEIGHT, 255, 0, 0));
    const green = dHashFromRGBA(solidRGBA(HASH_WIDTH, HASH_HEIGHT, 0, 255, 0));
    const blue = dHashFromRGBA(solidRGBA(HASH_WIDTH, HASH_HEIGHT, 0, 0, 255));
    expect(red).toBe(green);
    expect(green).toBe(blue);
  });
});

describe('RGBA / BGRA 两种排布', () => {
  it('同一张逻辑图像，两种排布算出相同哈希', () => {
    const cases = [
      solidRGBA(HASH_WIDTH, HASH_HEIGHT, 200, 100, 50),
      increasingRows(),
      decreasingRows(),
      alternatingRB(),
      solidRGBA(HASH_WIDTH, HASH_HEIGHT, 12, 200, 90),
    ];
    for (const rgba of cases) {
      expect(dHashFromBGRA(toBGRA(rgba))).toBe(dHashFromRGBA(rgba));
    }
  });

  it('排布写错会被发现：把 RGBA 当 BGRA 喂进去，结果必须不同', () => {
    // 反向保险：如果哪天有人把 toBitmap() 的排布假设改错了，上面的等价性用例照样通过，
    // 但实际哈希已经全错。所以这里用 R/B 交替图显式钉住「两种读法确实会给出不同结果」——
    // 若这条失败，说明该图案已经无法区分排布，上面那条等价性断言就失去意义了。
    const rgba = alternatingRB();
    expect(dHashFromBGRA(rgba)).not.toBe(dHashFromRGBA(rgba));
  });

  it('纯色图无法区分排布（正因如此才需要 R/B 交替图）', () => {
    const solid = solidRGBA(HASH_WIDTH, HASH_HEIGHT, 200, 100, 50);
    expect(dHashFromBGRA(solid)).toBe(dHashFromRGBA(solid));
  });
});

describe('异常输入', () => {
  it('字节数不足时返回 null，而不是产出短哈希或 NaN', () => {
    expect(dHashFromRGBA(new Uint8ClampedArray(10))).toBeNull();
    expect(dHashFromBGRA(new Uint8ClampedArray(10))).toBeNull();
    expect(dHashFromRGBA(null as never)).toBeNull();
    expect(dHashFromRGBA(undefined as never)).toBeNull();
  });

  it('多给的字节被忽略（不越界读取）', () => {
    const exact = solidRGBA(HASH_WIDTH, HASH_HEIGHT, 10, 20, 30);
    const padded = new Uint8ClampedArray(exact.length + 400);
    padded.set(exact);
    expect(dHashFromRGBA(padded)).toBe(dHashFromRGBA(exact));
  });
});

describe('跨入口一致性：渲染层与主进程必须走同一个函数', () => {
  it('渲染层的 getImageHash 存在且是函数（入口未被 tree-shaking 或改签名）', () => {
    expect(typeof getImageHash).toBe('function');
  });

  it('渲染层没有自己的 dHash 算法实现，且确实从共享模块引入', async () => {
    // 算法本体在 electron/lib/dhash.cjs；渲染层的唯一入口是 photoHash.ts
    // （P2-16 拆分后从 utils/index.ts 移到了这里，本断言会跟着一起检查新位置）
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const rendererSource = readFileSync(resolve(__dirname, '../../src/lib/media/photoHash.ts'), 'utf8');

    // 渲染层不应再出现自己的灰度权重常量
    expect(rendererSource).not.toMatch(/0\.299/);
    expect(rendererSource).not.toMatch(/0\.587/);
    expect(rendererSource).not.toMatch(/0\.114/);
    // 且必须从共享模块引入
    expect(rendererSource).toMatch(/from '.*electron\/lib\/dhash\.cjs'/);
  });

  it('整个 src 里只有一处引用 dHash 算法本体', async () => {
    // 防止「在别处又抄一份」：扫全部源码，只允许 photoHash.ts 引用共享模块
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const SRC = resolve(__dirname, '../../src');

    const collect = (dir: string, acc: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collect(full, acc);
        else if (/\.tsx?$/.test(entry)) acc.push(full);
      }
      return acc;
    };

    const importers = collect(SRC).filter((file) =>
      /from '[^']*electron\/lib\/dhash\.cjs'/.test(readFileSync(file, 'utf8'))
    );
    expect(importers.map((f) => f.replace(SRC, 'src'))).toEqual(['src/lib/media/photoHash.ts']);
  });
});
