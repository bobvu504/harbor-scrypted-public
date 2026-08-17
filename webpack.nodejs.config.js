'use strict';

const path = require('node:path');

const defaultConfigPath = process.env.SCRYPTED_DEFAULT_WEBPACK_CONFIG;
if (!defaultConfigPath)
  throw new Error('Scrypted did not provide its default Webpack configuration.');

const config = require(defaultConfigPath);
const sdkEntry = require.resolve('@scrypted/sdk');

config.module.rules.unshift({
  include: sdkEntry,
  enforce: 'pre',
  use: [{
    loader: path.resolve(__dirname, 'scripts/fix-scrypted-sdk-loader.cjs'),
  }],
});

module.exports = config;
