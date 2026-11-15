import type { SurfaceVariantMeta } from '../../manifest/surfaceMetaTypes';

export const GARAGE_SYNC_VARIANT_METAS: SurfaceVariantMeta[] = [
  {
    variantId: 'sync-anonymous',
    label: '5a. Cloud Sync (Anonymous · No Bundle)',
    description:
      'Anonymous public state without a signaling/profile bundle: shows Multiplayer Name Card and BUNDLE REQUIRED placeholder (login form hidden).',
    entryFile: 'recipes/garage/GarageSyncTab.tsx',
    profileTier: 'anonymous',
    tier: 'user',
    storeOverrides: {
      appStore: {
        activeTab: 'sync',
        developerMode: false,
      },
      cloudProfileSyncStore: {
        available: false,
        canManageAccounts: false,
        loggedInUser: null,
        syncStatus: 'idle',
        statusMessage: null,
        errorMessage: null,
        conflicts: [],
        activeRemoteSession: null,
      },
    },
  },
  {
    variantId: 'sync-sign-in',
    label: '5b. Cloud Sync (Pack Imported · Sign In)',
    description:
      'Bundle imported but unauthenticated state: shows Multiplayer Name Card and Cloud Profile Sign-In form.',
    entryFile: 'recipes/garage/GarageSyncTab.tsx',
    profileTier: 'anonymous',
    tier: 'user',
    storeOverrides: {
      appStore: {
        activeTab: 'sync',
        developerMode: false,
      },
      cloudProfileSyncStore: {
        available: true,
        canManageAccounts: false,
        loggedInUser: null,
        syncStatus: 'idle',
        statusMessage: null,
        errorMessage: null,
        conflicts: [],
        activeRemoteSession: null,
      },
    },
  },
  {
    variantId: 'sync-signed-in',
    label: '5c. Cloud Sync (Signed In)',
    description:
      'Authenticated user state showing #alias, user/dev commit hashes, Pull & Merge, Push Local, and Sign Out.',
    entryFile: 'recipes/garage/GarageSyncTab.tsx',
    profileTier: 'signed-in',
    tier: 'user',
    storeOverrides: {
      appStore: {
        activeTab: 'sync',
        developerMode: false,
      },
      cloudProfileSyncStore: {
        available: true,
        canManageAccounts: false,
        loggedInUser: {
          userId: 'u_demo_01',
          username: 'alex',
          alias: 'ace-pilot',
          displayName: 'AcePilot',
          password: '••••••••',
        },
        syncStatus: 'idle',
        userRev: 4,
        userRevHash: 'a3f1c9',
        devRev: 2,
        devRevHash: 'b82d04',
        autoSyncEnabled: true,
        allowRemoteProfileDeployment: true,
        statusMessage: 'Cloud profile synced (3-way merge clean).',
        errorMessage: null,
        conflicts: [],
        activeRemoteSession: null,
      },
    },
  },
  {
    variantId: 'sync-developer',
    label: '5d. Cloud Sync (Developer)',
    description:
      'Developer tier state with account management capability and active remote profile tuning session.',
    entryFile: 'recipes/garage/GarageSyncTab.tsx',
    profileTier: 'developer',
    tier: 'developer',
    storeOverrides: {
      appStore: {
        activeTab: 'sync',
        developerMode: true,
      },
      cloudProfileSyncStore: {
        available: true,
        canManageAccounts: true,
        loggedInUser: {
          userId: 'u_dev_01',
          username: 'mark_dev',
          alias: 'core-dev',
          displayName: 'Mark [Dev]',
          password: '••••••••',
        },
        syncStatus: 'idle',
        userRev: 7,
        userRevHash: 'e91c4a',
        devRev: 5,
        devRevHash: 'f04d12',
        autoSyncEnabled: true,
        allowRemoteProfileDeployment: true,
        statusMessage: 'Developer remote tuning session active for #ace-pilot.',
        errorMessage: null,
        conflicts: [],
        activeRemoteSession: {
          targetUserId: 'u_demo_01',
          targetUsername: 'alex',
          targetAlias: 'ace-pilot',
          targetDisplayName: 'AcePilot',
          startedAt: '2026-11-11T10:00:00.000Z',
          baseDevRev: 5,
        },
      },
    },
  },
];
