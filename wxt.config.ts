import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    short_name: 'CleanSlate',
    homepage_url: 'https://github.com/Rianvy/CleanSlate-for-Reddit',
    default_locale: 'en',
    host_permissions: ['https://*.reddit.com/*'],
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    action: {
      default_title: '__MSG_extName__',
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
      },
    },
    browser_specific_settings: {
      gecko: {
        id: 'cleanslate-for-reddit@local-first.dev',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
  },
});
