import type { Profile } from "./types";
import { validProfile } from "./utils";

export function environmentProfile(): Profile | null {
  const profile: Profile = {
    id: import.meta.env.VITE_MOBILE_PROVIDER_ID || "",
    revision: Number(import.meta.env.VITE_MOBILE_PROFILE_REVISION),
    name: import.meta.env.VITE_MOBILE_MODEL_LABEL || "",
    model: import.meta.env.VITE_MOBILE_MODEL_LABEL || "",
    cloud: import.meta.env.VITE_MOBILE_PROVIDER_CLOUD !== "0",
    engine:
      import.meta.env.VITE_MOBILE_ENGINE === "pi" ? "pi" : "deepseek-harness",
  };
  return validProfile(profile) ? profile : null;
}
