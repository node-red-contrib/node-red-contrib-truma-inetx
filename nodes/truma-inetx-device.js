// All config nodes and editor operations share the radio without overlapping sessions.
let bluetoothQueue = Promise.resolve();
function withBluetooth(operation) {
  const run = bluetoothQueue.then(operation);
  bluetoothQueue = run.catch(() => {});
  return run;
}

module.exports = function registerTrumaDeviceNode(RED) {
  const loadLibrary = async () => import('../dist/index.js');

  function TrumaInetXDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.bluetooth = config.bluetooth || 'auto';
    node.adapter = (config.adapter || '').trim();
    node.timeZone = (config.timeZone || '').trim();
    node.targetMode = config.targetMode || (config.deviceName || config.deviceAddress ? 'device' : 'first');
    node.deviceName = config.deviceName || '';
    node.deviceAddress = config.deviceAddress || '';
    node.tree = null;
    node.queue = Promise.resolve();

    node.logDebug = () => {};

    node.loadLibrary = loadLibrary;

    node.requireTarget = () => {
      if (node.targetMode === 'none') throw new Error('No Truma device selected. Search and select a device in its configuration, then deploy.');
    };
    node.connectOptions = () => {
      node.requireTarget();
      return {
        bluetooth: node.bluetooth,
        ...(node.adapter ? { adapter: node.adapter } : {}),
        ...(node.timeZone ? { protocol: { timeZone: node.timeZone } } : {}),
        ...(node.targetMode === 'device' && node.deviceName ? { deviceName: node.deviceName } : {}),
        ...(node.targetMode === 'device' && node.deviceAddress ? { deviceAddress: node.deviceAddress } : {})
      };
    };

    node.updateReadyStatus = () => {
      const topics = topicNames(node.tree);
      const suffix = topics.length ? `${topics.length} topic${topics.length === 1 ? '' : 's'}` : 'no topics';
      const device = node.deviceName || node.deviceAddress;
      node.status({ fill: 'green', shape: 'dot', text: device ? `${device}: ${suffix}` : suffix });
    };

    node.refreshTreeNow = async () => {
      node.requireTarget();
      node.status({ fill: 'yellow', shape: 'ring', text: 'discovering' });
      const truma = await node.loadLibrary();
      const discovered = await withBluetooth(() => truma.discover({
        ...node.connectOptions(),
        topologyOnly: true,
        logger: (message) => node.logDebug(message)
      }));
      node.tree = mergeTrees(node.tree, discovered);
      node.updateReadyStatus();
      return node.tree;
    };

    if (node.targetMode === 'none') node.status({ fill: 'grey', shape: 'ring', text: 'no device selected' });
    node.ready = node.targetMode === 'none' ? Promise.resolve(null) : node.refreshTreeNow().catch((error) => {
      node.status({ fill: 'red', shape: 'ring', text: 'discover failed' });
      node.error(error);
      return null;
    });

    node.enqueue = async (operation) => {
      const run = node.queue.then(async () => {
        await node.ready;
        node.requireTarget();
        const truma = await node.loadLibrary();
        return withBluetooth(() => operation(truma, node.tree));
      });
      node.queue = run.catch(() => {});
      return run;
    };

    node.refreshTree = async () => {
      const run = node.queue.then(async () => {
        await node.ready;
        return node.refreshTreeNow();
      });
      node.queue = run.catch(() => {});
      return run;
    };

    node.mergeTree = (tree) => {
      node.tree = mergeTrees(node.tree, tree);
      node.updateReadyStatus();
      return node.tree;
    };

    node.topicNames = () => topicNames(node.tree);

    node.missingTopics = (topics) => {
      if (!Array.isArray(topics) || topics.length === 0) return [];
      return topics.filter((topic) => !hasReadableTopic(node.tree, topic));
    };

    node.ensureTopics = async (topics) => {
      await node.ready;
      // get() locates missing topic groups in its own connection. A full refresh
      // here probes unrelated devices and opens an unnecessary extra connection.
      return node.missingTopics(topics);
    };

    node.groupsForTopics = (topics) => {
      if (!node.tree || !Array.isArray(topics) || topics.length === 0) return undefined;
      const groups = new Set();
      for (const topic of topics) {
        for (const group of readTopicGroups(node.tree, topic)) groups.add(group);
      }
      return groups.size ? [...groups].sort((left, right) => left - right) : undefined;
    };

    node.groupForTopic = async (topic) => {
      await node.ready;
      if (!hasReadableTopic(node.tree, topic)) {
        const result = await node.enqueue((truma) => truma.get({
          ...node.connectOptions(),
          topics: [topic],
          logger: (message) => node.logDebug(message)
        }));
        node.mergeTree(result);
      }
      if (!node.tree) throw new Error('Truma tree is not available yet.');
      const groups = readTopicGroups(node.tree, topic);
      if (groups.length === 0) throw new Error(`Could not infer a group for topic ${topic}.`);
      if (groups.length > 1) throw new Error(`Topic ${topic} has multiple groups; provide msg.payload.group.`);
      return groups[0];
    };

    node.on('close', (_removed, done) => {
      node.loadLibrary()
        .then((truma) => withBluetooth(() => truma.shutdownBluetooth()))
        .catch(() => {})
        .finally(done);
    });
  }

  RED.nodes.registerType('truma-inetx-device', TrumaInetXDeviceNode);

  const readPermission = RED.auth?.needsPermission ? RED.auth.needsPermission('flows.read') : (_req, _res, next) => next();
  const writePermission = RED.auth?.needsPermission ? RED.auth.needsPermission('flows.write') : (_req, _res, next) => next();

  RED.httpAdmin.get('/truma-inetx/devices', readPermission, async (req, res) => {
    try {
      const truma = await loadLibrary();
      const devices = await withBluetooth(() => truma.discoverTrumaDevices({
        bluetooth: normalizeBluetooth(req.query.bluetooth),
        adapter: typeof req.query.adapter === 'string' ? req.query.adapter.trim() || undefined : undefined
      }));
      res.json(devices);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  RED.httpAdmin.get('/truma-inetx/adapters', readPermission, async (_req, res) => {
    try {
      const truma = await loadLibrary();
      res.json(await truma.discoverBluetoothAdapters());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Use the editor's current selection, including before the config node is deployed.
  RED.httpAdmin.post('/truma-inetx/pair', writePermission, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.deviceAddress !== 'string' || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(body.deviceAddress)) {
        res.status(400).json({ error: 'Search and select a specific Truma device before pairing.' });
        return;
      }
      const truma = await loadLibrary();
      const passkey = body.passkey === '' ? undefined : body.passkey;
      try { truma.validatePairingCode(passkey); }
      catch (error) { res.status(400).json({ error: error.message }); return; }
      const result = await withBluetooth(() => truma.pair({
        bluetooth: 'bluez',
        adapter: typeof body.adapter === 'string' ? body.adapter.trim() || undefined : undefined,
        deviceAddress: body.deviceAddress,
        passkey,
        // The editor must not change controller-wide pairing settings.
        linuxLegacyPairing: false,
        linuxLegacyPowerCycle: false,
        linuxDisablePrivacy: false,
        holdMs: 0
      }));
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  RED.httpAdmin.post('/truma-inetx/unpair', writePermission, async (req, res) => {
    try {
      const body = req.body || {};
      const truma = await loadLibrary();
      const options = { adapter: body.adapter, deviceAddress: body.deviceAddress };
      try { truma.validateUnpairOptions(options); }
      catch (error) { res.status(400).json({ error: error.message }); return; }
      res.json(await withBluetooth(() => truma.unpair(options)));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  RED.httpAdmin.get('/truma-inetx/device/:id/topics', readPermission, async (req, res) => {
    const node = RED.nodes.getNode(req.params.id);
    if (!node || typeof node.topicNames !== 'function') {
      res.json([]);
      return;
    }
    res.json(node.topicNames());
  });

  const refreshTreeHandler = async (req, res) => {
    const node = RED.nodes.getNode(req.params.id);
    if (!node || typeof node.refreshTree !== 'function') {
      res.status(404).json({ error: 'Truma device node is not deployed.' });
      return;
    }
    try {
      const tree = await node.refreshTree();
      res.json({ topics: node.topicNames(), diagnostics: tree?.diagnostics || {} });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  };

  RED.httpAdmin.get('/truma-inetx/device/:id/tree', writePermission, refreshTreeHandler);
  RED.httpAdmin.post('/truma-inetx/device/:id/tree', writePermission, refreshTreeHandler);
};

function readTopicGroups(tree, topicName) {
  if (!tree) return [];
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

function hasReadableTopic(tree, topicName) {
  return readTopicGroups(tree, topicName).length > 0;
}

function topicNames(tree) {
  if (!tree) return [];
  return [...new Set([...Object.keys(tree.topics || {}), ...(tree.topicLists || [])])].sort();
}

function mergeTrees(current, incoming) {
  if (!current) return cloneTree(incoming);
  if (!incoming) return cloneTree(current);

  const topics = { ...(current.topics || {}) };
  for (const [topicName, incomingTopic] of Object.entries(incoming.topics || {})) {
    const existingTopic = topics[topicName] || {};
    topics[topicName] = {
      ...existingTopic,
      ...incomingTopic,
      ...(existingTopic.group && !incomingTopic.group ? { group: existingTopic.group } : {}),
      groups: mergeStringLists(existingTopic.groups, incomingTopic.groups),
      parameters: mergeParameters(existingTopic.parameters, incomingTopic.parameters)
    };
    if (!topics[topicName].groups?.length) delete topics[topicName].groups;
  }

  const diagnostics = mergeDiagnostics(current.diagnostics, incoming.diagnostics);
  const merged = {
    topics,
    topicLists: mergeStringLists(current.topicLists, incoming.topicLists),
    diagnostics
  };
  merged.diagnostics.unreadTopics = merged.topicLists.filter((topicName) => !merged.diagnostics.topicGroups[topicName]?.length);
  const readGroups = new Set(Object.values(merged.diagnostics.topicGroups).flat());
  merged.diagnostics.unreadDeviceGroups = merged.diagnostics.deviceGroups.filter((group) => !readGroups.has(group));
  return merged;
}

function cloneTree(tree) {
  return tree ? JSON.parse(JSON.stringify(tree)) : null;
}

function mergeDiagnostics(current = {}, incoming = {}) {
  const topicGroups = { ...(current.topicGroups || {}) };
  for (const [topicName, groups] of Object.entries(incoming.topicGroups || {})) {
    topicGroups[topicName] = mergeStringLists(topicGroups[topicName], groups);
  }
  return {
    ...current,
    ...incoming,
    topicGroups,
    unreadTopics: mergeStringLists(current.unreadTopics, incoming.unreadTopics),
    deviceGroups: mergeStringLists(current.deviceGroups, incoming.deviceGroups),
    unreadDeviceGroups: mergeStringLists(current.unreadDeviceGroups, incoming.unreadDeviceGroups)
  };
}

function mergeStringLists(left, right) {
  return [...new Set([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])].filter(Boolean))].sort();
}

function normalizeBluetooth(value) {
  return value === 'bluez' || value === 'noble' || value === 'auto' ? value : 'auto';
}

function mergeParameters(current = {}, incoming = {}) {
  const merged = { ...current };
  for (const [name, parameter] of Object.entries(incoming)) {
    merged[name] = { ...current[name], ...parameter };
  }
  return merged;
}
