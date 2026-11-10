/** Source-free observation of configuration, not a rendered page or paragraph role. */
export type PageNumberControl =
  | { state: 'present'; count: number }
  | { state: 'absent'; count: 0 }
  | { state: 'unknown'; count: null };
export type PageNumberControls = Record<string, PageNumberControl>;
