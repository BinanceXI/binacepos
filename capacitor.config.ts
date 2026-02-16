import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.binancexi.pos',
  appName: 'BinanceXI POS',
  webDir: 'dist',

  android: {
    allowMixedContent: true,
    backgroundColor: '#ffffff',
    adjustResize: true
  }
};

export default config;
