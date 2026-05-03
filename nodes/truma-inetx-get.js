module.exports = function registerTrumaGetNode(RED) {
  function TrumaInetXGetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.device = RED.nodes.getNode(config.device);
    node.topics = splitTopics(config.topics);

    node.on('input', async (msg, send, done) => {
      const emit = send || ((message) => node.send(message));
      try {
        if (!node.device) throw new Error('Truma iNet X device node is not configured.');
        const override = normalizePayload(msg.payload);
        const topics = override.topics ?? node.topics;
        const result = await node.device.enqueue((truma) =>
          truma.get({
            bluetooth: node.device.bluetooth,
            logger: (message) => node.device.logDebug(message),
            ...(topics.length ? { topics, groups: node.device.groupsForTopics(topics) } : {})
          })
        );
        msg.payload = result;
        emit(msg);
        done?.();
      } catch (error) {
        done ? done(error) : node.error(error, msg);
      }
    });
  }

  RED.nodes.registerType('truma-inetx-get', TrumaInetXGetNode);
};

function normalizePayload(payload) {
  if (Array.isArray(payload)) return { topics: payload.map(String).filter(Boolean) };
  if (typeof payload === 'string') return { topics: splitTopics(payload) };
  if (payload && typeof payload === 'object' && payload.topics !== undefined) {
    return { topics: Array.isArray(payload.topics) ? payload.topics.map(String).filter(Boolean) : splitTopics(String(payload.topics)) };
  }
  return {};
}

function splitTopics(value) {
  return String(value || '')
    .split(',')
    .map((topic) => topic.trim())
    .filter(Boolean);
}
