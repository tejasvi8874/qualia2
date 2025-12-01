const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.resolverMainFields = ['react-native', 'browser', 'main'];
config.resolver.assetExts.push('html', 'bundle');

module.exports = config;
