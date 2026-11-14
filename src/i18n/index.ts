/**
 * 轻量 i18n：中文原文即 key，英文查 `en.ts`；缺失时回退中文原文。
 *
 * - 默认语言按用户系统时区判断（中国 / 港台时区 → 中文），时区无法判断时再看系统语言；
 * - 用户手动切换后写入 localStorage，之后始终以手动选择为准；
 * - 组件用 `useT()` 订阅语言变化，非组件模块（store / 纯函数）用 `t()` 直接取当前语言。
 */
import { useCallback } from 'react';
import { create } from 'zustand';

import type { AppError } from '../ipc/types';
import { EN, ERROR_CODE_EN } from './en';

export type Lang = 'zh' | 'en';

const LANG_KEY = 'tree-todo.language';

/** 中文用户常见系统时区（含 Windows 的旧时区名）。 */
const ZH_TIMEZONES =
  /^(Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Taipei|Hong_Kong|Macao|Macau)|PRC|ROC)$/;

/** 读取系统语言 / 时区判断默认语言。 */
export function detectSystemLang(): Lang {
  let locales: readonly string[] = [];
  try {
    locales =
      navigator.languages && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
  } catch {
    /* 无 navigator（测试环境）时继续用时区判断 */
  }
  // 系统语言明确是中文 → 中文（中文用户换到海外时区也不该被切成英文）。
  if (locales.some(l => /^zh/i.test(l))) return 'zh';
  let zhTimezone = false;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
    zhTimezone = ZH_TIMEZONES.test(tz);
  } catch {
    /* 取不到时区时按英文处理 */
  }
  // 系统语言不可判定（缺省 / 非中英）时，用系统时区兜底：中国 / 港台时区默认中文。
  // 系统语言明确是英文时尊重英文，避免英文用户被时区强行切到中文。
  if (zhTimezone && !locales.some(l => /^en/i.test(l))) return 'zh';
  return 'en';
}

function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === 'zh' || v === 'en') return v;
  } catch {
    /* localStorage 不可用时忽略 */
  }
  return null;
}

function applyDocumentLang(lang: Lang): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }
}

const BOOT_LANG: Lang = readStoredLang() ?? detectSystemLang();
applyDocumentLang(BOOT_LANG);

interface LangState {
  lang: Lang;
}

export const useLangStore = create<LangState>(() => ({ lang: BOOT_LANG }));

export function getLang(): Lang {
  return useLangStore.getState().lang;
}

/** 当前语言对应的 BCP 47 locale（日期 / 数字格式化用）。 */
export function locale(): string {
  return getLang() === 'zh' ? 'zh-CN' : 'en-US';
}

export function translate(
  lang: Lang,
  zh: string,
  vars?: Record<string, string | number>,
): string {
  let out = lang === 'en' ? (EN[zh] ?? zh) : zh;
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (m, key) =>
      vars[key] !== undefined ? String(vars[key]) : m,
    );
  }
  return out;
}

/** 非组件模块使用：读取当前语言的翻译。 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  return translate(getLang(), zh, vars);
}

/** 组件使用：订阅语言变化，切换语言后自动重渲染。 */
export function useT(): (zh: string, vars?: Record<string, string | number>) => string {
  const lang = useLangStore(s => s.lang);
  return useCallback(
    (zh: string, vars?: Record<string, string | number>) => translate(lang, zh, vars),
    [lang],
  );
}

export function useLang(): Lang {
  return useLangStore(s => s.lang);
}

/** 切换语言并持久化；所有使用 useT 的组件会立即重渲染。 */
export function setLang(lang: Lang): void {
  useLangStore.setState({ lang });
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* 忽略持久化失败 */
  }
  applyDocumentLang(lang);
}

/**
 * Rust 错误 → 当前语言文案。
 * 英文界面下不直接展示 Rust 返回的中文细节，按错误码给出英文兜底；
 * BadRequest 的细节是业务提示，用调用方传入的英文 fallback。
 */
export function localizedError(e: unknown, fallback: string): string {
  const ae = e as Partial<AppError> | undefined;
  if (getLang() === 'en') {
    const byCode = ae?.code ? ERROR_CODE_EN[ae.code] : undefined;
    if (byCode) return byCode;
    if (ae?.code === 'BadRequest') return fallback;
  }
  if (ae && typeof ae.message === 'string' && ae.message) return ae.message;
  return fallback;
}
