export {
  createSetupConversation,
  processSetupMessage,
  applyProbeToConversation,
  getOrCreateSetupConversation,
  attachPrdToSetupConversation,
  type SetupConversation,
} from './setup-chat.js';

export {
  applyAuthProbe,
  authPromptForState,
  authPromptFromProbe,
  clearAuthField,
  credentialsComplete,
  detectAuthCorrection,
  effectiveAuthState,
  mergeCredentials,
  nextAuthState,
  parseAuthFields,
  parseLiveCredentials,
} from './auth-chat.js';

export {
  sessionEventToChatMessage,
  processLiveMessage,
  LiveChatStore,
  liveChatStore,
} from './live-chat.js';
