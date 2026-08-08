import { create } from "zustand";
import { currentTheme, currentAccent, setTheme as applyTheme, setAccent as applyAccent, type Theme, type Accent } from "../theme";

interface SettingsStore {
  theme: Theme;
  accent: Accent;
  daemonUrl: string;
  nodeMode: "remote" | "custom" | "local";

  setTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
  setDaemonUrl: (url: string) => void;
  setNodeMode: (mode: "remote" | "custom" | "local") => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  theme: currentTheme(),
  accent: currentAccent(),
  daemonUrl: "",
  nodeMode: "remote",

  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
  },
  setAccent: (a) => {
    applyAccent(a);
    set({ accent: a });
  },
  setDaemonUrl: (url) => set({ daemonUrl: url }),
  setNodeMode: (mode) => set({ nodeMode: mode }),
}));
