/**
 * AppSettings 持久化（移植自 GitAiSettings.kt）：
 * - appSettingsJson 是唯一真相源，读取时与默认值深合并（缺字段补默认）。
 * - 存储后端抽象成 SettingsStore：VSCode 侧用 globalState，冒烟测试用内存实现。
 */

export interface SettingsStore {
  /** 用户显式指定的 git-ai 路径；空串/未设置折成 null。 */
  getGitAiPath(): string | null;
  getAppSettingsJson(): string | null;
  setAppSettingsJson(json: string): void;
}

export type Json = Record<string, unknown>;

export const DEFAULT_APP_SETTINGS: Json = {
  scan_roots: [],
  recent_repos: [],
  last_repo: null,
  theme: null,
  close_behavior: "exit",
  notifications: {
    cc_switch_auto_repair: false,
    low_ai_share: {
      enabled: false,
      threshold_percent: null,
      target_emails: [],
      remind_interval_minutes: null,
      dismiss_minutes: null,
      realtime_enabled: null,
    },
    daemon_unhealthy_alert: false,
  },
  repo_setup_seen: false,
  pet: {
    enabled: false,
    theme_id: null,
    position: null,
    size: null,
    opacity: null,
    alert_interval_sec: null,
  },
  aggregate_repos: [],
  aggregate_repos_explicit: false,
};

function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 深合并：override 的同名子对象递归合并，其余直接覆盖（与 Kotlin deepMerge 一致）。 */
export function deepMerge(defaults: Json, override: Json): Json {
  const out: Json = { ...defaults };
  for (const [k, v] of Object.entries(override)) {
    const base = out[k];
    if (isPlainObject(base) && isPlainObject(v)) {
      out[k] = deepMerge(base, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class AppSettings {
  constructor(private readonly store: SettingsStore) {}

  gitAiPath(): string | null {
    return this.store.getGitAiPath();
  }

  appSettings(): Json {
    const raw = this.store.getAppSettingsJson();
    if (!raw) return structuredClone(DEFAULT_APP_SETTINGS);
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) return structuredClone(DEFAULT_APP_SETTINGS);
      return deepMerge(structuredClone(DEFAULT_APP_SETTINGS), parsed);
    } catch {
      return structuredClone(DEFAULT_APP_SETTINGS);
    }
  }

  saveAppSettings(obj: Json): void {
    this.store.setAppSettingsJson(JSON.stringify(obj));
  }

  /**
   * set_app_settings 的扁平 patch（移植自 applySettingsPatch）：
   * 只写入存在的键；low_ai_share_* 写进 notifications.low_ai_share.<去前缀名>。
   */
  applySettingsPatch(patch: Json): Json {
    const s = this.appSettings();
    const notifications = s.notifications as Json;
    const lowAiShare = notifications.low_ai_share as Json;

    const has = (k: string) => Object.prototype.hasOwnProperty.call(patch, k);

    // theme/close_behavior 仅接受非 null 字符串、scan_roots 仅接受数组（对齐 Kotlin patch.str / isJsonArray 门控）；
    // 其余键只要出现就写入（含显式 null）。
    if (typeof patch.theme === "string") s.theme = patch.theme;
    if (Array.isArray(patch.scan_roots)) s.scan_roots = patch.scan_roots;
    if (typeof patch.close_behavior === "string") s.close_behavior = patch.close_behavior;
    if (has("cc_switch_auto_repair")) notifications.cc_switch_auto_repair = patch.cc_switch_auto_repair;
    if (has("daemon_unhealthy_alert")) notifications.daemon_unhealthy_alert = patch.daemon_unhealthy_alert;
    if (has("low_ai_share_enabled")) lowAiShare.enabled = patch.low_ai_share_enabled;
    if (has("low_ai_share_threshold_percent")) lowAiShare.threshold_percent = patch.low_ai_share_threshold_percent;
    if (has("low_ai_share_target_emails")) lowAiShare.target_emails = patch.low_ai_share_target_emails;
    if (has("low_ai_share_remind_interval_minutes"))
      lowAiShare.remind_interval_minutes = patch.low_ai_share_remind_interval_minutes;
    if (has("low_ai_share_dismiss_minutes")) lowAiShare.dismiss_minutes = patch.low_ai_share_dismiss_minutes;
    if (has("low_ai_share_realtime_enabled")) lowAiShare.realtime_enabled = patch.low_ai_share_realtime_enabled;
    if (has("repo_setup_seen")) s.repo_setup_seen = patch.repo_setup_seen;

    this.saveAppSettings(s);
    return s;
  }
}

/** 冒烟测试 / 非 VSCode 宿主用的内存实现。 */
export class InMemorySettingsStore implements SettingsStore {
  private json: string | null = null;
  constructor(private readonly gitAiPath: string | null = null) {}
  getGitAiPath(): string | null {
    return this.gitAiPath;
  }
  getAppSettingsJson(): string | null {
    return this.json;
  }
  setAppSettingsJson(json: string): void {
    this.json = json;
  }
}
