"use client";

import { Button } from "@/components/ui/button";
import { SettingsRow, SettingsSection } from "@/components/settings-layout";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type FontKey, fontOptions } from "@/lib/fonts/registry";
import type { ContentLayout, NavbarStyle } from "@/lib/preferences/layout";
import {
  applyContentLayout,
  applyFont,
  applyNavbarStyle,
} from "@/lib/preferences/layout-utils";
import { PREFERENCE_DEFAULTS } from "@/lib/preferences/preferences-config";
import { persistPreference } from "@/lib/preferences/preferences-storage";
import { THEME_PRESET_OPTIONS, type ThemeMode, type ThemePreset } from "@/lib/preferences/theme";
import { applyThemePreset } from "@/lib/preferences/theme-utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

export function AppearancePreferences() {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const resolvedThemeMode = usePreferencesStore((s) => s.resolvedThemeMode);
  const setThemeMode = usePreferencesStore((s) => s.setThemeMode);
  const themePreset = usePreferencesStore((s) => s.themePreset);
  const setThemePreset = usePreferencesStore((s) => s.setThemePreset);
  const contentLayout = usePreferencesStore((s) => s.contentLayout);
  const setContentLayout = usePreferencesStore((s) => s.setContentLayout);
  const navbarStyle = usePreferencesStore((s) => s.navbarStyle);
  const setNavbarStyle = usePreferencesStore((s) => s.setNavbarStyle);
  const font = usePreferencesStore((s) => s.font);
  const setFont = usePreferencesStore((s) => s.setFont);

  const onThemePresetChange = (preset: ThemePreset) => {
    applyThemePreset(preset);
    setThemePreset(preset);
    void persistPreference("theme_preset", preset);
  };

  const onThemeModeChange = (mode: ThemeMode | "") => {
    if (!mode) return;
    setThemeMode(mode);
    void persistPreference("theme_mode", mode);
  };

  const onContentLayoutChange = (layout: ContentLayout | "") => {
    if (!layout) return;
    applyContentLayout(layout);
    setContentLayout(layout);
    void persistPreference("content_layout", layout);
  };

  const onNavbarStyleChange = (style: NavbarStyle | "") => {
    if (!style) return;
    applyNavbarStyle(style);
    setNavbarStyle(style);
    void persistPreference("navbar_style", style);
  };

  const onFontChange = (value: FontKey | "") => {
    if (!value) return;
    applyFont(value);
    setFont(value);
    void persistPreference("font", value);
  };

  const handleRestore = () => {
    onThemePresetChange(PREFERENCE_DEFAULTS.theme_preset);
    onThemeModeChange(PREFERENCE_DEFAULTS.theme_mode);
    onContentLayoutChange(PREFERENCE_DEFAULTS.content_layout);
    onNavbarStyleChange(PREFERENCE_DEFAULTS.navbar_style);
    onFontChange(PREFERENCE_DEFAULTS.font);
  };

  return (
    <SettingsSection title="Display and Layout">
        <SettingsRow title="Theme style" htmlFor="appearance-theme">
          <Select value={themePreset} onValueChange={onThemePresetChange}>
            <SelectTrigger id="appearance-theme" size="sm" className="w-full text-xs">
              <SelectValue placeholder="Select style" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {THEME_PRESET_OPTIONS.map((preset) => (
                  <SelectItem key={preset.value} className="text-xs" value={preset.value}>
                    <span
                      className="size-2.5 rounded-full"
                      style={{
                        backgroundColor:
                          (resolvedThemeMode ?? "light") === "dark" ? preset.primary.dark : preset.primary.light,
                      }}
                    />
                    {{ default: "Default", brutalist: "vivid", "soft-pop": "Soft", tangerine: "Warm orange" }[preset.value]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow title="Font" htmlFor="appearance-font">
          <Select value={font} onValueChange={onFontChange}>
            <SelectTrigger id="appearance-font" size="sm" className="w-full text-xs">
              <SelectValue placeholder="Select font" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {fontOptions.map((font) => (
                  <SelectItem key={font.key} className="text-xs" value={font.key}>
                    {font.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>

        <SettingsRow title="Display mode">
          <ToggleGroup
            size="sm"
            spacing={0}
            variant="outline"
            type="single"
            value={themeMode}
            onValueChange={onThemeModeChange}
          >
            <ToggleGroupItem value="light" aria-label="light color">

              light color
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" aria-label="Dark color">

              Dark color
            </ToggleGroupItem>
            <ToggleGroupItem value="system" aria-label="Follow the system">

              Follow the system
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingsRow>

        <SettingsRow title="Content width">
          <ToggleGroup
            size="sm"
            spacing={0}
            variant="outline"
            type="single"
            value={contentLayout}
            onValueChange={onContentLayoutChange}
          >
            <ToggleGroupItem value="centered" aria-label="Center">

              Center
            </ToggleGroupItem>
            <ToggleGroupItem value="full-width" aria-label="Covered">

              Covered
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingsRow>

        <SettingsRow title="Top bar">
          <ToggleGroup
            size="sm"
            spacing={0}
            variant="outline"
            type="single"
            value={navbarStyle}
            onValueChange={onNavbarStyleChange}
          >
            <ToggleGroupItem value="sticky" aria-label="Fixed">

              Fixed
            </ToggleGroupItem>
            <ToggleGroupItem value="scroll" aria-label="Scroll with the page">

              Scroll with the page
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingsRow>

      <SettingsRow title="Restore default" >
        <Button type="button" size="sm" variant="outline" onClick={handleRestore}>

          Restore default appearance
        </Button>
      </SettingsRow>
    </SettingsSection>
  );
}
