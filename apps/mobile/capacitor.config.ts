import type { CapacitorConfig } from '@capacitor/cli';

// The owner's app: the cabinet (apps/cloud-web) built into www/ by vite, the cloud address
// is set in the app (login screen / QR), not here.
const config: CapacitorConfig = {
  appId: 'kz.ts.owner',
  appName: 'TS',
  webDir: 'www',
  android: {
    // Release builds talk to the cloud over HTTPS only; debug builds may use http:// on the LAN
    // (res/xml/network_security_config.xml in src/debug).
    allowMixedContent: false,
  },
  plugins: {
    // Native HTTP: no CORS preflight from the WebView and http:// clouds work in debug builds.
    CapacitorHttp: { enabled: true },
    SplashScreen: { launchShowDuration: 600, backgroundColor: '#14211b', showSpinner: false },
    FirebaseMessaging: { presentationOptions: ['alert', 'sound', 'badge'] },
  },
};

export default config;
