"use client";

import { Contrast, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { ESBLA_THEME_MODES, ESBLA_THEME_STORAGE_KEY, type EsblaThemeMode } from "./theme-contract";

const controls = [
  { icon: Sun, label: "Light theme", mode: "light" },
  { icon: Moon, label: "Dark theme", mode: "dark" },
  { icon: Contrast, label: "High contrast theme", mode: "high-contrast" },
] as const;

function currentDocumentMode(): EsblaThemeMode {
  const mode = document.documentElement.dataset.theme;
  return ESBLA_THEME_MODES.includes(mode as EsblaThemeMode) ? (mode as EsblaThemeMode) : "light";
}

export function ThemeModeControl() {
  const [mode, setMode] = useState<EsblaThemeMode>("light");

  useEffect(() => setMode(currentDocumentMode()), []);

  function selectMode(nextMode: EsblaThemeMode) {
    document.documentElement.dataset.theme = nextMode;
    document.documentElement.style.colorScheme = nextMode === "dark" ? "dark" : "light";
    localStorage.setItem(ESBLA_THEME_STORAGE_KEY, nextMode);
    setMode(nextMode);
  }

  return (
    <fieldset className="theme-mode-control">
      <legend className="visually-hidden">Theme mode</legend>
      {controls.map(({ icon: Icon, label, mode: option }) => (
        <button
          aria-label={label}
          aria-pressed={mode === option}
          className="chrome-button"
          data-theme-mode={option}
          key={option}
          onClick={() => selectMode(option)}
          title={label}
          type="button"
        >
          <Icon aria-hidden="true" size={18} strokeWidth={1.75} />
        </button>
      ))}
    </fieldset>
  );
}
