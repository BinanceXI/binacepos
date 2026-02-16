declare module "capacitor-fingerprint-auth" {
  const FingerprintAuth: {
    isAvailable: () => Promise<boolean>;
    verify: (options?: {
      reason?: string;
      title?: string;
      subtitle?: string;
      description?: string;
    }) => Promise<boolean>;
  };
  export default FingerprintAuth;
}