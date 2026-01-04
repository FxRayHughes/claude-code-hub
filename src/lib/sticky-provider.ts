import "server-only";

/**
 * 粘性供应商选择服务
 *
 * 功能：
 * - 同优先级内首次随机选择一个供应商后，后续请求优先使用同一个供应商
 * - 当该供应商连续失败 N 次后，切换到同优先级的其他供应商
 * - 同优先级都不可用时，允许降级到下一优先级
 *
 * 设计：
 * - 使用内存存储粘性选择（重启后重新选择）
 * - 按 "分组+优先级+providerType" 维度维护粘性
 * - 连续失败计数是短期的（区别于熔断器的长期失败）
 */

import { logger } from "@/lib/logger";

/** 默认连续失败阈值，超过此值后切换到同优先级其他供应商 */
const DEFAULT_FAILURE_THRESHOLD = 3;

/** 粘性选择的缓存 TTL（30 分钟），超时后重新选择 */
const STICKY_TTL_MS = 30 * 60 * 1000;

/** 失败记录的过期时间（5 分钟），超时后重置失败计数 */
const FAILURE_EXPIRY_MS = 5 * 60 * 1000;

interface StickyState {
  /** 当前粘性供应商 ID */
  providerId: number;
  /** 选择时间 */
  selectedAt: number;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 最后失败时间 */
  lastFailureAt: number | null;
  /** 已排除的供应商 ID（同优先级内失败过多的） */
  excludedIds: number[];
}

/**
 * 粘性选择的 Key 格式：group:priority:providerType
 * 例如：default:0:claude, cli:1:codex
 */
type StickyKey = string;

function buildStickyKey(
  group: string | null,
  priority: number,
  providerType: string
): StickyKey {
  const normalizedGroup = group || "default";
  return `${normalizedGroup}:${priority}:${providerType}`;
}

/** 内存存储 */
const stickyMap = new Map<StickyKey, StickyState>();

/**
 * 获取当前粘性供应商
 *
 * @param group - 用户/Key 的分组
 * @param priority - 优先级
 * @param providerType - 供应商类型
 * @param availableProviderIds - 当前可用的供应商 ID 列表（健康检查后）
 * @returns 粘性供应商 ID，如果没有或已失效则返回 null
 */
export function getStickyProvider(
  group: string | null,
  priority: number,
  providerType: string,
  availableProviderIds: number[]
): number | null {
  const key = buildStickyKey(group, priority, providerType);
  const state = stickyMap.get(key);

  if (!state) {
    return null;
  }

  const now = Date.now();

  // 检查 TTL
  if (now - state.selectedAt > STICKY_TTL_MS) {
    logger.debug("[StickyProvider] Sticky selection expired", {
      key,
      providerId: state.providerId,
      age: now - state.selectedAt,
    });
    stickyMap.delete(key);
    return null;
  }

  // 检查供应商是否仍在可用列表中
  if (!availableProviderIds.includes(state.providerId)) {
    logger.debug("[StickyProvider] Sticky provider no longer available", {
      key,
      providerId: state.providerId,
      availableIds: availableProviderIds,
    });
    // 不删除，让调用方决定是否需要重新选择
    return null;
  }

  // 检查失败计数是否过期（超过 FAILURE_EXPIRY_MS 没有新失败则重置）
  if (
    state.lastFailureAt &&
    now - state.lastFailureAt > FAILURE_EXPIRY_MS &&
    state.consecutiveFailures > 0
  ) {
    logger.debug("[StickyProvider] Resetting failure count due to expiry", {
      key,
      providerId: state.providerId,
      previousFailures: state.consecutiveFailures,
    });
    state.consecutiveFailures = 0;
    state.lastFailureAt = null;
  }

  return state.providerId;
}

/**
 * 设置粘性供应商
 *
 * @param group - 用户/Key 的分组
 * @param priority - 优先级
 * @param providerType - 供应商类型
 * @param providerId - 供应商 ID
 */
export function setStickyProvider(
  group: string | null,
  priority: number,
  providerType: string,
  providerId: number
): void {
  const key = buildStickyKey(group, priority, providerType);

  stickyMap.set(key, {
    providerId,
    selectedAt: Date.now(),
    consecutiveFailures: 0,
    lastFailureAt: null,
    excludedIds: [],
  });

  logger.info("[StickyProvider] Set sticky provider", {
    key,
    providerId,
  });
}

/**
 * 记录供应商失败
 *
 * @param group - 用户/Key 的分组
 * @param priority - 优先级
 * @param providerType - 供应商类型
 * @param providerId - 失败的供应商 ID
 * @param failureThreshold - 失败阈值，超过此值后触发切换（默认 3）
 * @returns 是否需要切换供应商
 */
export function recordStickyFailure(
  group: string | null,
  priority: number,
  providerType: string,
  providerId: number,
  failureThreshold: number = DEFAULT_FAILURE_THRESHOLD
): { shouldSwitch: boolean; excludedIds: number[] } {
  const key = buildStickyKey(group, priority, providerType);
  const state = stickyMap.get(key);

  // 如果没有粘性状态或不是当前粘性供应商，不处理
  if (!state || state.providerId !== providerId) {
    return { shouldSwitch: false, excludedIds: [] };
  }

  const now = Date.now();

  // 如果距离上次失败超过了过期时间，重置计数
  if (state.lastFailureAt && now - state.lastFailureAt > FAILURE_EXPIRY_MS) {
    state.consecutiveFailures = 0;
  }

  state.consecutiveFailures++;
  state.lastFailureAt = now;

  logger.warn("[StickyProvider] Recorded failure", {
    key,
    providerId,
    consecutiveFailures: state.consecutiveFailures,
    threshold: failureThreshold,
  });

  // 检查是否达到阈值
  if (state.consecutiveFailures >= failureThreshold) {
    // 将当前供应商加入排除列表
    if (!state.excludedIds.includes(providerId)) {
      state.excludedIds.push(providerId);
    }

    logger.warn("[StickyProvider] Failure threshold reached, should switch", {
      key,
      providerId,
      consecutiveFailures: state.consecutiveFailures,
      excludedIds: state.excludedIds,
    });

    return { shouldSwitch: true, excludedIds: [...state.excludedIds] };
  }

  return { shouldSwitch: false, excludedIds: [...state.excludedIds] };
}

/**
 * 记录供应商成功
 *
 * @param group - 用户/Key 的分组
 * @param priority - 优先级
 * @param providerType - 供应商类型
 * @param providerId - 成功的供应商 ID
 */
export function recordStickySuccess(
  group: string | null,
  priority: number,
  providerType: string,
  providerId: number
): void {
  const key = buildStickyKey(group, priority, providerType);
  const state = stickyMap.get(key);

  // 如果没有粘性状态或不是当前粘性供应商，不处理
  if (!state || state.providerId !== providerId) {
    return;
  }

  // 成功后重置连续失败计数
  if (state.consecutiveFailures > 0) {
    logger.debug("[StickyProvider] Reset failure count after success", {
      key,
      providerId,
      previousFailures: state.consecutiveFailures,
    });
    state.consecutiveFailures = 0;
    state.lastFailureAt = null;
  }
}

/**
 * 切换到同优先级的其他供应商
 *
 * @param group - 用户/Key 的分组
 * @param priority - 优先级
 * @param providerType - 供应商类型
 * @param newProviderId - 新的供应商 ID
 * @param preserveExcluded - 是否保留已排除列表
 */
export function switchStickyProvider(
  group: string | null,
  priority: number,
  providerType: string,
  newProviderId: number,
  preserveExcluded: boolean = true
): void {
  const key = buildStickyKey(group, priority, providerType);
  const existingState = stickyMap.get(key);

  const excludedIds = preserveExcluded ? existingState?.excludedIds || [] : [];

  stickyMap.set(key, {
    providerId: newProviderId,
    selectedAt: Date.now(),
    consecutiveFailures: 0,
    lastFailureAt: null,
    excludedIds,
  });

  logger.info("[StickyProvider] Switched sticky provider", {
    key,
    oldProviderId: existingState?.providerId,
    newProviderId,
    excludedIds,
  });
}

/**
 * 获取同优先级内已排除的供应商 ID
 */
export function getExcludedProviders(
  group: string | null,
  priority: number,
  providerType: string
): number[] {
  const key = buildStickyKey(group, priority, providerType);
  const state = stickyMap.get(key);
  return state?.excludedIds || [];
}

/**
 * 清除指定维度的粘性状态（用于优先级降级时）
 */
export function clearStickyState(
  group: string | null,
  priority: number,
  providerType: string
): void {
  const key = buildStickyKey(group, priority, providerType);
  stickyMap.delete(key);
  logger.debug("[StickyProvider] Cleared sticky state", { key });
}

/**
 * 清除所有粘性状态（用于测试或重置）
 */
export function clearAllStickyStates(): void {
  stickyMap.clear();
  logger.info("[StickyProvider] Cleared all sticky states");
}

/**
 * 获取所有粘性状态（用于监控/调试）
 */
export function getAllStickyStates(): Record<string, StickyState> {
  const result: Record<string, StickyState> = {};
  stickyMap.forEach((state, key) => {
    result[key] = { ...state };
  });
  return result;
}
