module.exports = function registerTrumaSetNode(RED) {
  function TrumaInetXSetNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.device = RED.nodes.getNode(config.device);
    node.topic = config.topic;
    node.parameter = config.parameter;
    node.value = config.value;

    node.on('input', async (msg, send, done) => {
      const emit = send || ((message) => node.send(message));
      try {
        if (!node.device) throw new Error('Truma iNet X device node is not configured.');
        const override = normalizePayload(msg.payload);
        const topic = override.topic ?? node.topic;
        const parameter = override.parameter ?? node.parameter;
        const value = override.value ?? parseSetValue(node.value);
        if (!topic) throw new Error('No Truma topic configured.');
        if (!parameter) throw new Error('No Truma parameter configured.');
        const targetGroup = override.group ?? node.device.groupForTopic(topic);
        const result = await node.device.enqueue((truma) =>
          truma.set({
            bluetooth: node.device.bluetooth,
            logger: (message) => node.device.logDebug(message),
            targetGroup,
            topic,
            parameter,
            value
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

  RED.nodes.registerType('truma-inetx-set', TrumaInetXSetNode);
};

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { value: payload };
  const parameter = payload.parameter ?? payload.param;
  return {
    topic: payload.topic ? String(payload.topic) : undefined,
    parameter: parameter === undefined ? undefined : String(parameter),
    value: payload.value,
    group: payload.group === undefined ? undefined : parseGroup(payload.group)
  };
}

function parseSetValue(value) {
  const normalized = String(value ?? '').trim();
  if (/^(on|true)$/i.test(normalized)) return 1;
  if (/^(off|false)$/i.test(normalized)) return 0;
  if (/^null$/i.test(normalized)) return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  if (/^(?:".*"|\[.*\]|\{.*\})$/.test(normalized)) return JSON.parse(normalized);
  return normalized;
}

function parseGroup(value) {
  const text = String(value);
  const normalized = text.toLowerCase().startsWith('0x') ? text.slice(2) : text;
  if (!/^[0-9a-f]{1,4}$/i.test(normalized)) throw new Error(`Invalid Truma group: ${text}`);
  return Number.parseInt(normalized, 16);
}
