import type { StoreApi, UseBoundStore } from 'zustand';
import { syncBridge as crossClientSync } from './syncBridge';
import type {
  QuickNotificationItem,
  QuickNotificationStore,
  QuickNotificationStoreState,
} from './notificationTypes';

const sanitizeItem = (item: QuickNotificationItem | null): QuickNotificationItem | null => {
  if (!item) return null;
  return {
    ...item,
    icon: typeof item.icon === 'string' ? item.icon : 'bell',
    buttons: item.buttons?.map((b) => ({
      key: b.key,
      label: b.label,
      color: b.color,
      format: b.format,
      icon: typeof b.icon === 'string' ? b.icon : undefined,
    })),
  };
};

export const bindQuickNotificationSync = (
  useStore: UseBoundStore<StoreApi<QuickNotificationStore>>,
  clearActiveTimers: () => void
): void => {
  let syncingFromRemoteNotification = false;

  useStore.subscribe((s) => {
    if (syncingFromRemoteNotification || crossClientSync.isApplyingRemote()) return;
    crossClientSync.set('store:quickNotification', {
      activeNotification: sanitizeItem(s.activeNotification),
      preemptedPersistentStack: s.preemptedPersistentStack
        .map(sanitizeItem)
        .filter(Boolean) as QuickNotificationItem[],
      unreadStack: s.unreadStack.map(sanitizeItem).filter(Boolean) as QuickNotificationItem[],
      totalUnreadCount: s.totalUnreadCount,
      isStackOpen: s.isStackOpen,
      isForceCollapsed: s.isForceCollapsed,
      ongoingTasks: s.ongoingTasks.map(sanitizeItem).filter(Boolean) as QuickNotificationItem[],
      activeOngoingTask: sanitizeItem(s.activeOngoingTask),
      ongoingConflictPolicy: s.ongoingConflictPolicy,
    });
  });

  crossClientSync.subscribeKey<Partial<QuickNotificationStoreState>>(
    'store:quickNotification',
    (remote) => {
      if (!remote || typeof remote !== 'object') return;
      syncingFromRemoteNotification = true;
      try {
        clearActiveTimers();
        useStore.setState({
          activeNotification: remote.activeNotification ?? null,
          preemptedPersistentStack: remote.preemptedPersistentStack ?? [],
          unreadStack: remote.unreadStack ?? [],
          totalUnreadCount: remote.totalUnreadCount ?? 0,
          isStackOpen: remote.isStackOpen ?? false,
          isForceCollapsed: remote.isForceCollapsed ?? false,
          ongoingTasks: remote.ongoingTasks ?? [],
          activeOngoingTask: remote.activeOngoingTask ?? null,
          ongoingConflictPolicy: remote.ongoingConflictPolicy ?? 'latest',
        });
      } finally {
        syncingFromRemoteNotification = false;
      }
    }
  );

  crossClientSync.onReset((scopePrefix) => {
    if (scopePrefix && !'store:quickNotification'.startsWith(scopePrefix)) return;
    clearActiveTimers();
    useStore.setState({
      activeNotification: null,
      preemptedPersistentStack: [],
      unreadStack: [],
      totalUnreadCount: 0,
      ongoingTasks: [],
      activeOngoingTask: null,
      isStackOpen: false,
      isForceCollapsed: false,
      ongoingConflictPolicy: 'latest',
    });
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('ui:expand-quick-notification', () => {
      useStore.getState().expandNotificationCenter();
    });
  }
};
