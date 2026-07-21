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
  signupMode?: "public" | "waitlist";
  suspended?: boolean;
  user?: RuntimeUser | null;
}
