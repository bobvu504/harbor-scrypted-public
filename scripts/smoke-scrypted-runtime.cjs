'use strict';

const fs = require('node:fs');
const Module = require('node:module');

const runtimeId = '/virtual/scrypted-0.143-runtime';
const originalLoad = Module._load;
const originalReadFileSync = fs.readFileSync;
const deviceState = {};
const discoveredNativeIds = new Set();
const storageByNativeId = new Map();
const existingSerial = '2400000009';
discoveredNativeIds.add(existingSerial);
storageByNativeId.set(existingSerial, new Map([
  ['token', 'b'.repeat(64)],
  ['height', '720'],
  ['audio', 'true'],
  ['name', 'Existing Camera'],
  ['protectEnabled', 'true'],
  ['protectPassword', 'legacy-password'],
]));

function getStorage(nativeId) {
  const key = nativeId === undefined ? '__plugin__' : nativeId;
  if (nativeId !== undefined && !discoveredNativeIds.has(nativeId))
    throw new Error(`storage requested before discovery: ${nativeId}`);
  let values = storageByNativeId.get(key);
  if (!values) {
    values = new Map();
    storageByNativeId.set(key, values);
  }
  return {
    getItem: name => values.get(name),
    setItem: (name, value) => values.set(name, String(value)),
    removeItem: name => values.delete(name),
  };
}

const sdkStatic = {
  deviceManager: {
    getNativeIds: () => [undefined, ...discoveredNativeIds],
    getDeviceState: () => deviceState,
    getDeviceStorage: getStorage,
    getDeviceLogger: () => console,
    getDeviceConsole: () => console,
    onDeviceEvent: async () => undefined,
    onDeviceDiscovered: async device => {
      if (!device?.nativeId)
        throw new Error('Discovered device is missing a nativeId.');
      discoveredNativeIds.add(device.nativeId);
      return device.nativeId;
    },
  },
  endpointManager: {},
  mediaManager: {
    getFilesPath: async () => {
      throw new Error('simulation stop');
    },
  },
  systemManager: {
    setScryptedInterfaceDescriptors: async () => undefined,
  },
  pluginHostAPI: {},
};

Module._load = function loadRuntime(request, parent, isMain) {
  if (request === runtimeId)
    return { getScryptedStatic: () => sdkStatic };
  return originalLoad.call(this, request, parent, isMain);
};
fs.readFileSync = function readSdkJson(filename, ...args) {
  if (filename === '../sdk.json')
    return Buffer.from('{"version":"0.5.59"}');
  return originalReadFileSync.call(this, filename, ...args);
};
process.env.SCRYPTED_SDK_MODULE = runtimeId;
process.env.SCRYPTED_SDK_CJS_MODULE = runtimeId;

const plugin = require('../out/main.nodejs.js');
if (typeof plugin.default !== 'function')
  throw new Error('Plugin default export is unavailable.');

const provider = new plugin.default();
if (!provider || provider.bridgeStatus !== 'Starting')
  throw new Error('Harbor provider did not initialize.');
if ([...storageByNativeId.get(existingSerial).keys()].some(key => key.startsWith('protect')))
  throw new Error('Legacy adapter settings were not removed during provider startup.');

setImmediate(async () => {
  if (!String(provider.bridgeStatus).startsWith('Error: simulation stop'))
    throw new Error(`Unexpected bridge state: ${provider.bridgeStatus}`);

  provider.restartBridge = async () => undefined;
  const serial = '2400000000';
  const token = 'a'.repeat(64);
  const created = await provider.createDevice({
    name: 'Smoke Test Camera',
    serial,
    token,
    height: '720',
    audio: true,
  });
  if (created !== serial || !discoveredNativeIds.has(serial))
    throw new Error('Harbor camera was not discovered.');
  const cameraStorage = getStorage(serial);
  if (cameraStorage.getItem('token') !== token
      || cameraStorage.getItem('height') !== '720'
      || cameraStorage.getItem('audio') !== 'true')
    throw new Error('Harbor camera settings were not stored after discovery.');
  if (storageByNativeId.get(serial)?.size !== 4)
    throw new Error('Unexpected camera settings were stored after discovery.');

  const networkTested = await exerciseWhipListener(provider, serial, token);

  console.log('Scrypted 0.143 SDK injection, provider startup, and camera creation passed.');
  if (networkTested)
    console.log('WHIP listener SDP round trip, token gate, and session rewrite passed.');
  else
    console.warn('WHIP listener network smoke test skipped because this build environment forbids local sockets.');
});

function assert(condition, message) {
  if (!condition)
    throw new Error(message);
}

/**
 * End-to-end check of the dedicated WHIP listener against a fake go2rtc.
 *
 * This is the regression guard for the two defects that made Harbor publishing
 * impossible: the endpoint used to resolve to a camera device that Scrypted
 * refused to route, and Scrypted's bodyParser.text() replaced the
 * application/sdp offer with "{}" before it ever reached go2rtc.
 */
async function exerciseWhipListener(provider, serial, token) {
  const http = require('node:http');

  const OFFER = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
  const ANSWER = 'v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nm=video 18555 UDP/TLS/RTP/SAVPF 96\r\n';
  const received = [];

  const go2rtc = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (request.method === 'POST') {
        response.writeHead(201, {
          'Content-Type': 'application/sdp',
          // Match go2rtc v1.9.14's real relative Location header.
          Location: 'webrtc?id=session-1234',
        });
        response.end(ANSWER);
        return;
      }
      response.writeHead(204);
      response.end();
    });
  });
  try {
    await listenLocal(go2rtc);
  }
  catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES')
      return false;
    throw error;
  }
  const apiPort = go2rtc.address().port;

  // parsePort rejects 0, so reserve a real ephemeral port instead of binding the
  // production default and risking a collision on the build machine.
  const probe = http.createServer();
  await listenLocal(probe);
  const whipPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const pluginStorage = getStorage(undefined);
  pluginStorage.setItem('apiPort', String(apiPort));
  pluginStorage.setItem('whipPort', String(whipPort));
  pluginStorage.setItem('advertisedAddress', '127.0.0.1');

  provider.bridgeStatus = 'Running';
  provider.ensureBridgeReady = async () => undefined;

  await provider.ensureWhipServer();
  assert(provider.whipServer.address().port === whipPort, 'WHIP listener bound an unexpected port.');

  const base = `http://127.0.0.1:${whipPort}/whip`;

  try {
    const publish = await fetch(`${base}?dst=${serial}&token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: OFFER,
    });
    assert(publish.status === 201, `WHIP publish returned ${publish.status}`);
    assert(await publish.text() === ANSWER, 'WHIP publish did not return the go2rtc answer.');
    assert(publish.headers.get('content-type') === 'application/sdp', 'WHIP answer lost its content type.');

    assert(received.length === 1, 'go2rtc did not receive the publish request.');
    assert(received[0].body === OFFER, `go2rtc received a corrupted SDP offer: ${JSON.stringify(received[0].body)}`);
    assert(received[0].contentType === 'application/sdp', 'go2rtc received the wrong content type.');
    assert(received[0].url === `/api/webrtc?dst=${serial}`, `go2rtc received ${received[0].url}`);

    const location = publish.headers.get('location');
    assert(!!location, 'WHIP publish did not return a session Location.');
    const session = new URL(location);
    assert(session.host === `127.0.0.1:${whipPort}`, `Location points off-host: ${location}`);
    assert(session.pathname === '/whip', `Location has the wrong path: ${location}`);
    assert(!!session.searchParams.get('session'), 'Location is missing an opaque session.');

    const teardown = await fetch(location, { method: 'DELETE' });
    assert(teardown.status === 204, `WHIP teardown returned ${teardown.status}`);
    assert(received.length === 2 && received[1].url === '/api/webrtc?id=session-1234',
      `WHIP teardown reached the wrong go2rtc path: ${received[1] && received[1].url}`);

    const badToken = await fetch(`${base}?dst=${serial}&token=${'b'.repeat(64)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: OFFER,
    });
    assert(badToken.status === 401, `A replaced token returned ${badToken.status}`);

    const unknownSerial = await fetch(`${base}?dst=9999999999&token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: OFFER,
    });
    assert(unknownSerial.status === 401, `An unknown serial returned ${unknownSerial.status}`);

    const wrongMethod = await fetch(`${base}?dst=${serial}&token=${token}`);
    assert(wrongMethod.status === 405, `GET returned ${wrongMethod.status}`);

    const wrongPath = await fetch(`http://127.0.0.1:${whipPort}/api/webrtc?dst=${serial}&token=${token}`, {
      method: 'POST',
      body: OFFER,
    });
    assert(wrongPath.status === 404, `An unknown path returned ${wrongPath.status}`);

    assert(received.length === 2, 'A rejected request was forwarded to go2rtc.');
  }
  finally {
    await new Promise(resolve => provider.whipServer.close(resolve));
    await new Promise(resolve => go2rtc.close(resolve));
  }
  return true;
}

function listenLocal(server) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}
