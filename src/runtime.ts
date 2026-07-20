export interface RuntimeUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
}
export interface RuntimeInfo {
  mode: "local" | "hosted";
  authenticated: boolean;
  localProviderEnabled: boolean;
  user?: RuntimeUser | null;
}
