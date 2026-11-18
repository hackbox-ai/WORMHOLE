"use client";

import { SettingsPage } from "@/components/settings-layout";
import { AppearancePreferences } from "../../_components/sidebar/layout-controls";

export default function AppearancePage() {
  return (
    <SettingsPage title="Appearance">
      <AppearancePreferences />
    </SettingsPage>
  );
}
