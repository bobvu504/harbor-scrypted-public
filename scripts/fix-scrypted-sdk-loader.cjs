'use strict';

/**
 * Webpack 5 rewrites top-level CommonJS SDK exports but can leave references
 * inside the SDK initializer pointing at the outer plugin export object. Keep
 * one stable local SDK object while preserving the SDK's public exports.
 */
module.exports = function fixScryptedSdkLoader(source) {
  const localSdk = '__harborScryptedSdkCompat';
  const expected = [
    'Object.defineProperty(exports, "__esModule", { value: true });',
    'exports.sdk = exports.MixinDeviceBase = exports.ScryptedDeviceBase = void 0;',
    '__exportStar(require("../types/gen/index"), exports);',
    'exports.ScryptedDeviceBase = ScryptedDeviceBase;',
    'exports.MixinDeviceBase = MixinDeviceBase;',
    'exports.sdk = {};',
    'exports.default = exports.sdk;',
  ];

  if (expected.some(fragment => !source.includes(fragment)))
    throw new Error('Unsupported @scrypted/sdk loader shape; update the Harbor compatibility transform.');

  let patched = source
    .replace(expected[0], '')
    .replace(expected[1], '')
    .replace(expected[2], 'export * from "../types/gen/index";')
    .replace(expected[3], 'export { ScryptedDeviceBase };')
    .replace(expected[4], 'export { MixinDeviceBase };');
  patched = patched.replace(
    expected[5],
    `const ${localSdk} = {};\nexport { ${localSdk} as sdk };`,
  );
  patched = patched.replace(/exports\.sdk/g, localSdk);
  patched = patched.replace(
    expected[6].replace('exports.sdk', localSdk),
    `export default ${localSdk};`,
  );

  if (/exports\.(sdk|default|ScryptedDeviceBase|MixinDeviceBase)/.test(patched)
      || !patched.includes(`export default ${localSdk};`))
    throw new Error('Failed to isolate the @scrypted/sdk runtime object.');

  return patched;
};
