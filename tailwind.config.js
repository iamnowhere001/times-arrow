/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './App.tsx', './index.tsx', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 暗房色板：中性石墨 + 相纸白 + 安全灯琥珀
        // 与 src/styles.css 的 CSS 变量保持一致，改色时两处同步。
        ink: {
          900: '#0C0B0A',
          800: '#131211',
          700: '#1B1917',
          600: '#262320',
        },
        paper: '#F5F3EF',
        safelight: {
          DEFAULT: '#E8A33D',
          hover: '#F2B75E',
          deep: '#B87A22',
          soft: 'rgba(232, 163, 61, 0.28)',
        },
        // 语义色（暗色主题取值），状态类 UI 统一从这里取，避免各处手写色值
        signal: {
          danger: '#E9585E',
          success: '#63C08A',
          warning: '#F08A3C',
        },
      },
      fontFamily: {
        // 摄影参数与计数统一使用等宽数字，保证纵向对齐
        numeric: ['"SF Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      transitionTimingFunction: {
        // 与 macOS 一致的「快出慢入」
        smooth: 'cubic-bezier(0.19, 1, 0.22, 1)',
        // 出场（元素进入视线的落位曲线）：快启动、长尾收束
        entrance: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes: {
        // 与 styles.css 中的 @keyframes fadeIn 保持一致，让 animate-fadeIn 真正产出 CSS
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        fadeInUp: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        fadeIn: 'fadeIn 200ms cubic-bezier(0.22, 1, 0.36, 1) both',
        fadeInUp: 'fadeInUp 260ms cubic-bezier(0.22, 1, 0.36, 1) both',
        scaleIn: 'scaleIn 180ms cubic-bezier(0.22, 1, 0.36, 1) both',
      },
    },
  },
  plugins: [],
};
