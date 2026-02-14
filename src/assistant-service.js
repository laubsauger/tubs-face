const { generateAssistantReply, generateStreamingAssistantReply,
        generateProactiveReply, generateDualHeadProactiveReply } = require('./assistant/generate');
const { shouldUseDualHeadDirectedMode } = require('./assistant/dual-head');
const { clearAssistantContext } = require('./assistant/context');

module.exports = {
  generateAssistantReply,
  generateStreamingAssistantReply,
  generateProactiveReply,
  generateDualHeadProactiveReply,
  shouldUseDualHeadDirectedMode,
  clearAssistantContext,
};
