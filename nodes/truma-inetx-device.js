module.exports = function registerTrumaDeviceNode(RED) {
  function TrumaInetXDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.bluetooth = config.bluetooth || 'auto';
    node.debugEnabled = !!config.debug;
    node.tree = null;
    node.queue = Promise.resolve();

    node.logDebug = (message) => {
      if (node.debugEnabled) node.debug(`[truma-debug] ${message}`);
    };

    node.loadLibrary = async () => import('../dist/index.js');

    node.refreshTree = async () => {
      const truma = await node.loadLibrary();
      node.status({ fill: 'yellow', shape: 'ring', text: 'discovering' });
      node.tree = await truma.discover({
        bluetooth: node.bluetooth,
        logger: (message) => node.logDebug(message)
      });
      node.status({ fill: 'green', shape: 'dot', text: 'ready' });
      return node.tree;
    };

    node.ready = node.refreshTree().catch((error) => {
      node.status({ fill: 'red', shape: 'ring', text: 'discover failed' });
      node.error(error);
      throw error;
    });

    node.enqueue = async (operation) => {
      const run = node.queue.then(async () => {
        await node.ready;
        const truma = await node.loadLibrary();
        return operation(truma, node.tree);
      });
      node.queue = run.catch(() => {});
      return run;
    };

    node.groupsForTopics = (topics) => {
      if (!node.tree || !Array.isArray(topics) || topics.length === 0) return undefined;
      const groups = new Set();
      for (const topic of topics) {
        for (const group of readTopicGroups(node.tree, topic)) groups.add(group);
      }
      return groups.size ? [...groups].sort((left, right) => left - right) : undefined;
    };

    node.groupForTopic = (topic) => {
      if (!node.tree) throw new Error('Truma tree is not available yet.');
      const groups = readTopicGroups(node.tree, topic);
      if (groups.length === 0) throw new Error(`Could not infer a group for topic ${topic}.`);
      if (groups.length > 1) throw new Error(`Topic ${topic} has multiple groups; provide msg.payload.group.`);
      return groups[0];
    };

    node.on('close', (_removed, done) => {
      node.loadLibrary()
        .then((truma) => truma.shutdownBluetooth())
        .catch(() => {})
        .finally(done);
    });
  }

  RED.nodes.registerType('truma-inetx-device', TrumaInetXDeviceNode);
};

function readTopicGroups(tree, topicName) {
  const topic = tree.topics?.[topicName];
  const groups = new Set();
  if (topic?.group) groups.add(parseGroup(topic.group));
  if (Array.isArray(topic?.groups)) {
    for (const group of topic.groups) groups.add(parseGroup(group));
  }
  const diagnosticGroups = tree.diagnostics?.topicGroups?.[topicName];
  if (Array.isArray(diagnosticGroups)) {
    for (const group of diagnosticGroups) groups.add(parseGroup(group));
  }
  return [...groups].sort((left, right) => left - right);
}

function parseGroup(value) {
  const text = String(value);
  const normalized = text.toLowerCase().startsWith('0x') ? text.slice(2) : text;
  if (!/^[0-9a-f]{1,4}$/i.test(normalized)) throw new Error(`Invalid Truma group: ${text}`);
  return Number.parseInt(normalized, 16);
}
