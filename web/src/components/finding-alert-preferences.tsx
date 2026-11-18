"use client";
import { Volume2 } from "lucide-react";

import { useFindingAlerts } from "@/components/finding-alert-provider";
import { SettingsRow, SettingsSection } from "@/components/settings-layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export function FindingAlertPreferences() {
  const { state, preferences, enableSound, preview, soundReady } = useFindingAlerts();
  return (
    <SettingsSection title="Site reminder">
      <SettingsRow title="New discovery reminder" >
        <Switch checked={state.page} onCheckedChange={(page) => preferences({ page })} aria-label="New discovery page reminder" />
      </SettingsRow>
      <SettingsRow title="Alert sound" description={state.sound && !soundReady ? "Click to listen to activate the sound." : undefined}>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => void preview()}>
            <Volume2 className="size-3.5" />

            Audition
          </Button>
          <Switch checked={state.sound} onCheckedChange={(on) => void enableSound(on)} aria-label="New discovery sound reminder" />
        </div>
      </SettingsRow>
      <SettingsRow title="Volume" htmlFor="finding-alert-volume">
        <input
          id="finding-alert-volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={state.volume}
          onChange={(event) => preferences({ volume: Number(event.target.value) })}
          className="w-40 accent-primary"
        />
      </SettingsRow>
      <SettingsRow title="Ring Level">
        <Select value={state.minSound} onValueChange={(minSound) => preferences({ minSound })}>
          <SelectTrigger className="w-40" aria-label="Ring Level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="medium">Moderately endangered or above</SelectItem>
            <SelectItem value="high">High risk or above</SelectItem>
            <SelectItem value="critical">Critical only</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
    </SettingsSection>
  );
}
