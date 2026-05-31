import { Monitor, Moon, Sun } from "lucide-react";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "hoot_theme";

function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    // localStorage unavailable (e.g. private mode / disabled) — fall back to system.
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Reflect the chosen theme onto the <html> element's `dark` class. */
function applyTheme(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  // Persist the choice and keep the <html> class in sync.
  useEffect(() => {
    applyTheme(theme);
    try {
      if (theme === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable — the preference simply won't persist this session.
    }
  }, [theme]);

  // While following the OS, react to live changes in its preference.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}

const OPTIONS: { value: Theme; label: string; Icon: ComponentType<{ className?: string }> }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "system", label: "System", Icon: Monitor },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** Three-way segmented control: light / system / dark. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="toolbar"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/60 p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            data-testid={`theme-${value}`}
            onClick={() => setTheme(value)}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
              active
                ? "bg-card text-primary shadow-sm ring-1 ring-border"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
          </button>
        );
      })}
    </div>
  );
}
