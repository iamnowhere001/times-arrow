/**
 * 文件路径与文件名的基础工具（纯函数）。
 *
 * 与 `@/utils` 中的 `folderOfPath` 互补：这里负责「拼接」与「规范化」，
 * 供单张重命名、批量重命名、导出写盘共用。
 *
 * ## 文件名规范化的唯一入口
 *
 * 改造前这里有两套互不相干的规则：`sanitizeFilename` **静默剔除**非法字符，
 * 而 `RenameModal` 自带一份 `INVALID_CHARS` 正则 + 保留名集合，对同样的输入**报错拒绝**。
 * 结果是同一份文件名在预览里显示「合法」，落到磁盘上却被改成了另一个名字 ——
 * 用户看到的预览和实际结果对不上。
 *
 * 现在统一为：`validateFilename()` 负责**判断并给出人话理由**（给 UI 用），
 * `sanitizeFilename()` 负责**改造成合法名字**（给落盘用），两者共用同一套字符规则。
 * 由此得到一条可测试的不变式：
 *
 *     validateFilename(name).ok === true  ⟹  sanitizeFilename(name) === name
 *
 * 即「校验通过的名字，规范化后一定原样不变」，预览与结果因此不可能漂移。
 */

/** 三平台都不接受的字符：`< > : " / \ | ? *`，外加 C0 控制字符与 DEL */
const ILLEGAL_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
/** 用于「是否含有非法字符」的判定（非全局，避免 lastIndex 副作用） */
const HAS_ILLEGAL_CHAR_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

/** Windows 保留设备名（大小写不敏感，且带扩展名也仍然保留） */
const RESERVED_NAMES = new Set<string>([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** 单个路径分量的字节上限：主流文件系统是 255 字节（UTF-8 下中文一个字占 3 字节） */
const MAX_NAME_BYTES = 255;

/** 超长时用于截断的标记 */
const TRUNCATE_MARK = '~';

/** 文件名是否命中 Windows 保留设备名（比较主名，不含扩展名） */
export function isReservedName(filename: string): boolean {
  const stem = filename.replace(/\.[^.]*$/, '');
  return RESERVED_NAMES.has(stem.toLowerCase());
}

/** 计算 UTF-8 字节长度 */
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * 校验一个文件名能否直接落盘。
 *
 * 与 `sanitizeFilename` 共用同一套规则：**校验通过 ⟹ 规范化后不变**。
 * 因此 UI 层应当用本函数决定「是否报错」，而不是自己再写一份正则 ——
 * 那样两边一旦不同步，预览与实际结果就会不一致。
 */
export function validateFilename(filename: string): { ok: true } | { ok: false; reason: string } {
  if (!filename) return { ok: false, reason: '文件名不能为空' };
  if (filename === '.' || filename === '..') return { ok: false, reason: '文件名不能是 . 或 ..' };
  if (filename.includes('/') || filename.includes('\\')) {
    return { ok: false, reason: '文件名不能包含路径分隔符' };
  }
  if (HAS_ILLEGAL_CHAR_RE.test(filename)) {
    return { ok: false, reason: '文件名包含系统不允许的字符（< > : " / \\ | ? *）' };
  }
  if (isReservedName(filename)) {
    return { ok: false, reason: '该名称为系统保留名称（如 CON、PRN、COM1）' };
  }
  if (/[. ]$/.test(filename)) {
    return { ok: false, reason: '文件名不能以空格或点号结尾' };
  }
  if (byteLength(filename) > MAX_NAME_BYTES) {
    return { ok: false, reason: `文件名过长（超过 ${MAX_NAME_BYTES} 字节）` };
  }
  return { ok: true };
}

/**
 * 把任意字符串规范化为可直接落盘的文件名。
 *
 * 与 `validateFilename` 共用同一套规则，保证「校验通过的名字规范化后原样不变」。
 * 处理顺序有讲究：先替换非法字符（避免后续判断被它们干扰），再处理首尾与长度，
 * 最后兜底空结果。
 */
export const sanitizeFilename = (filename: string): string => {
  let name = String(filename ?? '');

  // 1) 非法字符统一替换为连字符（而不是直接删除 —— 直接删会让 `a:b` 和 `ab` 撞名）
  name = name.replace(ILLEGAL_CHARS_RE, '-');

  // 2) 折叠连续连字符与首尾连字符，避免 `a::b` 变成 `a--b`
  name = name.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  // 3) Windows 不允许以点或空格结尾
  name = name.replace(/[. ]+$/, '');

  // 4) 保留设备名：在主名后追加下划线破掉。
  //    注意要插在扩展名之前（`con.txt` → `con_.txt`）—— Windows 的保留判断
  //    不受扩展名影响，`con.txt` 同样是保留名，所以不能简单在末尾补下划线。
  if (isReservedName(name)) {
    const dot = name.lastIndexOf('.');
    name = dot > 0 ? `${name.slice(0, dot)}_${name.slice(dot)}` : `${name}_`;
  }

  // 5) 长度：保留扩展名，截断主名
  if (byteLength(name) > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const extBytes = byteLength(ext);
    const budget = MAX_NAME_BYTES - extBytes - byteLength(TRUNCATE_MARK);
    let stem = dot > 0 ? name.slice(0, dot) : name;
    // 按字符逐个退，直到字节数落进预算（中文一个字 3 字节，不能按长度切）
    while (stem.length > 0 && byteLength(stem) > budget) stem = stem.slice(0, -1);
    name = `${stem}${TRUNCATE_MARK}${ext}`;
  }

  // 6) 兜底：全部被剔掉时给一个确定的名字，绝不返回空串
  if (!name || name === '.' || name === '..') return 'untitled';
  return name;
};

/** 判定路径是否为 Windows 形式：有盘符，或含反斜杠而不含正斜杠 */
const looksWindows = (p: string): boolean =>
  /^[a-zA-Z]:/.test(p) || (p.includes('\\') && !p.includes('/'));

/**
 * 安全地拼接目录与文件名，行为对齐 Node 的 `path.join`。
 *
 * 渲染层不能直接用 `node:path`（沙箱下没有 Node 内置模块），因此在这里实现一份
 * 语义等价的版本。相比原先的字符串拼接，修掉了这几类问题：
 *  - 目录为空时不再产出以分隔符开头的错误路径（`'' + '/' + 'a'` 曾是 `'/a'`）
 *  - 文件名以分隔符开头时不再产生 `//`
 *  - `.` / `..` 段会被折叠（`/a/./b` → `/a/b`，`/a/x/../b` → `/a/b`）
 *  - 不再用「目录里有没有反斜杠」猜平台 —— POSIX 下反斜杠是合法文件名字符，
 *    原判据会把 `/Users/me/a\b` 误判成 Windows 路径
 *  - 保留根目录语义：`'/' + 'a'` 仍是 `'/a'`，`'C:\' + 'a'` 仍是 `'C:\a'`
 */
export const joinPath = (dirPath: string, filename: string): string => {
  const win = looksWindows(dirPath) || looksWindows(filename);
  const sep = win ? '\\' : '/';

  // 先把两段拼起来再归一化；空段直接丢弃（Node 的 path.join 也这样处理）
  const raw = [dirPath, filename].filter((part) => part !== '').join(sep);
  const normalized = win ? raw.replace(/\//g, '\\') : raw;

  // 拆出根前缀：Windows 的 `C:\` 或 `\\server\share`，POSIX 的 `/`
  // 注意 POSIX 的 `/` 也要折叠 —— `//c.jpg` 会被 `/^(\/+)/` 整段吃掉，
  // 不折叠就会把根变成 `//`，拼出 `//c.jpg`。
  const rootMatch = win
    ? /^([a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+\\?|\\+)/.exec(normalized)
    : /^(\/+)/.exec(normalized);
  const root = rootMatch ? rootMatch[1].replace(win ? /\\{2,}/g : /\/{2,}/g, win ? '\\' : '/') : '';
  const rest = normalized.slice(rootMatch ? rootMatch[1].length : 0);

  const segments: string[] = [];
  for (const segment of rest.split(win ? /\\+/ : /\/+/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      const last = segments[segments.length - 1];
      if (last !== undefined && last !== '..') segments.pop();
      // 有根时越界的 `..` 被根吸收（Node 同此行为）；相对路径则保留
      else if (!root) segments.push('..');
      continue;
    }
    segments.push(segment);
  }

  const joined = segments.join(sep);
  if (!root) return joined || '.';
  return root.endsWith(sep) ? `${root}${joined}` : `${root}${sep}${joined}`;
};

// ---------------------------------------------------------------------------
// 路径分量提取
// ---------------------------------------------------------------------------

/**
 * 取文件所在目录（保留原分隔符风格，不解析符号链接、不做归一化）。
 *
 * 用途是「同一目录内才算重名」这类**比较**：不同文件夹下的同名文件不应互相加序号。
 * 因此这里刻意不做 realpath / 归一化 —— 两侧都来自同一个来源（主进程返回的路径），
 * 字符串一致就说明确实同目录；反而归一化会引入额外 IO 与不一致的风险。
 *
 * 无路径或没有分隔符时返回空串（调用方据此把「无磁盘路径」的条目归入同一桶）。
 */
export const folderOfPath = (fullPath: string): string => {
  if (!fullPath) return '';
  const idx = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
  return idx > 0 ? fullPath.slice(0, idx) : '';
};

/**
 * 取文件扩展名（小写，不含点）。
 *
 * 注意 `.gitignore` 这类点开头的名字会返回 `'gitignore'` 而不是空串 ——
 * 对照片库没有影响（扫描阶段就跳过了所有点开头的条目），但别把它当通用工具用。
 */
export const extOfName = (name: string): string => {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
};

/**
 * 把磁盘绝对路径转成 `pm://` 原图地址。
 *
 * 图片通过自定义协议以流方式加载，不再以 base64 data URL 常驻内存。
 * **必须**使用 `pm://<host>/...` 形式：`pm:///...` 的空 host 会被 Chromium 折叠，
 * 导致协议 handler 里 `url.pathname` 切段错位（表现为 404 而不是 403）。
 *
 * base64url 编码（`+`→`-`、`/`→`_`、去掉 `=`）是必须的：标准 base64 的 `/`
 * 会被 URL 解析成路径分隔符，整个路径就断了。
 */
export const pmFileUrl = (filePath: string): string => {
  const bytes = new TextEncoder().encode(filePath);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64url = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `pm://local/file/${base64url}`;
};
